import { drive_v3, google } from 'googleapis';
import { SheetsError, getGoogleAuthForUser } from './sheets';
import { toWholeSecondISO } from './time';

export type Drive = drive_v3.Drive;

/** One spreadsheet as the app's sheet picker needs it (task 22). */
export interface SpreadsheetInfo {
  id: string;
  name: string;
  /** RFC 3339 timestamp; the picker sorts and labels by it. */
  modifiedTime: string;
}

// Only spreadsheets, only live ones. Drive's query language, not a user input —
// nothing from the request reaches it.
const SPREADSHEET_QUERY =
  "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";

// One page, newest first. A budget spreadsheet is one the user touched recently
// by definition, so the first page is the answer for every realistic Drive; the
// picker searches within what it is given rather than paging (task 22 scope).
const MAX_SPREADSHEETS = 100;

/**
 * Builds a Drive client for the given user from the same stored refresh token
 * the Sheets client uses. Reads file *metadata* only — the consent asks for
 * `drive.metadata.readonly`, which cannot read a document's contents.
 */
export async function getDriveForUser(userId: string): Promise<Drive> {
  return google.drive({ version: 'v3', auth: await getGoogleAuthForUser(userId) });
}

/**
 * Lists the account's spreadsheets, most recently modified first.
 *
 * `files.list` returns only files this Google account can already see, so the
 * per-user isolation is the grant itself: there is no id to filter on and no way
 * to ask for someone else's Drive.
 */
export async function listSpreadsheets(drive: Drive): Promise<SpreadsheetInfo[]> {
  try {
    const { data } = await drive.files.list({
      q: SPREADSHEET_QUERY,
      fields: 'files(id,name,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: MAX_SPREADSHEETS,
      spaces: 'drive',
    });
    const sheets: SpreadsheetInfo[] = [];
    for (const file of data.files ?? []) {
      // Drive marks every one of these optional; a file missing any of the three
      // is nothing the picker could show, so it is dropped rather than faked.
      const modifiedTime = toWholeSecondISO(file.modifiedTime);
      if (typeof file.id === 'string' && typeof file.name === 'string' && modifiedTime) {
        sheets.push({ id: file.id, name: file.name, modifiedTime });
      }
    }
    return sheets;
  } catch (err) {
    throw toDriveError(err, 'listing spreadsheets');
  }
}

/**
 * The e-mail of the Google account this consent was granted for — the app shows
 * it on the connect-sheet screen, because the sheet account is decoupled from
 * the login account (task 16): an Apple user connects whichever Google account
 * owns their budget, and "which one did I connect?" is otherwise unanswerable.
 */
export async function getAccountEmail(drive: Drive): Promise<string | null> {
  try {
    const { data } = await drive.about.get({ fields: 'user(emailAddress)' });
    return data.user?.emailAddress ?? null;
  } catch (err) {
    throw toDriveError(err, 'reading the Drive account');
  }
}

// Drive's error reasons, as they appear in `error.errors[].reason` / `status`.
const SCOPE_REASONS = [
  'insufficientPermissions',
  'insufficientScopes',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
];
const DISABLED_REASONS = ['accessNotConfigured', 'SERVICE_DISABLED'];
// Both 403s also carry `status: "PERMISSION_DENIED"`, so the scope case is
// recognised by reason or by Google's own wording, never by the status alone.
const SCOPE_MESSAGE = /insufficient authentication scopes|insufficient permission/i;

/**
 * Maps a Drive (GaxiosError-shaped) failure onto the contract's codes. Two of
 * Drive's 403s mean opposite things, which is why this cannot reuse the Sheets
 * mapper: a *scope* 403 is the user's re-consent to give, while a
 * *service-disabled* 403 is our own deployment fault and must never ask the user
 * to reconnect something that is already connected.
 *
 * Only the status and Google's own machine-readable reason are inspected;
 * upstream messages are never propagated to the client (CLAUDE.md → security).
 */
function toDriveError(err: unknown, step: string): SheetsError {
  if (err instanceof SheetsError) {
    return err;
  }
  const shaped = err as {
    message?: unknown;
    response?: {
      status?: unknown;
      data?: { error?: unknown };
    };
  };
  const status = typeof shaped?.response?.status === 'number' ? shaped.response.status : 0;
  const message = typeof shaped?.message === 'string' ? shaped.message : '';

  // The OAuth endpoints answer `{ error: "invalid_grant" }` (a string); the Drive
  // API answers `{ error: { status, errors: [{ reason }] } }` (an object).
  const data = shaped?.response?.data?.error;
  const oauthError = typeof data === 'string' ? data : '';
  const apiError = (data ?? {}) as {
    status?: unknown;
    errors?: { reason?: unknown }[];
  };
  const reasons = [
    typeof apiError.status === 'string' ? apiError.status : '',
    ...(Array.isArray(apiError.errors)
      ? apiError.errors.map((e) => (typeof e?.reason === 'string' ? e.reason : ''))
      : []),
  ].filter(Boolean);

  if (oauthError === 'invalid_grant' || message.includes('invalid_grant') || status === 401) {
    return new SheetsError(
      'GOOGLE_TOKEN_EXPIRED',
      'Google access expired — reconnect your Google account',
    );
  }
  if (status === 403 && reasons.some((reason) => DISABLED_REASONS.includes(reason))) {
    // Not the user's problem and not fixable by re-consenting: the Drive API is
    // off on the Google project. Logged by name so the fix is one search away.
    console.error(`drive: ${step} failed — the Google Drive API is not enabled on this project`);
    return new SheetsError('SUPABASE_ERROR', 'Could not reach Google Drive, please try again');
  }
  if (
    status === 403 &&
    (reasons.some((reason) => SCOPE_REASONS.includes(reason)) || SCOPE_MESSAGE.test(message))
  ) {
    // The stored refresh token predates the Drive scope (task 22). A grant cannot
    // gain a scope it was never given, so this is a re-consent — the same user
    // action, and therefore the same code, as an expired grant.
    return new SheetsError(
      'GOOGLE_TOKEN_EXPIRED',
      'This Google connection predates Drive access — reconnect your Google account',
    );
  }
  console.error(`drive: ${step} failed with status ${status}${reasons[0] ? ` (${reasons[0]})` : ''}`);
  return new SheetsError('SUPABASE_ERROR', 'Could not read your Google Drive, please try again');
}
