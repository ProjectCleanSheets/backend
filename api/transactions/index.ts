import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getVerifiedUser } from '../../lib/auth';
import { decryptToken } from '../../lib/crypto';
import {
  type EbTransaction,
  EnableBankingError,
  fetchAccountTransactions,
  getSession,
} from '../../lib/enablebanking';
import { type ErrorCode, sendError } from '../../lib/errors';
import { getSheetsForUser, listTabs, readRange, SheetsError } from '../../lib/sheets';
import { getSupabase } from '../../lib/supabase';

// How far back the queue looks. PSD2 banks serve at least 90 days without
// re-authentication; 30 days comfortably covers "transactions since I last
// opened the app" for the MVP.
const FETCH_WINDOW_DAYS = 30;

// Dedup source of truth (product spec §7b): task 05 appends one row per saved
// transaction with the transactionId in column A. Reading from row 1 keeps a
// possible header row harmless — it can never equal a real transaction id.
const LOG_TAB = '_log';
const LOG_ID_RANGE = 'A1:A10000';

interface QueueTransaction {
  id: string;
  merchant: string;
  amount: number; // always positive — direction carries the sign
  currency: string;
  date: string;
  direction: 'debit' | 'credit';
}

// Carries the exact status + code for failures the endpoint detects itself
// (missing/expired consent, missing config) so the handler can return them as-is.
class TransactionsError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TransactionsError';
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method !== 'GET') {
      return sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
    }
    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid Google ID token');
    }

    res.status(200).json(await fetchUncategorized(user.googleId));
  } catch (err) {
    if (err instanceof TransactionsError) {
      return sendError(res, err.status, err.code, err.message);
    }
    if (err instanceof SheetsError) {
      const status =
        err.code === 'GOOGLE_TOKEN_EXPIRED' ? 401 : err.code === 'SHEET_NOT_FOUND' ? 404 : 500;
      return sendError(res, status, err.code, err.message);
    }
    if (err instanceof EnableBankingError) {
      return sendEnableBankingError(res, err);
    }
    // EnableBankingError and SheetsError are sanitized by design; anything else
    // is internal — log the message only, never transaction data or tokens.
    console.error('transactions failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Could not fetch transactions');
  }
}

// Enable Banking failure mapping for the read path: 401 means our app JWT was
// rejected (credential config), 403/404 mean the session no longer grants
// access — the consent expired or was revoked at the bank, so the user must
// reconnect. Sessions cannot be refreshed (see lib/enablebanking.ts).
function sendEnableBankingError(res: VercelResponse, err: EnableBankingError): void {
  const cause = err.detail ? `: ${err.detail}` : '';
  if (err.status === 403 || err.status === 404) {
    return sendError(
      res,
      401,
      'BANK_TOKEN_EXPIRED',
      'Bank consent has expired or was revoked — reconnect your bank',
    );
  }
  if (err.status === 401) {
    return sendError(
      res,
      500,
      'SUPABASE_ERROR',
      `Enable Banking rejected the app credentials (HTTP 401)${cause} — check ENABLE_BANKING_APP_ID and ENABLE_BANKING_PRIVATE_KEY`,
    );
  }
  sendError(
    res,
    502,
    'SUPABASE_ERROR',
    `Enable Banking is unavailable — fetching transactions failed (HTTP ${err.status}), please try again`,
  );
}

