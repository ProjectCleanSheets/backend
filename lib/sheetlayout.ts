import {
  DEFAULT_ACTUAL_COLUMN,
  DEFAULT_BUDGET_COLUMN,
  DEFAULT_CATEGORY_COLUMN,
  DEFAULT_LEFT_COLUMN,
} from './constants';
import type { CellValue } from './sheets';

// How the backend reads a budget dashboard's layout from cell values already
// fetched: where each section box sits, its columns, and its category rows. Pure
// functions only — no Google API calls (those are in lib/sheets.ts). Two readers
// live here: detectSections (onboarding, whole tab) and scanSection (saves and the
// budget overview, one mapped column). Their box rules differ; the tests pin how.

/** Trimmed text of a string cell; '' for numbers, booleans and blanks. */
export function cellText(cell: CellValue | undefined): string {
  return typeof cell === 'string' ? cell.trim() : '';
}

/** A finite number cell, or null for anything else (blank, text). */
export function numberOrNull(cell: CellValue | undefined): number | null {
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
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

// --- One mapped column: saves, new category, budget overview ---------------

// How many blank cells may sit between a section's banner and its first
// category: merged banners surface their value in the top-left cell only, and
// the Budget/Actual header row usually leaves the category column empty.
const HEADER_GAP_ROWS = 4;

function firstCellText(row: CellValue[] | undefined): string {
  return cellText(row?.[0]);
}

export interface SectionScan {
  /** The box's category rows (1-based, cell text trimmed) in sheet order. */
  categories: { row: number; name: string }[];
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
 * a numeric value cell are skipped. Without a value-column read the first
 * matching row is the title.
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
  for (let i = titleIndex + 1; i < column.length; i++) {
    const text = firstCellText(column[i]);
    if (!text) {
      if (categories.length > 0) {
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
  return { categories };
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

// --- Whole tab: onboarding -------------------------------------------------

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

/**
 * Onboarding's reading of a whole tab: every section box with its columns and
 * categories, found from the Budget/Actual header rows (or, failing that, known
 * section names in the default columns). Saves and the budget overview don't use
 * this — they read one mapped column with scanSection, which applies different
 * box rules (see test/sheetlayout.test.ts, "differences").
 */
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
