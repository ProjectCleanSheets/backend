import {
  AMOUNT_DECIMALS,
  COLUMN_LETTER_PATTERN,
  DEFAULT_ACTUAL_COLUMN,
  DEFAULT_BUDGET_COLUMN,
  DEFAULT_CATEGORY_COLUMN,
  DEFAULT_LEFT_COLUMN,
} from './constants';
import type { ErrorCode } from './errors';
import { buildLogMatcher, LOG_HEADER, LOG_RANGE, LOG_TAB, parseLogRows } from './logtab';
import { addHiddenTab, appendRow, readRange, type Sheets, type TabInfo } from './sheets';
import { getSupabase } from './supabase';

// The save pipeline shared by POST /api/sheet/save and POST /api/sheet/category
// (create a category + categorize a transaction in one step). Api files never
// import each other (CLAUDE.md), so every piece both endpoints need lives here;
// both must apply the identical dedup gate and `_log`-first write ordering.

// Carries the exact status + code for failures the flow detects itself, so
// handlers can return them as-is.
export class SaveFlowError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SaveFlowError';
  }
}

export interface SheetConfig {
  sheetId: string;
  columnMapping: Record<
    string,
    { category_col?: string; budget_col?: string; actual_col?: string; left_col?: string }
  >;
}

export async function loadSheetConfig(googleId: string): Promise<SheetConfig> {
  const { data, error } = await getSupabase()
    .from('users')
    .select('sheet_id, column_mapping')
    .eq('google_id', googleId)
    .maybeSingle();
  if (error) {
    throw new SaveFlowError(500, 'SUPABASE_ERROR', 'Could not load user config');
  }
  if (!data?.sheet_id) {
    throw new SaveFlowError(
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
export function findMonthTab(tabs: TabInfo[]): TabInfo {
  const monthName = new Date().toLocaleString('en-US', { month: 'long' });
  const tab = tabs.find((t) => t.title.trim().toLowerCase() === monthName.toLowerCase());
  if (!tab) {
    throw new SaveFlowError(
      404,
      'SHEET_NOT_FOUND',
      `No tab found for the current month ("${monthName}")`,
    );
  }
  return tab;
}

export interface SectionColumns {
  categoryCol: string;
  budgetCol: string | null;
  actualCol: string;
  leftCol: string | null;
  otherSections: string[];
}

/**
 * Resolves the section's columns from the stored mapping. A section without
 * a mapping entry gets the CLAUDE.md default layout (F/G/H/I). With an entry,
 * budget/left resolve only if actually mapped — guessing a default position
 * inside a custom layout could land on a foreign column.
 */
export function resolveColumns(
  mapping: SheetConfig['columnMapping'],
  section: string,
): SectionColumns {
  const wanted = section.trim().toLowerCase();
  const match = Object.entries(mapping).find(([name]) => name.trim().toLowerCase() === wanted);
  const otherSections = Object.keys(mapping).filter((name) => name !== match?.[0]);

  const columns = match
    ? {
        categoryCol: match[1].category_col ?? DEFAULT_CATEGORY_COLUMN,
        budgetCol: match[1].budget_col ?? null,
        actualCol: match[1].actual_col ?? DEFAULT_ACTUAL_COLUMN,
        leftCol: match[1].left_col ?? null,
      }
    : {
        categoryCol: DEFAULT_CATEGORY_COLUMN,
        budgetCol: DEFAULT_BUDGET_COLUMN,
        actualCol: DEFAULT_ACTUAL_COLUMN,
        leftCol: DEFAULT_LEFT_COLUMN,
      };
  // Mapping values were zod-validated on write; re-check before splicing into
  // an A1 range so a corrupt row can never widen a read/write.
  for (const col of Object.values(columns)) {
    if (col !== null && !COLUMN_LETTER_PATTERN.test(col)) {
      throw new SaveFlowError(500, 'SUPABASE_ERROR', 'Stored column mapping is invalid');
    }
  }
  return { ...columns, otherSections };
}

/**
 * Dedup gate (spec §7b): rejects with 409 when the transaction's composite
 * key already sits in `_log` (booked: id+amount+date, pending: id only — see
 * lib/logtab.ts). The hidden tab is created on the very first save. Must run
 * BEFORE any sheet mutation so a duplicate leaves no partial state behind.
 */
export async function assertNotAlreadySaved(
  sheets: Sheets,
  sheetId: string,
  tabs: TabInfo[],
  tx: { id: string; amount: number; date: string },
): Promise<void> {
  if (tabs.some((tab) => tab.title === LOG_TAB)) {
    const entries = parseLogRows(await readRange(sheets, sheetId, LOG_TAB, LOG_RANGE));
    const alreadySaved = buildLogMatcher(entries);
    if (alreadySaved(tx)) {
      throw new SaveFlowError(409, 'INVALID_REQUEST', 'Transaction already saved to the sheet');
    }
  } else {
    await addHiddenTab(sheets, sheetId, LOG_TAB);
    await appendRow(sheets, sheetId, LOG_TAB, [...LOG_HEADER]);
  }
}

export interface SaveEntry {
  transactionId: string;
  section: string;
  category: string;
  amount: number;
  date: string;
  status: 'booked' | 'pending';
}

/**
 * Appends the `_log` dedup row. Must run BEFORE the Actual cell write (spec
 * §7b crash-safety): if the Actual write fails, the log entry blocks a retry
 * from double-counting.
 */
export async function appendLogEntry(
  sheets: Sheets,
  sheetId: string,
  entry: SaveEntry,
): Promise<void> {
  await appendRow(sheets, sheetId, LOG_TAB, [
    entry.transactionId,
    entry.section,
    entry.category,
    entry.amount,
    entry.date,
    entry.status,
    new Date().toISOString(),
  ]);
}

// Currency amounts: keep the read-modify-write result at AMOUNT_DECIMALS so
// float artifacts (195.32000000000001) never land in the sheet.
const AMOUNT_ROUNDING_FACTOR = 10 ** AMOUNT_DECIMALS;

export function roundAmount(value: number): number {
  return Math.round(value * AMOUNT_ROUNDING_FACTOR) / AMOUNT_ROUNDING_FACTOR;
}
