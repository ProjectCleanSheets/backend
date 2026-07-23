import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OAuth2Client } from 'google-auth-library';
import { createOAuthState, getVerifiedUser, verifyOAuthState } from '../../lib/auth';
import { encryptToken } from '../../lib/crypto';
import { sendError } from '../../lib/errors';
import { getSupabase } from '../../lib/supabase';

// Must be registered on the CleanSheets Backend OAuth client (see CLAUDE.md).
// vercel.json rewrites /auth/google/callback → /api/auth/google?action=callback
// Locally, GOOGLE_REDIRECT_URI points at localhost so the flow round-trips in dev.
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ?? 'https://backend-beryl-phi-32.vercel.app/auth/google/callback';
// Deep link the iOS app's ASWebAuthenticationSession listens on.
const APP_CALLBACK = 'cleansheets://oauth/google';
// Sheets scope: the stored refresh token must be able to call the Sheets API (task 03).
const OAUTH_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets'];

function oauthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }
  return new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method === 'POST') {
      return await signIn(req, res);
    }
    if (req.method === 'GET' && req.query.action === 'start') {
      return await startOAuth(req, res);
    }
    if (req.method === 'GET' && req.query.action === 'callback') {
      return await handleCallback(req, res);
    }
    sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method or action');
  } catch (err) {
    console.error('auth/google failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Sign in failed, please try again');
  }
}

/**
 * POST /api/auth/google — called by the iOS app after native Google Sign-In.
 * getVerifiedUser verifies the ID token and provisions the user row on first
 * sight, so this just reports the caller's setup state.
 */
async function signIn(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await getVerifiedUser(req);
  if (!user) {
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid identity token');
  }

  const { data, error } = await getSupabase()
    .from('users')
    .select('sheet_id, google_refresh_token')
    .eq('id', user.userId)
    .single();
  if (error) {
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not load user');
  }

  res.status(200).json({
    userId: user.userId,
    provider: user.provider,
    hasConfig: data.sheet_id !== null,
    hasSheetsAccess: data.google_refresh_token !== null,
  });
}

/**
 * GET /api/auth/google?action=start — returns the consent URL that grants the
 * backend a refresh token with Sheets scope. The iOS app opens it in
 * ASWebAuthenticationSession.
 */
async function startOAuth(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await getVerifiedUser(req);
  if (!user) {
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid identity token');
  }

  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh token even on repeat consent
    scope: OAUTH_SCOPES,
    state: createOAuthState(user.userId),
    login_hint: user.email,
  });
  res.status(200).json({ url });
}

/**
 * GET /auth/google/callback (rewritten to ?action=callback) — browser redirect
 * from Google. Validates state (CSRF), exchanges the code, and stores the
 * encrypted refresh token on the user who started the flow.
 *
 * Identity is provider-agnostic (task 16): a user (Google OR Apple login) may
 * connect any Google account for Sheets access, so the granting account need not
 * equal the login account. The account is bound via the signed `state` — the
 * same CSRF-bound-to-initiator model the flow already used.
 */
async function handleCallback(req: VercelRequest, res: VercelResponse): Promise<void> {
  const { code, state, error: consentError } = req.query;
  if (typeof consentError === 'string') {
    res.redirect(302, `${APP_CALLBACK}?status=denied`);
    return;
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    return sendError(res, 400, 'INVALID_REQUEST', 'Missing code or state');
  }

  const userId = verifyOAuthState(state);
  if (!userId) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Invalid or expired state');
  }

  const { tokens } = await oauthClient().getToken(code);
  if (!tokens.refresh_token) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Google did not return a refresh token');
  }

  const { error } = await getSupabase()
    .from('users')
    .update({
      google_refresh_token: encryptToken(tokens.refresh_token),
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);
  if (error) {
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not store Google credentials');
  }

  res.redirect(302, `${APP_CALLBACK}?status=success`);
}
