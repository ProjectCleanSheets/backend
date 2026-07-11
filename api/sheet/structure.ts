import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { getVerifiedUser } from '../../lib/auth';
import { sendError } from '../../lib/errors';
import {
  type CellValue,
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
  sheetId: z.string().regex(/^[a-zA-Z0-9_-]{20,100}$/, 'Invalid Google Sheet ID'),
  tab: z.string().min(1).max(100).optional(),
});

// Budget dashboards are small; one bounded read covers the whole layout and
// keeps the scan to a single Sheets API call.
const SCAN_RANGE = 'A1:Z300';

// Section names the onboarding flow offers (product spec). Used only as a
// fallback when the tab has no Budget/Actual header rows.
const KNOWN_SECTIONS = ['expenses', 'bills', 'income', 'save & invest', 'liabilities'];

// Default layout per CLAUDE.md: F=category, G=Budget, H=Actual, I=Left.
const DEFAULT_CATEGORY_COL = 5; // 0-indexed "F"

const MAX_SECTIONS = 20;
const MAX_CATEGORIES_PER_SECTION = 100;

interface HeaderRow {
  rowIndex: number;
  name: string;
  categoryCol: number;
  budgetCol: number;
  actualCol: number;
  leftCol: number | null;
}

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

// The scan range is bounded to columns A..Z, so one letter is always enough.
function columnLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * A section header row holds the section title with "Budget" and "Actual"
 * (optionally "Left") header cells to its right, e.g.
 *   F: "Expenses"  G: "Budget"  H: "Actual"  I: "Left"
 * The title is the nearest non-empty cell left of Budget; its column is the
 * section's category column.
 */
function detectHeaderRow(row: CellValue[], rowIndex: number): HeaderRow | null {
  const budgetCol = row.findIndex((cell) => /^budget$/i.test(cellText(cell)));
  if (budgetCol === -1) {
    return null;
  }

  let actualCol = -1;
  for (let col = budgetCol + 1; col <= budgetCol + 3; col++) {
    if (/^actual$/i.test(cellText(row[col]))) {
      actualCol = col;
      break;
    }
  }
  if (actualCol === -1) {
    return null;
  }

  let leftCol: number | null = null;
  for (let col = actualCol + 1; col <= actualCol + 2; col++) {
    if (/^left$/i.test(cellText(row[col]))) {
      leftCol = col;
      break;
    }
  }

  for (let col = budgetCol - 1; col >= 0; col--) {
    const name = cellText(row[col]);
    if (name) {
      return { rowIndex, name, categoryCol: col, budgetCol, actualCol, leftCol };
    }
  }
  return null;
}

// Fallback for tabs without Budget/Actual header rows: known section names in
// the default category column, with the default column layout.
function detectKnownNameRows(grid: CellValue[][]): HeaderRow[] {
  const headers: HeaderRow[] = [];
  grid.forEach((row, rowIndex) => {
    const name = cellText(row[DEFAULT_CATEGORY_COL]);
    if (name && KNOWN_SECTIONS.includes(name.toLowerCase())) {
      headers.push({
        rowIndex,
        name,
        categoryCol: DEFAULT_CATEGORY_COL,
        budgetCol: DEFAULT_CATEGORY_COL + 1,
        actualCol: DEFAULT_CATEGORY_COL + 2,
        leftCol: DEFAULT_CATEGORY_COL + 3,
      });
    }
  });
  return headers;
}

// Exported so the detection heuristics can be exercised directly; Vercel only
// routes the default export.
export function detectSections(grid: CellValue[][]): DetectedSection[] {
  let headers = grid
    .map((row, rowIndex) => detectHeaderRow(row, rowIndex))
    .filter((header): header is HeaderRow => header !== null);
  if (headers.length === 0) {
    headers = detectKnownNameRows(grid);
  }
  headers = headers.slice(0, MAX_SECTIONS);
  const headerRowIndexes = new Set(headers.map((header) => header.rowIndex));

  return headers.map((header) => {
    const categories: DetectedSection['categories'] = [];
    for (
      let rowIndex = header.rowIndex + 1;
      rowIndex < grid.length && categories.length < MAX_CATEGORIES_PER_SECTION;
      rowIndex++
    ) {
      if (headerRowIndexes.has(rowIndex)) {
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
