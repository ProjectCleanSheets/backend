import { createHmac, createPublicKey, createVerify, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';
import { OAuth2Client } from 'google-auth-library';
import { loadEncryptionKey } from './crypto';
import { getSupabase } from './supabase';

const verifierClient = new OAuth2Client();

export type AuthProvider = 'google' | 'apple';

export interface AuthedUser {
  // Stable internal identity (users.id, a uuid) — the single key every query
  // filters on. Independent of which provider the caller logged in with.
  userId: string;
  provider: AuthProvider;
  // The provider's `sub` claim (Google account id, or Apple's stable user id).
  subject: string;
  email?: string;
}

// Issuers, used both to route an incoming bearer token to the right verifier and
// (re-checked) inside each verifier.
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

/**
 * Verifies the `Authorization: Bearer <identity_token>` header and maps it to a
 * stable internal user. The token may be a Google ID token or an Apple identity
 * token; either way the signature, issuer, audience, and expiry are verified and
 * identity comes only from the verified token — never from the request body.
 *
 * Returns null when there is no valid token (→ 401). On the first authenticated
 * request for a given identity the user row is provisioned, so the returned
 * userId is stable across requests. Database failures throw (→ 500), keeping the
 * "no token" (null) and "backend broke" (throw) cases distinct for callers.
 */
export async function getVerifiedUser(req: VercelRequest): Promise<AuthedUser | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();

  const provider = detectProvider(token);
  let identity: { subject: string; email?: string } | null = null;
  if (provider === 'google') {
    identity = await verifyGoogleToken(token);
  } else if (provider === 'apple') {
    identity = await verifyAppleToken(token);
  }
  if (!provider || !identity) {
    return null;
  }

  const userId = await resolveUserId(provider, identity.subject);
  return { userId, provider, subject: identity.subject, email: identity.email };
}

/**
 * Peeks at the (still unverified) `iss` claim only to pick which verifier to run.
 * The chosen verifier independently re-checks the issuer, so a forged `iss` here
 * cannot bypass verification — at worst it routes to a verifier that rejects it.
 */
function detectProvider(token: string): AuthProvider | null {
  const claims = decodeJwtSegment(token, 1);
  if (!claims) {
    return null;
  }
  if (claims.iss === APPLE_ISSUER) {
    return 'apple';
  }
  if (typeof claims.iss === 'string' && GOOGLE_ISSUERS.includes(claims.iss)) {
    return 'google';
  }
  return null;
}

async function verifyGoogleToken(idToken: string): Promise<{ subject: string; email?: string } | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID is not set');
  }
  try {
    const ticket = await verifierClient.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub) {
      return null;
    }
    return { subject: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

interface AppleJwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
}

// Apple's signing keys rotate rarely; cache the JWKS and refetch on a kid miss.
let appleJwksCache: { keys: AppleJwk[]; fetchedAt: number } | null = null;
const APPLE_JWKS_TTL_MS = 60 * 60 * 1000;

async function appleKeyForKid(kid: string): Promise<AppleJwk | null> {
  const fresh = appleJwksCache && Date.now() - appleJwksCache.fetchedAt < APPLE_JWKS_TTL_MS;
  let key = fresh ? appleJwksCache!.keys.find((k) => k.kid === kid) : undefined;
  if (!key) {
    // Cache miss or possible key rotation — (re)fetch and look again.
    const res = await fetch(APPLE_JWKS_URL);
    if (!res.ok) {
      throw new Error(`Apple JWKS fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { keys: AppleJwk[] };
    appleJwksCache = { keys: body.keys, fetchedAt: Date.now() };
    key = body.keys.find((k) => k.kid === kid);
  }
  return key ?? null;
}

/**
 * Verifies an Apple identity token: RS256 signature against Apple's JWKS, then
 * issuer, audience (APPLE_CLIENT_ID) and expiry. RS256 is hard-required from the
 * header and the key is used only for RSA-SHA256 verification, so there is no
 * `alg: none`/HS256 confusion path. Returns null on any failure.
 */
async function verifyAppleToken(idToken: string): Promise<{ subject: string; email?: string } | null> {
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('APPLE_CLIENT_ID is not set');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeJwtSegment(idToken, 0);
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
    return null;
  }

  const jwk = await appleKeyForKid(header.kid);
  if (!jwk || jwk.kty !== 'RSA') {
    return null;
  }

  const publicKey = createPublicKey({ key: jwk as unknown as object, format: 'jwk' });
  const signatureValid = createVerify('RSA-SHA256')
    .update(`${headerB64}.${payloadB64}`)
    .verify(publicKey, Buffer.from(signatureB64, 'base64url'));
  if (!signatureValid) {
    return null;
  }

  const payload = decodeJwtSegment(idToken, 1);
  if (!payload || payload.iss !== APPLE_ISSUER) {
    return null;
  }
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(clientId)
    : payload.aud === clientId;
  if (!audOk) {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    return null;
  }
  return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
}

// Decodes JWT segment `index` (0 = header, 1 = payload) as JSON without verifying
// anything — used only for routing/claim reads after (or before) verification.
function decodeJwtSegment(token: string, index: number): Record<string, unknown> | null {
  const segment = token.split('.')[index];
  if (!segment) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Maps a verified (provider, subject) to the internal user id, provisioning the
 * row on first sight. The upsert makes concurrent first requests for the same
 * identity converge on a single row instead of racing to insert duplicates.
 */
async function resolveUserId(provider: AuthProvider, subject: string): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('auth_provider', provider)
    .eq('provider_subject', subject)
    .maybeSingle();
  if (error) {
    throw new Error(`user lookup failed: ${error.message}`);
  }
  if (data) {
    return data.id as string;
  }

  const { data: created, error: insertError } = await supabase
    .from('users')
    .upsert(
      { auth_provider: provider, provider_subject: subject, updated_at: new Date().toISOString() },
      { onConflict: 'auth_provider,provider_subject' },
    )
    .select('id')
    .single();
  if (insertError) {
    throw new Error(`user provisioning failed: ${insertError.message}`);
  }
  return created.id as string;
}

// OAuth `state` parameter: HMAC-signed payload binding the consent flow to the
// user who initiated it (CSRF protection). Key is derived from ENCRYPTION_KEY so
// no extra secret is needed.
const STATE_TTL_SECONDS = 600;
// 256-bit key, matching the HMAC-SHA256 block recommendation.
const STATE_HMAC_KEY_BYTES = 32;

function stateHmacKey(): Buffer {
  return Buffer.from(
    hkdfSync('sha256', loadEncryptionKey(), '', 'cleansheets-oauth-state', STATE_HMAC_KEY_BYTES),
  );
}

function sign(payload: string): string {
  return createHmac('sha256', stateHmacKey()).update(payload).digest('base64url');
}

// Binds the consent flow to the internal user id (any provider), not to a Google
// account — Apple users connect Google Sheets too.
export function createOAuthState(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Returns the internal user id the state was issued for, or null if invalid/expired. */
export function verifyOAuthState(state: string): string | null {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) {
    return null;
  }
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number') {
      return null;
    }
    if (parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed.sub;
  } catch {
    return null;
  }
}
