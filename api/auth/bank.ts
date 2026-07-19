import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { createOAuthState, getVerifiedUser, verifyOAuthState } from '../../lib/auth';
import { MS_PER_DAY } from '../../lib/constants';
import { encryptToken } from '../../lib/crypto';
import {
  defaultAspsp,
  EnableBankingError,
  exchangeCode,
  startAuthSession,
} from '../../lib/enablebanking';
import { sendError } from '../../lib/errors';
import { getSupabase } from '../../lib/supabase';

// Deep link the iOS app's ASWebAuthenticationSession listens on.
const APP_CALLBACK = 'cleansheets://oauth/bank';

// Generous cap for ASPSP names as listed by Enable Banking.
const MAX_BANK_NAME_LENGTH = 100;

// A consent close to expiry can be renewed early from iOS Settings; inside this
// window the app shows the renew button ("expiring"), after expiry "expired".
const RENEW_WINDOW_DAYS = 14;

// Bank selection: optional in sandbox (defaults to Mock ASPSP), required in
// production where the app passes the user's bank.
const startQuerySchema = z.object({
  bank: z.string().min(1).max(MAX_BANK_NAME_LENGTH).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, 'country must be a two-letter ISO code like "DK"')
    .optional(),
});

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method === 'GET' && req.query.action === 'callback') {
      return await handleCallback(req, res);
    }
    if (req.method === 'GET' && req.query.action === 'status') {
      return await handleStatus(req, res);
    }
    if (req.method === 'GET') {
      return await startConnect(req, res);
    }
    sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method or action');
  } catch (err) {
    // EnableBankingError carries only status + path + short reason — safe to log, never tokens.
    console.error('auth/bank failed:', err instanceof Error ? err.message : String(err));
    if (err instanceof EnableBankingError) {
      return sendEnableBankingError(res, err);
    }
    sendError(res, 500, 'SUPABASE_ERROR', configHint(err) ?? 'Bank connection failed, please try again');
  }
}

// Our lib helpers throw with exact "X is not set / must be set" messages when
// env config is missing. Those name env vars, never secret values, and are the
// most common failure on a fresh deploy — worth surfacing to the caller.
// Anything else stays in the server log only.
function configHint(err: unknown): string | null {
  if (err instanceof Error && /is not set|must be set|must decode/.test(err.message)) {
    return `Server configuration error: ${err.message}`;
  }
  return null;
}

// Maps Enable Banking failures so the message pinpoints step and cause:
// 401/403 = our app credentials, other 4xx = the request we built (unknown
// bank, expired auth code), 5xx = Enable Banking itself.
function sendEnableBankingError(res: VercelResponse, err: EnableBankingError): void {
  const step = err.path === '/auth' ? 'starting bank authorization' : 'completing bank authorization';
  const cause = err.detail ? `: ${err.detail}` : '';
  if (err.status === 401 || err.status === 403) {
    return sendError(
      res,
      500,
      'SUPABASE_ERROR',
      `Enable Banking rejected the app credentials while ${step} (HTTP ${err.status})${cause} — check ENABLE_BANKING_APP_ID and ENABLE_BANKING_PRIVATE_KEY`,
    );
  }
  if (err.status < 500) {
    return sendError(
      res,
      400,
      'INVALID_REQUEST',
      `Enable Banking rejected ${step} (HTTP ${err.status})${cause}`,
    );
  }
  sendError(
    res,
    502,
    'SUPABASE_ERROR',
    `Enable Banking is unavailable — ${step} failed (HTTP ${err.status}), please try again`,
  );
}

/**
 * GET /api/auth/bank — starts the Enable Banking consent flow and returns the
 * URL the iOS app opens in ASWebAuthenticationSession.
 */
async function startConnect(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await getVerifiedUser(req);
  if (!user) {
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid Google ID token');
  }

  const parsed = startQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid query');
  }

  const fallback = defaultAspsp();
  const name = parsed.data.bank ?? fallback?.name;
  const country = parsed.data.country ?? fallback?.country;
  if (!name || !country) {
    return sendError(
      res,
      400,
      'INVALID_REQUEST',
      'bank and country query parameters are required (there is no default bank outside sandbox)',
    );
  }

  const url = await startAuthSession(createOAuthState(user.googleId), { name, country });
  res.status(200).json({ url });
}

/**
 * GET /auth/bank/callback (rewritten to ?action=callback) — browser redirect
 * from Enable Banking. Validates state (CSRF), exchanges the code for a
 * session, stores it encrypted for the user who initiated the flow.
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
    return sendError(
      res,
      400,
      'INVALID_REQUEST',
      'Invalid or expired state — authorization must finish within 10 minutes, restart the bank connection from the app',
    );
  }

  const session = await exchangeCode(code);

  // Enable Banking issues no refresh token — the session_id is the credential
  // until valid_until, then the user must reconnect (BANK_TOKEN_EXPIRED).
  // .single() fails if the row is missing, i.e. the user never signed in.
  const { error } = await getSupabase()
    .from('users')
    .update({
      bank_access_token: encryptToken(session.sessionId),
      bank_refresh_token: null,
      bank_token_expiry: session.validUntil,
      updated_at: new Date().toISOString(),
    })
    .eq('google_id', googleId)
    .select('google_id')
    .single();
  if (error) {
    // PGRST116 = zero rows matched the update: the user row was never created.
    if (error.code === 'PGRST116') {
      return sendError(
        res,
        500,
        'SUPABASE_ERROR',
        'No user row to attach the bank connection to — sign in via POST /api/auth/google first',
      );
    }
    console.error('auth/bank: storing bank credentials failed:', error.message);
    return sendError(res, 500, 'SUPABASE_ERROR', 'Database write failed while storing bank credentials');
  }

  res.redirect(302, `${APP_CALLBACK}?status=success`);
}

export interface BankStatus {
  status: 'healthy' | 'expiring' | 'expired';
  expiresAt: string | null;
  renewAvailable: boolean;
}

/**
 * Pure status computation, exported for tests. A missing consent (never
 * connected, or no expiry stored) reports as expired — from Settings' point of
 * view the fix is the same: (re)connect the bank.
 */
export function computeBankStatus(expiresAt: string | null, now: number): BankStatus {
  const expiryMs = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  if (Number.isNaN(expiryMs) || expiryMs <= now) {
    return { status: 'expired', expiresAt, renewAvailable: true };
  }
  if (expiryMs - now <= RENEW_WINDOW_DAYS * MS_PER_DAY) {
    return { status: 'expiring', expiresAt, renewAvailable: true };
  }
  return { status: 'healthy', expiresAt, renewAvailable: false };
}

/**
 * GET /api/auth/bank/status (rewritten to ?action=status) — reports the bank
 * consent's health for the iOS Settings screen.
 */
async function handleStatus(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await getVerifiedUser(req);
  if (!user) {
    return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid Google ID token');
  }

  const { data, error } = await getSupabase()
    .from('users')
    .select('bank_access_token, bank_token_expiry')
    .eq('google_id', user.googleId)
    .maybeSingle();
  if (error) {
    console.error('auth/bank: reading bank status failed:', error.message);
    return sendError(res, 500, 'SUPABASE_ERROR', 'Could not read bank connection status');
  }

  // No stored session counts the same as no expiry: the consent is unusable.
  const expiresAt = data?.bank_access_token ? (data.bank_token_expiry as string | null) : null;
  res.status(200).json(computeBankStatus(expiresAt, Date.now()));
}
