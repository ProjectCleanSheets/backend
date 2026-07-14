import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getVerifiedUser } from '../../lib/auth';
import {
  DEFAULT_ACTUAL_COLUMN,
  DEFAULT_BUDGET_COLUMN,
  DEFAULT_CATEGORY_COLUMN,
  DEFAULT_LEFT_COLUMN,
  MAX_TAB_NAME_LENGTH,
  SHEET_ID_PATTERN,
  SHEET_SCAN_MAX_ROWS,
} from '../../lib/constants';
import { sendError } from '../../lib/errors';
import {
  type CellValue,
  columnIndex,
  columnLetter,
  getSheetsForUser,
  listTabs,
  readRange,
  SheetsError,
} from '../../lib/sheets';

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

// Section names the onboarding flow offers (product spec). Used only as a
// fallback when the tab has no Budget/Actual header rows.
const KNOWN_SECTIONS = ['expenses', 'bills', 'income', 'save & invest', 'liabilities'];

// Default layout per CLAUDE.md, as 0-indexed scan columns.
const DEFAULT_CATEGORY_COL = columnIndex(DEFAULT_CATEGORY_COLUMN);
const DEFAULT_BUDGET_COL = columnIndex(DEFAULT_BUDGET_COLUMN);
const DEFAULT_ACTUAL_COL = columnIndex(DEFAULT_ACTUAL_COLUMN);
const DEFAULT_LEFT_COL = columnIndex(DEFAULT_LEFT_COLUMN);

const MAX_SECTIONS = 20;
const MAX_CATEGORIES_PER_SECTION = 100;

// How far a section box's parts may sit apart. Headers: an extra column (like
// Bills' "Due") can push "Actual" away from "Budget", and "Left" is optional.
// Titles: a merged banner surfaces its value up to a few cells above/left of
// the Budget/Actual header pair (see findTitle).
const MAX_COLS_FROM_BUDGET_TO_ACTUAL = 3;
const MAX_COLS_FROM_ACTUAL_TO_LEFT = 2;
const TITLE_MAX_ROWS_ABOVE = 3;
const TITLE_MAX_COLS_LEFT = 3;

interface HeaderPair {
  rowIndex: number;
  name: string;
  categoryCol: number;
  budgetCol: number;
  actualCol: number;
  leftCol: number | null;
}

// Cells that are part of a section's header furniture, never its title.
const HEADER_LABEL = /^(budget|actual|left|due)$/i;

interface DetectedSection {
  name: string;
  columns: { category: string; budget: string; actual: string; left: string | null };
  categories: { name: string; budget: number | null; actual: number | null }[];
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

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid query');
    }
    const { sheetId, tab } = parsed.data;

    const sheets = await getSheetsForUser(user.googleId);

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

function cellText(cell: CellValue | undefined): string {
  return typeof cell === 'string' ? cell.trim() : '';
}

function numberOrNull(cell: CellValue | undefined): number | null {
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
}

/**
 * Finds every "Budget" → "Actual" (optionally "Left") header pair in a row.
 * Dashboards place section boxes side by side, so one row can hold several
 * pairs (e.g. Cash flow's in C/D and Expenses' in G/H/I on the same row).
 */
function findPairsInRow(row: CellValue[]): { budgetCol: number; actualCol: number; leftCol: number | null }[] {
  const pairs: { budgetCol: number; actualCol: number; leftCol: number | null }[] = [];
  for (let budgetCol = 0; budgetCol < row.length; budgetCol++) {
    if (!/^budget$/i.test(cellText(row[budgetCol]))) {
      continue;
    }
    let actualCol = -1;
    for (let candidate = budgetCol + 1; candidate <= budgetCol + MAX_COLS_FROM_BUDGET_TO_ACTUAL; candidate++) {
      if (/^actual$/i.test(cellText(row[candidate]))) {
        actualCol = candidate;
        break;
      }
    }
    if (actualCol === -1) {
      continue;
    }
    let leftCol: number | null = null;
    for (let candidate = actualCol + 1; candidate <= actualCol + MAX_COLS_FROM_ACTUAL_TO_LEFT; candidate++) {
      if (/^left$/i.test(cellText(row[candidate]))) {
        leftCol = candidate;
        break;
      }
    }
    pairs.push({ budgetCol, actualCol, leftCol });
    budgetCol = leftCol ?? actualCol; // resume scanning after this pair
  }
  return pairs;
}

/**
 * Finds the section title for a Budget/Actual pair. The title sits at the
 * box's top-left corner: on the header row itself ("Expenses | Budget |
 * Actual") or 1–3 rows above it when the title is a merged banner (merged
 * cells surface their value in the top-left cell only). Its column is where
 * the category names live — columns like Bills' "Due" can sit between the
 * categories and the Budget column, so the title anchors the category column.
 */
