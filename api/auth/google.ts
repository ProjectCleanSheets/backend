import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OAuth2Client } from 'google-auth-library';
import { createOAuthState, getVerifiedUser, verifyOAuthState } from '../../lib/auth';
import { encryptToken } from '../../lib/crypto';
import { sendError } from '../../lib/errors';
import { getSupabase } from '../../lib/supabase';

// Registered on the CleanSheets Backend OAuth client (see CLAUDE.md).
// vercel.json rewrites /auth/google/callback → /api/auth/google?action=callback
const REDIRECT_URI = 'https://backend-beryl-phi-32.vercel.app/auth/google/callback';
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
 * Verifies the ID token and creates the user row if it does not exist yet.
 */
async function signIn(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await getVerifiedUser(req);
  if (!user) {
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid Google ID token');
  }

  const supabase = getSupabase();
  const { error: upsertError } = await supabase
    .from('users')
    .upsert({ google_id: user.googleId, updated_at: new Date().toISOString() }, { onConflict: 'google_id' });
  if (upsertError) {
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not create or load user');
  }

  const { data, error } = await supabase
    .from('users')
    .select('sheet_id, google_refresh_token')
    .eq('google_id', user.googleId)
    .single();
  if (error) {
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not load user');
  }

  res.status(200).json({
    googleId: user.googleId,
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
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid Google ID token');
  }

  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh token even on repeat consent
    scope: OAUTH_SCOPES,
    state: createOAuthState(user.googleId),
    login_hint: user.email,
  });
  res.status(200).json({ url });
}

/**
 * GET /auth/google/callback (rewritten to ?action=callback) — browser redirect
 * from Google. Validates state (CSRF), exchanges the code, verifies the granting
 * account matches the user who initiated, stores the encrypted refresh token.
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

  const googleId = verifyOAuthState(state);
  if (!googleId) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Invalid or expired state');
  }

  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token || !tokens.refresh_token) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Google did not return the expected tokens');
  }

  // The account that granted consent must be the account that started the flow.
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  if (ticket.getPayload()?.sub !== googleId) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Consent granted by a different account');
  }

  const { error } = await getSupabase()
    .from('users')
    .update({
      google_refresh_token: encryptToken(tokens.refresh_token),
      updated_at: new Date().toISOString(),
    })
    .eq('google_id', googleId);
  if (error) {
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not store Google credentials');
  }

  res.redirect(302, `${APP_CALLBACK}?status=success`);
}
