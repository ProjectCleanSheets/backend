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
export async function getSheetsForUser(googleId: string): Promise<Sheets> {
  const { data, error } = await getSupabase()
    .from('users')
    .select('google_refresh_token')
    .eq('google_id', googleId)
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
function a1(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

/** Lists the spreadsheet's tab titles in sheet order. */
export async function listTabs(sheets: Sheets, spreadsheetId: string): Promise<string[]> {
  try {
    const { data } = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.title',
    });
    return (data.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => typeof title === 'string');
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_NOT_FOUND', 'Could not open the spreadsheet'));
  }
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
      range: a1(tab, range),
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return (data.values ?? []) as CellValue[][];
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
      range: a1(tab, cell),
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  } catch (err) {
    throw toSheetsError(err, new SheetsError('SHEET_WRITE_FAILED', 'Could not write to the sheet'));
  }
}
