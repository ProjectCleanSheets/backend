import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthProvider } from './auth';
import { MS_PER_DAY } from './constants';
import { loadEncryptionKey } from './crypto';
import { getSupabase } from './supabase';

// Backend-issued session tokens (task 19). The provider identity token (Google ID
// token / Apple identity token) is verified once, at sign-in, and exchanged for
// this pair — every other request carries the backend's own access token.
//
// Why: an Apple identity token expires in ~10 minutes and CANNOT be refreshed
// on-device, so re-verifying it per request logs Sign-in-with-Apple users out
// constantly. Owning the session also decouples the app from each provider's
// expiry semantics: one refresh path for both.
//
//  - Access token — short-lived, stateless, HS256. Verification is a local HMAC
//    check, so the per-request provider round-trip AND the per-request database
//    lookup both disappear. The cost of statelessness: an issued access token
//    stays valid until its `exp` (≤ 1 h) even if the account is deleted meanwhile.
//    That is harmless — deletion removes every row the token could reach, and a
//    re-registered account gets a brand-new uuid, so a `sub` is never reused.
//  - Refresh token — long-lived, opaque, stored only as a SHA-256 hash in
//    `user_sessions` (a database leak yields no usable credential) and single-use:
//    each refresh consumes the presented token and issues a new pair.
//
// Both are signed/derived from ENCRYPTION_KEY — no new secret to manage.

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 60 * MS_PER_DAY;
const REFRESH_TOKEN_BYTES = 32;
// base64url of 32 bytes is 43 chars; a small ceiling keeps the lookup key sane.
export const REFRESH_TOKEN_MAX_LENGTH = 64;

// Claims that identify the token as ours. `typ` guards against a future second
// token type ever being accepted here, even though each key derivation is distinct.
const ACCESS_TOKEN_ISSUER = 'cleansheets-backend';
const ACCESS_TOKEN_TYPE = 'access';
// The one header we ever emit. Verification compares the encoded header against
// this constant, which pins alg to HS256 by construction — there is no algorithm
// to confuse, and no attacker-controlled `alg` is ever read.
const ACCESS_TOKEN_HEADER = base64urlJson({ alg: 'HS256', typ: 'JWT' });

// 256-bit key, matching the HMAC-SHA256 block recommendation. A different HKDF
// `info` from the OAuth state key (lib/auth.ts), so the two can never be swapped.
const SIGNING_KEY_BYTES = 32;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  // Seconds until accessToken expires — the app refreshes before this elapses.
  expiresIn: number;
}

export interface AccessTokenClaims {
  userId: string;
  provider: AuthProvider;
}

function signingKey(): Buffer {
  return Buffer.from(
    hkdfSync('sha256', loadEncryptionKey(), '', 'cleansheets-access-token', SIGNING_KEY_BYTES),
  );
}

function base64urlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(signingInput: string): string {
  return createHmac('sha256', signingKey()).update(signingInput).digest('base64url');
}

function mintAccessToken(userId: string, provider: AuthProvider): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = base64urlJson({
    iss: ACCESS_TOKEN_ISSUER,
    typ: ACCESS_TOKEN_TYPE,
    sub: userId,
    provider,
    iat: issuedAt,
    exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
  });
  const signingInput = `${ACCESS_TOKEN_HEADER}.${payload}`;
  return `${signingInput}.${sign(signingInput)}`;
}

/**
 * Verifies an access token and returns its claims, or null if it is not one of
 * ours (wrong header, bad signature, wrong issuer/type, expired, malformed).
 * Purely local — no database or provider round-trip.
 */
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  if (header !== ACCESS_TOKEN_HEADER) {
    return null;
  }

  const expected = Buffer.from(sign(`${header}.${payload}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  const claims = decodeSegment(payload);
  if (!claims || claims.iss !== ACCESS_TOKEN_ISSUER || claims.typ !== ACCESS_TOKEN_TYPE) {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (typeof claims.sub !== 'string' || !claims.sub) {
    return null;
  }
  if (claims.provider !== 'google' && claims.provider !== 'apple') {
    return null;
  }
  return { userId: claims.sub, provider: claims.provider };
}

// Decodes a base64url JWT segment as JSON. Only ever called after the signature
// has been verified, so the contents are trusted at that point.
function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Only the hash is ever stored or compared; the token itself lives solely in the
// app's keychain.
function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

/**
 * Issues a fresh access + refresh token pair for a user. The refresh token is
 * recorded (hashed) in `user_sessions`; database failures throw, so the caller's
 * handler maps them to a 500 rather than handing out a token that cannot be
 * refreshed later.
 */
export async function issueSession(
  userId: string,
  provider: AuthProvider,
): Promise<SessionTokens> {
  const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const { error } = await getSupabase()
    .from('user_sessions')
    .insert({
      token_hash: hashRefreshToken(refreshToken),
      user_id: userId,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
    });
  if (error) {
    throw new Error(`session creation failed: ${error.message}`);
  }
  return {
    accessToken: mintAccessToken(userId, provider),
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

/**
 * Swaps a refresh token for a new pair (rotation). The presented token is
 * consumed up front, so it is dead even if a later step fails — a replayed or
 * stolen token buys exactly one use, and whichever party loses the race is logged
 * out. Rotation also slides the 60-day window forward, so an actively used
 * session never expires while an abandoned one does.
 *
 * Returns null for every "this session is over" case — unknown, expired, already
 * used, or the account was deleted — deliberately indistinguishable to the
 * client, which reacts the same way to all of them (sign in again).
 */
export async function rotateSession(refreshToken: string): Promise<SessionTokens | null> {
  const supabase = getSupabase();
  const tokenHash = hashRefreshToken(refreshToken);

  const { data: session, error } = await supabase
    .from('user_sessions')
    .select('user_id, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) {
    throw new Error(`session lookup failed: ${error.message}`);
  }
  if (!session) {
    return null;
  }

  await supabase.from('user_sessions').delete().eq('token_hash', tokenHash);

  if (new Date(session.expires_at as string).getTime() <= Date.now()) {
    return null;
  }

  // The provider is re-read from the user row rather than carried in the refresh
  // token; a missing row means the account was deleted, and the session with it.
  const userId = session.user_id as string;
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('auth_provider')
    .eq('id', userId)
    .maybeSingle();
  if (userError) {
    throw new Error(`user lookup failed: ${userError.message}`);
  }
  if (!user) {
    return null;
  }

  return issueSession(userId, user.auth_provider as AuthProvider);
}
