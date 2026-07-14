import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getVerifiedUser } from '../../lib/auth';
import { type ErrorCode, sendError } from '../../lib/errors';
import {
  buildLogMatcher,
  LOG_HEADER,
  LOG_RANGE,
  LOG_TAB,
  type LogEntry,
  parseLogRows,
} from '../../lib/logtab';
import {
  addHiddenTab,
  appendRow,
  deleteRow,
  findCategoryRow,
  getSheetsForUser,
  listTabInfo,
  readRange,
  type Sheets,
  SheetsError,
  type TabInfo,
  writeCell,
} from '../../lib/sheets';
import { getSupabase } from '../../lib/supabase';

// CLAUDE.md defaults, used when the section has no stored column mapping.
const DEFAULT_CATEGORY_COL = 'F';
const DEFAULT_ACTUAL_COL = 'H';

// Matches the scan depth of sheet structure detection.
const COLUMN_SCAN_ROWS = 300;

// Sane bound for a single budget transaction; sign allowed so a refund can
// reduce the Actual total.
const MAX_AMOUNT = 1_000_000;

// `date` and `status` describe the queue entry being saved: together with
// transactionId and amount they form the composite dedup key (banks reuse one
// id across split transaction lines — see lib/logtab.ts).
const saveSchema = z.object({
  section: z.string().trim().min(1).max(40),
  category: z.string().trim().min(1).max(100),
  amount: z.number().finite().gte(-MAX_AMOUNT).lte(MAX_AMOUNT),
  transactionId: z.string().trim().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  status: z.enum(['booked', 'pending']),
});

const undoSchema = z.object({
  transactionId: z.string().trim().min(1).max(100),
});

// Carries the exact status + code for failures the endpoint detects itself,
// so the handler can return them as-is.
class SaveError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SaveError';
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid Google ID token');
    }

    if (req.method === 'POST') {
      return await handleSave(user.googleId, req, res);
    }
    if (req.method === 'DELETE') {
      return await handleUndo(user.googleId, req, res);
    }
    sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
  } catch (err) {
    if (err instanceof SaveError) {
      return sendError(res, err.status, err.code, err.message);
    }
    if (err instanceof SheetsError) {
      const status =
        err.code === 'GOOGLE_TOKEN_EXPIRED' ? 401 : err.code === 'SHEET_NOT_FOUND' ? 404 : 500;
      return sendError(res, status, err.code, err.message);
    }
    // SheetsError is sanitized by design; anything else is internal — log the
    // message only, never sheet contents or tokens.
    console.error('sheet/save failed:', err instanceof Error ? err.message : 'unknown error');
    sendError(res, 500, 'SUPABASE_ERROR', 'Could not save to the sheet');
  }
}

/**
 * POST — categorize a transaction: add its amount to the section+category
 * Actual cell of the current month tab. The `_log` row is written BEFORE the
 * Actual cell (spec §7b crash-safety): if the Actual write fails, the log
 * entry blocks a retry from double-counting.
 */
async function handleSave(googleId: string, req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid body');
  }
  const { section, category, amount, transactionId, date, status } = parsed.data;

  const config = await loadSheetConfig(googleId);
  const sheets = await getSheetsForUser(googleId);
  const tabs = await listTabInfo(sheets, config.sheetId);
  const monthTab = findMonthTab(tabs);

  // Dedup gate: reject if the composite key already sits in _log. The hidden
  // tab is created on the very first save (spec §7b).
  if (tabs.some((tab) => tab.title === LOG_TAB)) {
    const entries = parseLogRows(await readRange(sheets, config.sheetId, LOG_TAB, LOG_RANGE));
    const alreadySaved = buildLogMatcher(entries);
    if (alreadySaved({ id: transactionId, amount, date })) {
      return sendError(res, 409, 'INVALID_REQUEST', 'Transaction already saved to the sheet');
    }
  } else {
    await addHiddenTab(sheets, config.sheetId, LOG_TAB);
    await appendRow(sheets, config.sheetId, LOG_TAB, [...LOG_HEADER]);
  }

  const target = await locateActualCell(sheets, config, monthTab, section, category);

  await appendRow(sheets, config.sheetId, LOG_TAB, [
    transactionId,
    section,
    category,
    amount,
    date,
    status,
    new Date().toISOString(),
  ]);
  const newActual = round2(target.currentActual + amount);
  await writeCell(sheets, config.sheetId, monthTab, target.cell, newActual);

  res.status(200).json({ tab: monthTab, row: target.row, cell: target.cell, newActual });
}

/**
 * DELETE — undo a save: subtract the logged amount from the Actual cell, then
 * remove the `_log` row so the transaction returns to the queue. Ownership is
 * inherent: the sheet id comes from the verified caller's own config row and
 * is opened with their own stored Google consent.
 */