function findTitle(
  grid: CellValue[][],
  rowIndex: number,
  budgetCol: number,
): { name: string; categoryCol: number; titleRowIndex: number } | null {
  for (let titleRow = rowIndex; titleRow >= Math.max(0, rowIndex - TITLE_MAX_ROWS_ABOVE); titleRow--) {
    const row = grid[titleRow] ?? [];
    for (let titleCol = budgetCol - 1; titleCol >= Math.max(0, budgetCol - TITLE_MAX_COLS_LEFT); titleCol--) {
      const text = cellText(row[titleCol]);
      if (text && !HEADER_LABEL.test(text)) {
        return { name: text, categoryCol: titleCol, titleRowIndex: titleRow };
      }
    }
  }
  return null;
}

// Fallback for tabs without Budget/Actual header rows: known section names in
// the default category column, with the default column layout.
function detectKnownNameRows(grid: CellValue[][]): HeaderPair[] {
  const headers: HeaderPair[] = [];
  grid.forEach((row, rowIndex) => {
    const name = cellText(row[DEFAULT_CATEGORY_COL]);
    if (name && KNOWN_SECTIONS.includes(name.toLowerCase())) {
      headers.push({
        rowIndex,
        name,
        categoryCol: DEFAULT_CATEGORY_COL,
        budgetCol: DEFAULT_BUDGET_COL,
        actualCol: DEFAULT_ACTUAL_COL,
        leftCol: DEFAULT_LEFT_COL,
      });
    }
  });
  return headers;
}

// True when the given row holds a header pair whose columns overlap
// [fromCol, toCol] — i.e. the next section box below this one starts here.
// Boxes in *other* column ranges (side-by-side layout) don't end a section.
function overlapsPair(
  pairSpans: Map<number, [number, number][]>,
  rowIndex: number,
  fromCol: number,
  toCol: number,
): boolean {
  const spans = pairSpans.get(rowIndex);
  return spans !== undefined && spans.some(([start, end]) => start <= toCol && fromCol <= end);
}

// Exported so the detection heuristics can be exercised directly; Vercel only
// routes the default export.
export function detectSections(grid: CellValue[][]): DetectedSection[] {
  const headers: HeaderPair[] = [];
  // Every pair's column span per row, including pairs without a resolvable
  // title — used to know where the next box begins.
  const pairSpans = new Map<number, [number, number][]>();
  // Cells holding a detected section's title. A category scan that reaches
  // one has run into the next box's banner (no blank row between boxes).
  const titleCells = new Set<string>();

  grid.forEach((row, rowIndex) => {
    for (const pair of findPairsInRow(row)) {
      const title = findTitle(grid, rowIndex, pair.budgetCol);
      const span: [number, number] = [
        title?.categoryCol ?? pair.budgetCol,
        pair.leftCol ?? pair.actualCol,
      ];
      pairSpans.set(rowIndex, [...(pairSpans.get(rowIndex) ?? []), span]);
      // A pair with no title nearby is not a section (e.g. a stray summary
      // table) — recording its span above is enough.
      if (title && headers.length < MAX_SECTIONS) {
        titleCells.add(`${title.titleRowIndex}:${title.categoryCol}`);
        headers.push({ rowIndex, name: title.name, categoryCol: title.categoryCol, ...pair });
      }
    }
  });

  let detected = headers;
  if (detected.length === 0) {
    detected = detectKnownNameRows(grid).slice(0, MAX_SECTIONS);
    for (const header of detected) {
      pairSpans.set(header.rowIndex, [[header.categoryCol, header.leftCol ?? header.actualCol]]);
    }
  }

  return detected.map((header) => {
    const spanEnd = header.leftCol ?? header.actualCol;
    const categories: DetectedSection['categories'] = [];
    for (
      let rowIndex = header.rowIndex + 1;
      rowIndex < grid.length && categories.length < MAX_CATEGORIES_PER_SECTION;
      rowIndex++
    ) {
      if (
        overlapsPair(pairSpans, rowIndex, header.categoryCol, spanEnd) ||
        titleCells.has(`${rowIndex}:${header.categoryCol}`)
      ) {
        break;
      }
      const row = grid[rowIndex] ?? [];
      const name = cellText(row[header.categoryCol]);
      // A blank category cell or a summary row ends the section.
      if (!name || /^total\b/i.test(name)) {
        break;
      }
      categories.push({
        name,
        budget: numberOrNull(row[header.budgetCol]),
        actual: numberOrNull(row[header.actualCol]),
      });
    }

    return {
      name: header.name,
      columns: {
        category: columnLetter(header.categoryCol),
        budget: columnLetter(header.budgetCol),
        actual: columnLetter(header.actualCol),
        left: header.leftCol === null ? null : columnLetter(header.leftCol),
      },
      categories,
    };
  });
}
