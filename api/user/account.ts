import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getVerifiedUser } from '../../lib/auth';
import { decryptToken } from '../../lib/crypto';
import { deleteSession } from '../../lib/enablebanking';
import { sendError } from '../../lib/errors';
import { getSupabase } from '../../lib/supabase';

// App Store Review Guideline 5.1.1(v): the app must let a user delete their
// account and data from inside the app. This endpoint removes everything the
// backend stores for the verified caller — their users row and any in-flight
// pending grants — and best-effort-revokes the external grants those tokens
// represent. Identity comes ONLY from the verified token (getVerifiedUser); no
// user id is ever read from the request (Security Requirements in CLAUDE.md).

// Deliberate product decision (task 18): we do NOT touch the user's Google Sheet
// (including the hidden _log tab). It is their own document — we only delete the
// data *we* store. Surfaced in the response so it reads as intentional.
const SHEET_UNTOUCHED_NOTE =
  'Your Google Sheet (including its _log tab) was left untouched — it is your own document. Only the data CleanSheets stored on our servers was deleted.';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method !== 'DELETE') {
      return sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
    }

    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid access token');
    }

    const supabase = getSupabase();

    // Load the stored tokens (if any) so we can best-effort revoke the external
    // grants before deleting the row. A missing row (already deleted) is fine —
    // deletion is idempotent, so we still sweep the pending tables and return 200.
    const { data: existing, error: loadError } = await supabase
      .from('users')
      .select('google_refresh_token, bank_access_token')
      .eq('id', user.userId)
      .maybeSingle();
    if (loadError) {
      console.error('user/account: loading user failed:', loadError.message);
      return sendError(res, 500, 'SUPABASE_ERROR', 'Could not delete account');
    }

    if (existing) {
      // Best-effort: a revocation failure is logged but must not fail deletion.
      await revokeGoogle(existing.google_refresh_token as string | null);
      await revokeBank(existing.bank_access_token as string | null);
    }

    // Remove everything we store for this user. Every delete filters by the
    // verified internal user id — never anything from the request — so only the
    // caller's own rows are affected. Pending grants and sessions first, then the
    // users row. Dropping the sessions (task 19) revokes every device's refresh
    // token; the caller's own access token still verifies until it expires (≤ 1 h)
    // but has nothing left to reach.
    const swept =
      (await deleteOwned('bank_pending_sessions', 'initiator_user_id', user.userId)) &&
      (await deleteOwned('google_pending_grants', 'initiator_user_id', user.userId)) &&
      (await deleteOwned('user_sessions', 'user_id', user.userId)) &&
      (await deleteOwned('users', 'id', user.userId));
    if (!swept) {
      return sendError(res, 500, 'SUPABASE_ERROR', 'Could not delete account');
    }

    res.status(200).json({ deleted: true, note: SHEET_UNTOUCHED_NOTE });
  } catch (err) {
    console.error('user/account failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Could not delete account');
  }
}

/** Deletes the caller's rows from one table; logs and reports failure (never throws). */
async function deleteOwned(table: string, column: string, userId: string): Promise<boolean> {
  const { error } = await getSupabase().from(table).delete().eq(column, userId);
  if (error) {
    console.error(`user/account: deleting from ${table} failed:`, error.message);
    return false;
  }
  return true;
}

/**
 * Best-effort revocation of the stored Google refresh token via Google's OAuth
 * revoke endpoint. Already-revoked/expired tokens return 400 — there is nothing
 * left to do, so any non-2xx is logged and ignored. The stored value is
 * AES-256-GCM ciphertext; decrypt just to POST it, never log the plaintext.
 */
async function revokeGoogle(encrypted: string | null): Promise<void> {
  if (!encrypted) {
    return;
  }
  try {
    const refreshToken = decryptToken(encrypted);
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    if (!response.ok) {
      console.error(`user/account: Google token revoke returned HTTP ${response.status}`);
    }
  } catch (err) {
    console.error(
      'user/account: Google token revoke failed:',
      err instanceof Error ? err.message : 'unknown error',
    );
  }
}

/**
 * Best-effort revocation of the stored Enable Banking session (DELETE
 * /sessions/{id}). An expired/unknown session just errors — logged and ignored.
 * EnableBankingError carries only status/path/short reason, never the session id.
 */
async function revokeBank(encrypted: string | null): Promise<void> {
  if (!encrypted) {
    return;
  }
  try {
    await deleteSession(decryptToken(encrypted));
  } catch (err) {
    console.error(
      'user/account: bank session revoke failed:',
      err instanceof Error ? err.message : 'unknown error',
    );
  }
}
