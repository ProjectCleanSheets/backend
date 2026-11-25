import { google, sheets_v4 } from 'googleapis';
import { decryptToken } from './crypto';
import type { ErrorCode } from './errors';
import { getSupabase } from './supabase';

export type Sheets = sheets_v4.Sheets;

// The OAuth client type, taken from `google.auth` rather than from
// google-auth-library directly: googleapis-common bundles its own copy of that
// package, and the two OAuth2Client declarations are structurally incompatible
// (private fields), so the top-level one does not typecheck against sheets() or
// drive(). Same reason the constructor below is `google.auth.OAuth2`.
export type GoogleAuthClient = InstanceType<typeof google.auth.OAuth2>;

// What values.get returns per cell with UNFORMATTED_VALUE rendering.
export type CellValue = string | number | boolean;

// Thrown by every helper below, carrying the structured code the API layer
// returns as-is. Messages name the failing step only — never sheet contents,
// tokens, or upstream error bodies.
export class SheetsError extends Error {
  constructor(
    readonly code: Extract<
      ErrorCode,
      'GOOGLE_TOKEN_EXPIRED' | 'SHEET_NOT_FOUND' | 'SHEET_WRITE_FAILED' | 'SUPABASE_ERROR'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'SheetsError';
  }
}

/**
 * Builds an OAuth client authenticated as the given user via their stored
 * encrypted refresh token. google-auth-library mints and refreshes access
 * tokens automatically; a revoked or expired grant surfaces as
 * GOOGLE_TOKEN_EXPIRED on the first API call.
 *
 * Shared with `lib/drive.ts` (task 22) rather than duplicated: this is the one
 * place a refresh token is decrypted, and a second copy of it is the kind of
 * thing that drifts.
 */
export async function getGoogleAuthForUser(userId: string): Promise<GoogleAuthClient> {
  const { data, error } = await getSupabase()
    .from('users')
    .select('google_refresh_token')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    throw new SheetsError('SUPABASE_ERROR', 'Could not load stored Google credentials');
  }
  if (!data?.google_refresh_token) {
    throw new SheetsError(
      'GOOGLE_TOKEN_EXPIRED',
      'No Sheets access on file — complete the Google consent flow first',
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: decryptToken(data.google_refresh_token) });
  return auth;
}

/** The Sheets client for the given user. */
export async function getSheetsForUser(userId: string): Promise<Sheets> {
  return google.sheets({ version: 'v4', auth: await getGoogleAuthForUser(userId) });
}

// Maps a googleapis (GaxiosError-shaped) failure to a SheetsError. Only the
// HTTP status and the OAuth error string are inspected — response bodies are
// never propagated.
function toSheetsError(err: unknown, fallback: SheetsError): SheetsError {
  if (err instanceof SheetsError) {
    return err;
  }
  const shaped = err as {
    message?: unknown;
    response?: { status?: unknown; data?: { error?: unknown } };
  };
  const status = typeof shaped?.response?.status === 'number' ? shaped.response.status : 0;
  const oauthError =
    typeof shaped?.response?.data?.error === 'string' ? shaped.response.data.error : '';
  const message = typeof shaped?.message === 'string' ? shaped.message : '';

  // invalid_grant: the refresh token was revoked or expired — re-consent needed.
  if (oauthError === 'invalid_grant' || message.includes('invalid_grant') || status === 401) {
    return new SheetsError('GOOGLE_TOKEN_EXPIRED', 'Google access expired — sign in with Google again');
  }
  // 403/404: sheet not shared with this account or nonexistent.
  // 400: bad A1 range, which is how the API reports a nonexistent tab.
  if (status === 400 || status === 403 || status === 404) {
    return new SheetsError(
      'SHEET_NOT_FOUND',
      'Sheet or tab not found, or not accessible to this Google account',
    );
  }
  return fallback;
}

// Tab names in A1 notation must be single-quoted; embedded quotes are doubled.
function a1Range(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

export interface TabInfo {
  title: string;
  tabId: number; // numeric sheetId, needed for row-level batchUpdate requests
}

/** Lists the spreadsheet's tabs (title + numeric id) in sheet order. */
export async function listTabInfo(sheets: Sheets, spreadsheetId: string): Promise<TabInfo[]> {
  try {
    const { data } = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties(title,sheetId)',
    });
    const tabs: TabInfo[] = [];
    for (const sheet of data.sheets ?? []) {
      const { title, sheetId } = sheet.properties ?? {};
      if (typeof title === 'string' && typeof sheetId === 'number') {
        tabs.push({ title, tabId: sheetId });
      }
    }
    return tabs;
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_NOT_FOUND', 'Could not open the spreadsheet'));
  }
}

/** Lists the spreadsheet's tab titles in sheet order. */
export async function listTabs(sheets: Sheets, spreadsheetId: string): Promise<string[]> {
  return (await listTabInfo(sheets, spreadsheetId)).map((tab) => tab.title);
}

/**
 * Reads a bounded range from one tab. UNFORMATTED_VALUE returns numbers as
 * numbers (not locale-formatted strings like "3.100"), which both structure
 * detection and read-modify-write rely on. Rows come back ragged: the API
 * omits trailing empty cells.
 */