// Exported so the fetch/filter pipeline can be exercised directly; Vercel only
// routes the default export.
export async function fetchUncategorized(
  googleId: string,
): Promise<{ transactions: QueueTransaction[]; logTabMissing: boolean }> {
  const { data, error } = await getSupabase()
    .from('users')
    .select('sheet_id, bank_access_token, bank_token_expiry')
    .eq('google_id', googleId)
    .maybeSingle();
  if (error) {
    throw new TransactionsError(500, 'SUPABASE_ERROR', 'Could not load stored bank credentials');
  }
  if (!data?.bank_access_token) {
    throw new TransactionsError(
      401,
      'BANK_TOKEN_EXPIRED',
      'No bank connection on file — connect your bank first',
    );
  }
  // Enable Banking sessions cannot be refreshed — expired consent always means
  // the user must re-run the connect flow.
  if (!data.bank_token_expiry || new Date(data.bank_token_expiry).getTime() <= Date.now()) {
    throw new TransactionsError(
      401,
      'BANK_TOKEN_EXPIRED',
      'Bank consent has expired — reconnect your bank',
    );
  }
  if (!data.sheet_id) {
    throw new TransactionsError(
      404,
      'SHEET_NOT_FOUND',
      'No sheet configured — save your sheet via POST /api/user/config first',
    );
  }

  const session = await getSession(decryptToken(data.bank_access_token));
  if (session.status !== 'AUTHORIZED') {
    throw new TransactionsError(
      401,
      'BANK_TOKEN_EXPIRED',
      'Bank consent is no longer active — reconnect your bank',
    );
  }

  const dateFrom = new Date(Date.now() - FETCH_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const fetched: EbTransaction[] = [];
  for (const accountUid of session.accounts) {
    fetched.push(...(await fetchAccountTransactions(accountUid, dateFrom)));
  }

  const { loggedIds, logTabMissing } = await readLoggedIds(googleId, data.sheet_id);

  const transactions = fetched
    .map(toQueueTransaction)
    .filter((tx): tx is QueueTransaction => tx !== null && !loggedIds.has(tx.id))
    .sort((a, b) => b.date.localeCompare(a.date));

  return { transactions, logTabMissing };
}

// Reads the transactionIds already saved to the sheet. A missing _log tab is
// not an error: nothing has been saved yet (or the user deleted it) — return
// logTabMissing so the app can warn (spec §7b). The sheet is opened with the
// caller's own stored Google consent, so ownership is enforced by access.
async function readLoggedIds(
  googleId: string,
  sheetId: string,
): Promise<{ loggedIds: Set<string>; logTabMissing: boolean }> {
  const sheets = await getSheetsForUser(googleId);
  const tabs = await listTabs(sheets, sheetId);
  if (!tabs.includes(LOG_TAB)) {
    return { loggedIds: new Set(), logTabMissing: true };
  }

  const loggedIds = new Set<string>();
  for (const row of await readRange(sheets, sheetId, LOG_TAB, LOG_ID_RANGE)) {
    const id = row[0];
    // UNFORMATTED_VALUE returns purely numeric ids as numbers.
    if (typeof id === 'string' && id.trim() !== '') {
      loggedIds.add(id.trim());
    } else if (typeof id === 'number') {
      loggedIds.add(String(id));
    }
  }
  return { loggedIds, logTabMissing: false };
}

/**
 * Maps an Enable Banking transaction to the queue shape, or null for entries
 * the queue cannot use: only booked (BOOK) transactions have settled,
 * bank-assigned ids — pending ones may be reissued under a different id
 * (spec §7b), which would break dedup. Exported so the mapping can be
 * exercised directly; Vercel only routes the default export.
 */
export function toQueueTransaction(tx: EbTransaction): QueueTransaction | null {
  if (tx.status !== 'BOOK') {
    return null;
  }
  const id = tx.entry_reference || tx.transaction_id;
  if (!id) {
    return null;
  }
  const amount = Number(tx.transaction_amount?.amount);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const direction = tx.credit_debit_indicator === 'CRDT' ? 'credit' : 'debit';
  // The counterparty is the merchant: money flows to the creditor on a debit,
  // from the debtor on a credit.
  const counterparty = direction === 'debit' ? tx.creditor?.name : tx.debtor?.name;
  const remittance = tx.remittance_information?.find(
    (line): line is string => typeof line === 'string' && line.trim() !== '',
  );

  return {
    id,
    merchant: counterparty?.trim() || remittance?.trim() || 'Unknown',
    amount: Math.abs(amount),
    currency: tx.transaction_amount?.currency ?? '',
    date: tx.booking_date ?? tx.transaction_date ?? tx.value_date ?? '',
    direction,
  };
}
