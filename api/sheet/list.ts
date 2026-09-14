import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getVerifiedUser } from '../../lib/auth';
import { getAccountEmail, getDriveForUser, listSpreadsheets } from '../../lib/drive';
import { sendError } from '../../lib/errors';
import { SheetsError } from '../../lib/sheets';

/**
 * GET /api/sheet/list — the spreadsheets the caller's connected Google account
 * can open, newest first, plus that account's e-mail.
 *
 * Feeds the app's onboarding sheet picker (app task 11): without it the only way
 * to name a spreadsheet is pasting its URL, which means leaving the app. Takes no
 * parameters — the Drive is whichever one the stored consent belongs to, so
 * there is nothing for a caller to point somewhere else.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method !== 'GET') {
      return sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
    }
    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid access token');
    }

    const drive = await getDriveForUser(user.userId);
    // One round trip each, in parallel: the picker needs both before it can draw,
    // and the account e-mail is the screen's "which Google account is this?" line.
    const [account, sheets] = await Promise.all([getAccountEmail(drive), listSpreadsheets(drive)]);

    res.status(200).json({ account, sheets });
  } catch (err) {
    if (err instanceof SheetsError) {
      // Drive's errors reach here already mapped (lib/drive.ts): a missing or
      // scope-less grant is GOOGLE_TOKEN_EXPIRED at 401, so the app re-runs the
      // Google consent instead of showing a dead end.
      const status = err.code === 'GOOGLE_TOKEN_EXPIRED' ? 401 : 500;
      return sendError(res, status, err.code, err.message);
    }
    console.error('sheet/list failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Could not list your spreadsheets');
  }
}
