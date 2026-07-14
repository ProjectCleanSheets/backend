import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';
import { OAuth2Client } from 'google-auth-library';
import { loadEncryptionKey } from './crypto';

const verifierClient = new OAuth2Client();

export interface AuthedUser {
  googleId: string;
  email?: string;
}

/**
 * Verifies the `Authorization: Bearer <google_id_token>` header: signature,
 * expiry, and audience must match GOOGLE_CLIENT_ID. Returns null on any
 * failure — identity comes only from the verified token, never from the body.
 */
export async function getVerifiedUser(req: VercelRequest): Promise<AuthedUser | null> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const idToken = header.slice('Bearer '.length).trim();
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
    return { googleId: payload.sub, email: payload.email };
  } catch {
    return null;
  }
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

export function createOAuthState(googleId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: googleId, exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Returns the google_id the state was issued for, or null if invalid/expired. */
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
