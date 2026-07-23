import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getVerifiedUser } from '../../lib/auth';
import {
  ISO_DATE_PATTERN,
  MAX_CATEGORY_NAME_LENGTH,
  MAX_SECTION_NAME_LENGTH,
  MAX_TRANSACTION_AMOUNT,
  MAX_TRANSACTION_ID_LENGTH,
  SHEET_SCAN_MAX_ROWS,
} from '../../lib/constants';
import { sendError } from '../../lib/errors';
import { LOG_RANGE, LOG_TAB, type LogEntry, parseLogRows } from '../../lib/logtab';
import {
  appendLogEntry,
  assertNotAlreadySaved,
  findMonthTab,
  loadSheetConfig,
  resolveColumns,
  roundAmount,
  SaveFlowError,
  type SheetConfig,
} from '../../lib/saveflow';
import {
  deleteRow,
  findCategoryRow,
  getSheetsForUser,
  listTabInfo,
  readRange,
  readRanges,
  type Sheets,
  SheetsError,
  writeCell,
} from '../../lib/sheets';

// `date` and `status` describe the queue entry being saved: together with
// transactionId and amount they form the composite dedup key (banks reuse one
// id across split transaction lines — see lib/logtab.ts).
const saveSchema = z.object({
  section: z.string().trim().min(1).max(MAX_SECTION_NAME_LENGTH),
  category: z.string().trim().min(1).max(MAX_CATEGORY_NAME_LENGTH),
  amount: z.number().finite().gte(-MAX_TRANSACTION_AMOUNT).lte(MAX_TRANSACTION_AMOUNT),
  transactionId: z.string().trim().min(1).max(MAX_TRANSACTION_ID_LENGTH),
  date: z.string().regex(ISO_DATE_PATTERN, 'date must be YYYY-MM-DD'),
  status: z.enum(['booked', 'pending']),
});

const undoSchema = z.object({
  transactionId: z.string().trim().min(1).max(MAX_TRANSACTION_ID_LENGTH),
});

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    const user = await getVerifiedUser(req);
    if (!user) {
      return sendError(res, 401, 'GOOGLE_TOKEN_EXPIRED', 'Missing or invalid identity token');
    }

    if (req.method === 'POST') {
      return await handleSave(user.userId, req, res);
    }
    if (req.method === 'DELETE') {
      return await handleUndo(user.userId, req, res);
    }
    sendError(res, 405, 'INVALID_REQUEST', 'Unsupported method');
  } catch (err) {
    if (err instanceof SaveFlowError) {
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
async function handleSave(userId: string, req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid body');
  }
  const { section, category, amount, transactionId, date, status } = parsed.data;

  const config = await loadSheetConfig(userId);
  const sheets = await getSheetsForUser(userId);
  const tabs = await listTabInfo(sheets, config.sheetId);
  const monthTab = findMonthTab(tabs).title;

  await assertNotAlreadySaved(sheets, config.sheetId, tabs, { id: transactionId, amount, date });

  const target = await locateActualCell(sheets, config, monthTab, section, category);

  await appendLogEntry(sheets, config.sheetId, {
    transactionId,
    section,
    category,
    amount,
    date,
    status,
  });
  const newActual = roundAmount(target.currentActual + amount);
  await writeCell(sheets, config.sheetId, monthTab, target.cell, newActual);

  res.status(200).json({ tab: monthTab, row: target.row, cell: target.cell, newActual });
}

/**
 * DELETE — undo a save: subtract the logged amount from the Actual cell, then
 * remove the `_log` row so the transaction returns to the queue. Ownership is
 * inherent: the sheet id comes from the verified caller's own config row and
 * is opened with their own stored Google consent.
 */
async function handleUndo(userId: string, req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = undoSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid body');
  }
  const { transactionId } = parsed.data;

  const config = await loadSheetConfig(userId);
  const sheets = await getSheetsForUser(userId);
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
  const monthTab = findMonthTab(tabs).title;
  const target = await locateActualCell(sheets, config, monthTab, entry.section, entry.category);
  const newActual = roundAmount(target.currentActual - entry.amount);
  await writeCell(sheets, config.sheetId, monthTab, target.cell, newActual);
  await deleteRow(sheets, config.sheetId, logTab.tabId, entry.rowNumber);

  res.status(200).json({ tab: monthTab, row: target.row, cell: target.cell, newActual });
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

  // Category and Actual columns in one batchGet. The Actual column is the
  // title disambiguator (task 14): a summary row labeled like a section —
  // Cash flow's "Income" line — has a number beside it, a real box title
  // never does. It also supplies the current cell value without a second
  // read.
  const [column = [], actualColumn = []] = await readRanges(sheets, config.sheetId, monthTab, [
    `${categoryCol}1:${categoryCol}${SHEET_SCAN_MAX_ROWS}`,
    `${actualCol}1:${actualCol}${SHEET_SCAN_MAX_ROWS}`,
  ]);
  const row = findCategoryRow(column, section, category, otherSections, actualColumn);
  if (row === null) {
    throw new SaveFlowError(
      404,
      'CATEGORY_NOT_FOUND',
      `No row for category "${category}" under section "${section}" in tab "${monthTab}"`,
    );
  }

  const cell = `${actualCol}${row}`;
  const actualValue = actualColumn[row - 1]?.[0];
  // A blank Actual cell counts as 0; the cells are plain manually-typed totals.
  const currentActual =
    typeof actualValue === 'number' && Number.isFinite(actualValue) ? actualValue : 0;
  return { row, cell, currentActual };
}

function findLastById(entries: LogEntry[], transactionId: string): LogEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.transactionId === transactionId) {
      return entries[i];
    }
  }
  return undefined;
}
