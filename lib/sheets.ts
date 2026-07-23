import { google, sheets_v4 } from 'googleapis';
import { decryptToken } from './crypto';
import type { ErrorCode } from './errors';
import { getSupabase } from './supabase';

export type Sheets = sheets_v4.Sheets;

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
 * Builds a Sheets client authenticated as the given user via their stored
 * encrypted refresh token. google-auth-library mints and refreshes access
 * tokens automatically; a revoked or expired grant surfaces as
 * GOOGLE_TOKEN_EXPIRED on the first API call.
 */
export async function getSheetsForUser(userId: string): Promise<Sheets> {
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
  // googleapis bundles its own google-auth-library; using google.auth.OAuth2
  // keeps the client type compatible with the sheets() options.
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: decryptToken(data.google_refresh_token) });
  return google.sheets({ version: 'v4', auth });
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

const COLUMN_A_CHAR_CODE = 'A'.charCodeAt(0);

/**
 * 0-indexed column number → letter, and back. Both are bounded to single
 * letters (A..Z) — every scan in this codebase stays within column Z, and
 * user-configured two-letter columns are passed through as strings without
 * ever being converted.
 */
export function columnLetter(index: number): string {
  return String.fromCharCode(COLUMN_A_CHAR_CODE + index);
}

export function columnIndex(letter: string): number {
  return letter.charCodeAt(0) - COLUMN_A_CHAR_CODE;
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

// How many blank cells may sit between a section's banner and its first
// category: merged banners surface their value in the top-left cell only, and
// the Budget/Actual header row usually leaves the category column empty.
const HEADER_GAP_ROWS = 4;

function firstCellText(row: CellValue[] | undefined): string {
  const cell = row?.[0];
  return typeof cell === 'string' ? cell.trim() : '';
}

export interface SectionScan {
  /** The box's category rows (1-based, cell text trimmed) in sheet order. */
  categories: { row: number; name: string }[];
  /**
   * First blank row after the last category (1-based) — boxes keep spare
   * formatted rows above their Total, so a new category is written there
   * without moving anything. Null when the box has no free row (Total or the
   * next box's banner sits right below the last category).
   */
  freeRow: number | null;
}

/**
 * Walks the `section` box, given a single-column read of the section's
 * category column (index 0 = row 1). Dashboards stack several boxes in one
 * column (e.g. Bills and Liabilities both anchored in K), so the walk starts
 * at the row whose cell equals the section name and stops at the box's end:
 * a blank cell after categories started, a Total row, or another section's
 * title.
 *
 * `valueColumn` (same tab, the section's Actual column) disambiguates the
 * title row: summary boxes repeat section names as row LABELS with a number
 * beside them (e.g. Cash flow's "Income" line), while a real title row never
 * carries a number in its own value column — it sits beside blank cells
 * (merged banner) or the "Budget"/"Actual" header text. Candidate rows with
 * a numeric value cell are skipped. Callers without a value-column read
 * (task 14) keep the historical first-match behavior.
 */
export function scanSection(
  column: CellValue[][],
  section: string,
  otherSections: string[],
  valueColumn?: CellValue[][],
): SectionScan | null {
  const sectionName = section.trim().toLowerCase();
  const stops = new Set(otherSections.map((name) => name.trim().toLowerCase()));

  const titleIndex = column.findIndex(
    (row, i) =>
      firstCellText(row).toLowerCase() === sectionName &&
      !(valueColumn && typeof valueColumn[i]?.[0] === 'number'),
  );
  if (titleIndex === -1) {
    return null;
  }

  const categories: SectionScan['categories'] = [];
  let freeRow: number | null = null;
  for (let i = titleIndex + 1; i < column.length; i++) {
    const text = firstCellText(column[i]);
    if (!text) {
      if (categories.length > 0) {
        freeRow = i + 1;
        break;
      }
      if (i - titleIndex > HEADER_GAP_ROWS) {
        break;
      }
      continue;
    }
    if (/^total\b/i.test(text)) {
      break;
    }
    const lower = text.toLowerCase();
    if (lower === sectionName || stops.has(lower)) {
      break;
    }
    categories.push({ row: i + 1, name: text });
  }
  return { categories, freeRow };
}

/**
 * Finds the 1-based sheet row holding `category` inside the `section` box —
 * a name lookup over scanSection (same column read, same box bounds,
 * including the `valueColumn` title disambiguation).
 */
export function findCategoryRow(
  column: CellValue[][],
  section: string,
  category: string,
  otherSections: string[],
  valueColumn?: CellValue[][],
): number | null {
  const scan = scanSection(column, section, otherSections, valueColumn);
  if (!scan) {
    return null;
  }
  const target = category.trim().toLowerCase();
  return scan.categories.find((c) => c.name.toLowerCase() === target)?.row ?? null;
}
