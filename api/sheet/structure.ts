import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getVerifiedUser } from '../../lib/auth';
import { MAX_TAB_NAME_LENGTH, SHEET_ID_PATTERN, SHEET_SCAN_MAX_ROWS } from '../../lib/constants';
import { sendError } from '../../lib/errors';
import { detectSections } from '../../lib/sheetlayout';
import { getSheetsForUser, listTabs, readRange, SheetsError } from '../../lib/sheets';

// sheetId comes from the query (not stored config) because this endpoint runs
// during onboarding, before config is saved. Ownership is still enforced: the
// sheet is opened with the caller's own stored token, so only sheets their
// Google account can access will resolve.
const querySchema = z.object({
  sheetId: z.string().regex(SHEET_ID_PATTERN, 'Invalid Google Sheet ID'),
  tab: z.string().min(1).max(MAX_TAB_NAME_LENGTH).optional(),
});

// Budget dashboards are small; one bounded read covers the whole layout and
// keeps the scan to a single Sheets API call. Column Z also bounds every
// index→letter conversion to a single letter.
const SCAN_LAST_COLUMN = 'Z';
const SCAN_RANGE = `A1:${SCAN_LAST_COLUMN}${SHEET_SCAN_MAX_ROWS}`;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method !== 'GET') {
      return sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
    }
    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid access token');
    }

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid query');
    }
    const { sheetId, tab } = parsed.data;

    const sheets = await getSheetsForUser(user.userId);

    if (tab === undefined) {
      res.status(200).json({ tabs: await listTabs(sheets, sheetId) });
      return;
    }

    const grid = await readRange(sheets, sheetId, tab, SCAN_RANGE);
    res.status(200).json({ tab, sections: detectSections(grid) });
  } catch (err) {
    if (err instanceof SheetsError) {
      const status =
        err.code === 'GOOGLE_TOKEN_EXPIRED' ? 401 : err.code === 'SHEET_NOT_FOUND' ? 404 : 500;
      return sendError(res, status, err.code, err.message);
    }
    // lib/sheets sanitizes all Google API failures into SheetsError, so
    // anything reaching here is internal — the message cannot hold sheet data.
    console.error('sheet/structure failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Could not read sheet structure');
  }
}
