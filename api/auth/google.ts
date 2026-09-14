import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { createOAuthState, getVerifiedUser, verifyOAuthState } from '../../lib/auth';
import { encryptToken } from '../../lib/crypto';
import { sendError } from '../../lib/errors';
import {
  consumePendingGrant,
  HANDLE_MAX_LENGTH,
  mintPendingGrant,
} from '../../lib/pendinggrants';
import { getSupabase } from '../../lib/supabase';

// Must be registered on the CleanSheets Backend OAuth client (see CLAUDE.md).
// vercel.json rewrites /auth/google/callback → /api/auth/google?action=callback
// Locally, GOOGLE_REDIRECT_URI points at localhost so the flow round-trips in dev.
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ?? 'https://backend-beryl-phi-32.vercel.app/auth/google/callback';
// Deep link the iOS app's ASWebAuthenticationSession listens on.
const APP_CALLBACK = 'cleansheets://oauth/google';
// Sheets scope: the stored refresh token must be able to call the Sheets API (task 03).
// Drive metadata scope (task 22): `spreadsheets` can read and write a sheet whose id
// you already have, but it cannot *find* one — GET /api/sheet/list needs Drive to
// enumerate the account's spreadsheets for the app's picker. `metadata.readonly` is
// the narrowest scope that can: names and ids, never a document's contents. It is
// Google-"sensitive", so the OAuth app needs verification before public launch —
// test users can grant it today (ledger CR-02).
const OAUTH_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];

const finalizeSchema = z.object({
  handle: z.string().min(1).max(HANDLE_MAX_LENGTH),
});

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
    if (req.method === 'POST' && req.query.action === 'finalize') {
      return await handleFinalize(req, res);
    }
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
 * POST /api/auth/google — the app's "who am I / what's left to set up" call,
 * made after sign-in (POST /api/auth/session, which is where the identity token
 * is verified and the user row provisioned — task 19). Works for Apple logins
 * too, despite the name.
 */
async function signIn(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await getVerifiedUser(req);
  if (!user) {
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid access token');
  }

  const { data, error } = await getSupabase()
    .from('users')
    .select('sheet_id, google_refresh_token')
    .eq('id', user.userId)
    .maybeSingle();
  if (error) {
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not load user');
  }
  // The row is created at sign-in, so a missing one means the account was deleted
  // while this (still unexpired) access token was in flight.
  if (!data) {
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'This account no longer exists — sign in again');
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
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid access token');
  }

  // No login_hint: since task 16 the login account is deliberately decoupled from
  // the Google account that owns the sheet (an Apple user connects whichever
  // Google account they like), so Google's own account chooser is the right
  // affordance — and task 19 stopped carrying the login e-mail per request.
  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh token even on repeat consent
    scope: OAUTH_SCOPES,
    state: createOAuthState(user.userId),
  });
  res.status(200).json({ url });
}

/**
 * GET /auth/google/callback (rewritten to ?action=callback) — browser redirect
 * from Google. Validates state (CSRF), exchanges the code, and parks the
 * encrypted refresh token behind a one-time handle rather than storing it
 * directly (task 17): the state only proves who *started* the flow, and anyone
 * can be phished into completing a Google consent against someone else's state.
 * The app finalizes the handle under its own verified auth
 * (POST /api/auth/google/finalize), so the refresh token can only ever land on
 * the account that both initiated the flow and re-authenticated. Redirects to the
 * app deep link with the handle attached.
 *
 * Identity is provider-agnostic (task 16): a user (Google OR Apple login) may
 * connect any Google account for Sheets access, so the granting account need not
 * equal the login account. Binding to the finalizing caller (not the state)
 * replaces the login==Sheets-account check task 16 had to drop.
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

  // Park the encrypted refresh token behind a random, short-lived handle instead
  // of writing it onto the state's user row; finalize moves the ciphertext across
  // verbatim, so the plaintext refresh token never resurfaces here.
  const minted = await mintPendingGrant('google_pending_grants', userId, {
    refresh_ciphertext: encryptToken(tokens.refresh_token),
  });
  if ('error' in minted) {
    console.error('auth/google: storing pending grant failed:', minted.error);
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not store Google credentials');
  }

  res.redirect(302, `${APP_CALLBACK}?status=success&handle=${encodeURIComponent(minted.handle)}`);
}

/**
 * POST /api/auth/google/finalize (rewritten to ?action=finalize) — the app's
 * authenticated second step. Consumes the one-time handle from the callback deep
 * link and stores the parked Google refresh token on the *verified caller's* row.
 * The handle is single-use (deleted up front) and short-lived, and only the
 * account that started the flow may finalize it — so a consent completed against
 * a different user's flow, or a handle replayed on another device, can never
 * attach Google Sheets access to the wrong account (task 17).
 */
async function handleFinalize(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await getVerifiedUser(req);
  if (!user) {
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid access token');
  }

  const parsed = finalizeSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid body');
  }
  const { handle } = parsed.data;

  // Single-use, initiator-bound consumption is the shared task-15/17 mechanism.
  const result = await consumePendingGrant('google_pending_grants', handle, user.userId, [
    'refresh_ciphertext',
  ]);
  if (!result.ok) {
    switch (result.reason) {
      case 'db_error':
        console.error('auth/google: reading pending grant failed:', result.detail);
        return sendError(res, 500, 'SUPABASE_ERROR', 'Could not complete Google authorization');
      case 'not_found':
        return sendError(
          res,
          404,
          'INVALID_REQUEST',
          'Unknown or already-used Google authorization — restart the Google connection from the app',
        );
      case 'expired':
        return sendError(
          res,
          400,
          'INVALID_REQUEST',
          'Google authorization expired before it was finalized — restart the Google connection from the app',
        );
      case 'wrong_initiator':
        return sendError(res, 403, 'INVALID_REQUEST', 'This Google authorization belongs to a different account');
    }
  }
  const { refresh_ciphertext } = result.payload;

  // Move the ciphertext across as-is — the pending column and users.google_refresh_token
  // both hold AES-256-GCM(refresh token) under the same key, so nothing to re-encrypt.
  const { error: updateError } = await getSupabase()
    .from('users')
    .update({
      google_refresh_token: refresh_ciphertext,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.userId)
    .select('id')
    .single();
  if (updateError) {
    // PGRST116 = zero rows matched: the user row was never created (no sign-in).
    if (updateError.code === 'PGRST116') {
      return sendError(
        res,
        500,
        'SUPABASE_ERROR',
        'No user row to attach Google Sheets access to — sign in via POST /api/auth/google first',
      );
    }
    console.error('auth/google: storing Google credentials failed:', updateError.message);
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not store Google credentials');
  }

  res.status(200).json({ status: 'connected' });
}
