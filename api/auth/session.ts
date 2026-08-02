import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { signInWithIdentityToken } from '../../lib/auth';
import { sendError } from '../../lib/errors';
import { issueSession, REFRESH_TOKEN_MAX_LENGTH, rotateSession } from '../../lib/session';

// Sign-in and session renewal (task 19). Provider-agnostic on purpose: the same
// two endpoints serve Google and Apple logins, because after the exchange the app
// only ever holds backend tokens.
//
// This is the ONLY endpoint that accepts a provider identity token. Every other
// endpoint takes the access token minted here — see lib/session.ts for why (Apple
// identity tokens expire in ~10 minutes and cannot be refreshed on-device).

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(REFRESH_TOKEN_MAX_LENGTH),
});

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method === 'POST' && req.query.action === 'refresh') {
      return await refresh(req, res);
    }
    if (req.method === 'POST') {
      return await exchange(req, res);
    }
    sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method or action');
  } catch (err) {
    console.error('auth/session failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Sign in failed, please try again');
  }
}

/**
 * POST /api/auth/session — the exchange. `Authorization: Bearer <identity_token>`
 * (Google ID token or Apple identity token) is verified once here and traded for
 * a session token pair; the user row is provisioned on first sign-in.
 */
async function exchange(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await signInWithIdentityToken(req);
  if (!user) {
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid identity token');
  }

  const tokens = await issueSession(user.userId, user.provider);
  res.status(200).json({ ...tokens, userId: user.userId, provider: user.provider });
}

/**
 * POST /api/auth/session/refresh (rewritten to ?action=refresh) — swaps a valid
 * refresh token for a fresh pair. Deliberately unauthenticated: the refresh token
 * *is* the credential, and the access token it replaces has usually expired. It
 * is single-use, so the response must be stored — the presented token is dead
 * either way.
 */
async function refresh(req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid body');
  }

  const tokens = await rotateSession(parsed.data.refreshToken);
  if (!tokens) {
    // Unknown, expired, already used, or the account is gone — all the same to the
    // app, and kept indistinguishable so the response reveals nothing about which.
    return sendError(
      res,
      401,
      'SESSION_EXPIRED',
      'Session expired or already refreshed — sign in again',
    );
  }

  res.status(200).json(tokens);
}