async function handleUndo(googleId: string, req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = undoSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid body');
  }
  const { transactionId } = parsed.data;

  const config = await loadSheetConfig(googleId);
  const sheets = await getSheetsForUser(googleId);
  const tabs = await listTabInfo(sheets, config.sheetId);
  const logTab = tabs.find((tab) => tab.title === LOG_TAB);
  if (!logTab) {
    return sendError(res, 404, 'INVALID_REQUEST', 'Nothing to undo — no saves recorded yet');
  }

  const entries = parseLogRows(await readRange(sheets, config.sheetId, LOG_TAB, LOG_RANGE));
  // Split transaction lines can share one id; undo follows right after a save
  // (5-second toast), so the newest matching row is the one being undone.
  const entry = findLastById(entries, transactionId);
  if (!entry) {
    return sendError(res, 404, 'INVALID_REQUEST', 'No saved entry found for this transaction');
  }
  if (entry.amount === null || !entry.section || !entry.category) {
    return sendError(res, 409, 'INVALID_REQUEST', 'Saved entry is incomplete and cannot be undone');
  }

  // Task order (undo is immediate, so the month tab is the one saved to):
  // reverse the Actual cell first, then drop the log row.
  const monthTab = findMonthTab(tabs);
  const target = await locateActualCell(sheets, config, monthTab, entry.section, entry.category);
  const newActual = round2(target.currentActual - entry.amount);
  await writeCell(sheets, config.sheetId, monthTab, target.cell, newActual);
  await deleteRow(sheets, config.sheetId, logTab.tabId, entry.rowNumber);

  res.status(200).json({ tab: monthTab, row: target.row, cell: target.cell, newActual });
}

interface SheetConfig {
  sheetId: string;
  columnMapping: Record<string, { category_col?: string; actual_col?: string }>;
}

async function loadSheetConfig(googleId: string): Promise<SheetConfig> {
  const { data, error } = await getSupabase()
    .from('users')
    .select('sheet_id, column_mapping')
    .eq('google_id', googleId)
    .maybeSingle();
  if (error) {
    throw new SaveError(500, 'SUPABASE_ERROR', 'Could not load user config');
  }
  if (!data?.sheet_id) {
    throw new SaveError(
      404,
      'SHEET_NOT_FOUND',
      'No sheet configured — save your sheet via POST /api/user/config first',
    );
  }
  const columnMapping =
    data.column_mapping && typeof data.column_mapping === 'object' ? data.column_mapping : {};
  return { sheetId: data.sheet_id, columnMapping };
}

// The current month tab is matched by English month name (product decision:
// tab detection by month name, e.g. "July").
function findMonthTab(tabs: TabInfo[]): string {
  const monthName = new Date().toLocaleString('en-US', { month: 'long' });
  const tab = tabs.find((t) => t.title.trim().toLowerCase() === monthName.toLowerCase());
  if (!tab) {
    throw new SaveError(
      404,
      'SHEET_NOT_FOUND',
      `No tab found for the current month ("${monthName}")`,
    );
  }
  return tab.title;
}

/**
 * Resolves the section's columns from the stored mapping (CLAUDE.md defaults
 * otherwise), scans the category column for the section+category row, and
 * reads that row's current Actual value. The Left column is never touched.
 */
async function locateActualCell(
  sheets: Sheets,
  config: SheetConfig,
  monthTab: string,
  section: string,
  category: string,
): Promise<{ row: number; cell: string; currentActual: number }> {
  const { categoryCol, actualCol, otherSections } = resolveColumns(config.columnMapping, section);

  const column = await readRange(
    sheets,
    config.sheetId,
    monthTab,
    `${categoryCol}1:${categoryCol}${COLUMN_SCAN_ROWS}`,
  );
  const row = findCategoryRow(column, section, category, otherSections);
  if (row === null) {
    throw new SaveError(
      404,
      'CATEGORY_NOT_FOUND',
      `No row for category "${category}" under section "${section}" in tab "${monthTab}"`,
    );
  }

  const cell = `${actualCol}${row}`;
  const actualValue = (await readRange(sheets, config.sheetId, monthTab, `${cell}:${cell}`))[0]?.[0];
  // A blank Actual cell counts as 0; the cells are plain manually-typed totals.
  const currentActual =
    typeof actualValue === 'number' && Number.isFinite(actualValue) ? actualValue : 0;
  return { row, cell, currentActual };
}

function resolveColumns(
  mapping: SheetConfig['columnMapping'],
  section: string,
): { categoryCol: string; actualCol: string; otherSections: string[] } {
  const wanted = section.trim().toLowerCase();
  const match = Object.entries(mapping).find(([name]) => name.trim().toLowerCase() === wanted);
  const otherSections = Object.keys(mapping).filter((name) => name !== match?.[0]);

  const categoryCol = match?.[1]?.category_col ?? DEFAULT_CATEGORY_COL;
  const actualCol = match?.[1]?.actual_col ?? DEFAULT_ACTUAL_COL;
  // Mapping values were zod-validated on write; re-check before splicing into
  // an A1 range so a corrupt row can never widen a read/write.
  if (!/^[A-Z]{1,2}$/.test(categoryCol) || !/^[A-Z]{1,2}$/.test(actualCol)) {
    throw new SaveError(500, 'SUPABASE_ERROR', 'Stored column mapping is invalid');
  }
  return { categoryCol, actualCol, otherSections };
}

function findLastById(entries: LogEntry[], transactionId: string): LogEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.transactionId === transactionId) {
      return entries[i];
    }
  }
  return undefined;
}

// Currency amounts: keep the read-modify-write result at 2 decimals so float
// artifacts (195.32000000000001) never land in the sheet.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