export async function readRange(
  sheets: Sheets,
  spreadsheetId: string,
  tab: string,
  range: string,
): Promise<CellValue[][]> {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: a1Range(tab, range),
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return (data.values ?? []) as CellValue[][];
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_NOT_FOUND', 'Could not read the sheet tab'));
  }
}

/**
 * Reads several bounded ranges from one tab in a single API call (batchGet).
 * Results come back in request order, one CellValue[][] per range, with the
 * same UNFORMATTED_VALUE + ragged-row semantics as readRange.
 */
export async function readRanges(
  sheets: Sheets,
  spreadsheetId: string,
  tab: string,
  ranges: string[],
): Promise<CellValue[][][]> {
  try {
    const { data } = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ranges.map((range) => a1Range(tab, range)),
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return (data.valueRanges ?? []).map((vr) => (vr.values ?? []) as CellValue[][]);
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_NOT_FOUND', 'Could not read the sheet tab'));
  }
}

/**
 * Writes one literal value to one cell. RAW input keeps the value verbatim —
 * user-supplied text can never be interpreted as a formula.
 */
export async function writeCell(
  sheets: Sheets,
  spreadsheetId: string,
  tab: string,
  cell: string,
  value: string | number,
): Promise<void> {
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: a1Range(tab, cell),
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_WRITE_FAILED', 'Could not write to the sheet'));
  }
}

/**
 * Appends one row after the tab's last row with data. RAW input keeps values
 * verbatim — user-supplied text can never be interpreted as a formula.
 */
export async function appendRow(
  sheets: Sheets,
  spreadsheetId: string,
  tab: string,
  values: (string | number)[],
): Promise<void> {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: a1Range(tab, 'A1'),
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_WRITE_FAILED', 'Could not append to the sheet'));
  }
}

/** Creates a hidden tab (spec §7b: the `_log` audit tab) and returns its numeric id. */
export async function addHiddenTab(
  sheets: Sheets,
  spreadsheetId: string,
  title: string,
): Promise<number> {
  try {
    const { data } = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title, hidden: true } } }] },
    });
    const tabId = data.replies?.[0]?.addSheet?.properties?.sheetId;
    if (typeof tabId !== 'number') {
      throw new SheetsError('SHEET_WRITE_FAILED', 'Could not create the tab');
    }
    return tabId;
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_WRITE_FAILED', 'Could not create the tab'));
  }
}

/** Deletes one row (1-based) from the tab with the given numeric id. */
export async function deleteRow(
  sheets: Sheets,
  spreadsheetId: string,
  tabId: number,
  rowNumber: number,
): Promise<void> {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: tabId,
                dimension: 'ROWS',
                startIndex: rowNumber - 1,
                endIndex: rowNumber,
              },
            },
          },
        ],
      },
    });
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_WRITE_FAILED', 'Could not update the sheet'));
  }
}

export interface TabGrid {
  title: string;
  tabId: number;
  /** Cell contents as typed: formulas as text ("=SUM(G13:G28)"), plain values as values. */
  cells: CellValue[][];
  /** Formatted values (what the user sees), used to spot error results like #REF!. */
  shown: CellValue[][];
  merges: sheets_v4.Schema$GridRange[];
}

/**
 * Every tab except the hidden `_log`, with its formulas, shown values and merges:
 * the snapshot a structural edit is planned and checked against. Three API calls.
 */
export async function readWorkbook(
  sheets: Sheets,
  spreadsheetId: string,
  skipTabs: string[],
): Promise<{ tabs: TabGrid[]; namedRangeTabIds: number[] }> {
  try {
    const { data } = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'namedRanges(range(sheetId)),sheets(properties(title,sheetId),merges)',
    });
    const meta = (data.sheets ?? [])
      .map((s) => ({ title: s.properties?.title, tabId: s.properties?.sheetId, merges: s.merges ?? [] }))
      .filter(
        (s): s is { title: string; tabId: number; merges: sheets_v4.Schema$GridRange[] } =>
          typeof s.title === 'string' && typeof s.tabId === 'number' && !skipTabs.includes(s.title),
      );
    const ranges = meta.map((s) => `'${s.title.replace(/'/g, "''")}'`);
    const [formulas, shown] = await Promise.all(
      (['FORMULA', 'FORMATTED_VALUE'] as const).map((valueRenderOption) =>
        sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges, valueRenderOption }),
      ),
    );
    const tabs = meta.map((s, i) => ({
      ...s,
      cells: (formulas!.data.valueRanges?.[i]?.values ?? []) as CellValue[][],
      shown: (shown!.data.valueRanges?.[i]?.values ?? []) as CellValue[][],
    }));
    const namedRangeTabIds = (data.namedRanges ?? [])
      .map((n) => n.range?.sheetId ?? 0)
      .filter((id): id is number => typeof id === 'number');
    return { tabs, namedRangeTabIds };
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_NOT_FOUND', 'Could not read the spreadsheet'));
  }
}

/** Applies structural requests in one batchUpdate: Sheets applies all of them or none. */
export async function batchUpdate(
  sheets: Sheets,
  spreadsheetId: string,
  requests: sheets_v4.Schema$Request[],
): Promise<void> {
  try {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_WRITE_FAILED', 'Could not update the sheet'));
  }
}
