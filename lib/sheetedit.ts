import type { sheets_v4 } from 'googleapis';
import {
  adjustFormula,
  copyFormulaDown,
  indexToLetters,
  lettersToIndex,
  moveRow,
  normalizeFormula,
  rangesOnTab,
  type RowShift,
} from './formularefs';
import type { SectionColumns } from './saveflow';
import type { CellValue, TabGrid } from './sheets';

// Plans adding or removing one category row so that no formula in the workbook is
// lost or broken. A plan says exactly how every formula must read afterwards;
// lib/sheeteditrun.ts applies it, checks Sheets against it and undoes on any
// difference. Anything this file can't predict is refused before a cell changes.
//
// Rows are inserted and deleted only inside the section's own columns (insertRange /
// deleteRange with a row shift), because boxes sit side by side: a whole-row insert
// would push blank rows into the neighbouring boxes too. Sheets rewrites references
// on the edited tab for such a shift but leaves other tabs' references (e.g. the
// Overview tab's) pointing at the old cells, so the plan writes those itself.

export interface Workbook {
  tabs: TabGrid[];
  namedRangeTabIds: number[];
}

/** The section box being edited: its columns (letters) and current category rows. */
export interface Box {
  tab: string;
  section: string;
  categoryCol: string;
  valueCols: string[]; // budget / actual / left, whichever are mapped
  budgetCol: string | null;
  categories: { row: number; name: string }[];
}

/** The box for a section as saves resolve it: mapped columns plus its scanned categories. */
export function boxOf(
  tab: string,
  section: string,
  columns: SectionColumns,
  categories: Box['categories'],
): Box {
  return {
    tab,
    section,
    categoryCol: columns.categoryCol,
    budgetCol: columns.budgetCol,
    valueCols: [columns.budgetCol, columns.actualCol, columns.leftCol].filter((c): c is string => c !== null),
    categories,
  };
}

export interface FormulaChange {
  cell: string; // where the formula is after the edit, e.g. "Overview!B16"
  before: string;
  after: string;
}

export interface RowEditPlan {
  shift: RowShift;
  tabId: number;
  /** "K:N" — the columns that shift. */
  columns: string;
  /** Formulas whose text changes, plus the new row's own formulas. */
  changes: FormulaChange[];
  /** Normalized formula per cell after the edit, for every formula cell in the workbook. */
  expected: Map<string, string>;
  /** Cells that already showed an error before the edit, at their position after it. */
  knownErrors: Set<string>;
  requests: sheets_v4.Schema$Request[];
  /** The deleted row's cells as typed, so an undo can put them back. */
  removedCells: CellValue[];
}

export type PlanResult = { ok: true; plan: RowEditPlan } | { ok: false; message: string };

const ERROR_VALUE = /^#(REF!|VALUE!|N\/A|DIV\/0!|NAME\?|NUM!|ERROR!|NULL!)/;

export const cellKey = (tab: string, col: number, row: number) => `${tab}!${indexToLetters(col)}${row}`;

function isFormula(value: CellValue | undefined): value is string {
  return typeof value === 'string' && value.startsWith('=');
}

/** Every cell showing an error value, keyed "Tab!A1". */
export function errorCells(tabs: TabGrid[]): Set<string> {
  const keys = new Set<string>();
  for (const tab of tabs) {
    tab.shown.forEach((row, r) =>
      row.forEach((value, c) => {
        if (isFormula(tab.cells[r]?.[c]) && typeof value === 'string' && ERROR_VALUE.test(value)) {
          keys.add(cellKey(tab.title, c, r + 1));
        }
      }),
    );
  }
  return keys;
}

/** Every formula cell, keyed "Tab!A1", normalized. */
export function formulaMap(tabs: TabGrid[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const tab of tabs) {
    tab.cells.forEach((row, r) =>
      row.forEach((value, c) => {
        if (isFormula(value)) map.set(cellKey(tab.title, c, r + 1), normalizeFormula(value));
      }),
    );
  }
  return map;
}

/** Plans inserting `name` as a new category row inside the box. */
export function planInsert(book: Workbook, box: Box, name: string, budget: number | null): PlanResult {
  const tab = findTab(book, box.tab);
  if (!tab) return refuse(`No tab "${box.tab}"`);
  if (box.categories.length === 0) return refuse(`Section "${box.section}" has no categories to add next to`);
  const first = box.categories[0]!.row;
  const last = box.categories[box.categories.length - 1]!.row;

  // Insert where every total over this box grows to include the new row: Sheets
  // only extends a range when the insert is strictly inside it. Right after the
  // last category when spare rows sit inside the totals, else above the last one.
  const totals = boxTotals(tab, box, first, last);
  const row = [last + 1, last].find(
    (p) => p > first && totals.every((t) => t.top < p && p <= t.bottom),
  );
  if (row === undefined) {
    const cells = totals.map((t) => t.cell).join(', ');
    return refuse(`A new row in "${box.section}" can't be added inside the totals (${cells})`);
  }

  const span = shiftColumns(tab, box, row);
  if (!span.ok) return refuse(span.message);
  const shift: RowShift = { tab: tab.title, kind: 'insert', row, colStart: span.colStart, colEnd: span.colEnd };
  const predicted = predict(book, shift);
  if (!predicted.ok) return predicted;

  // The new row copies the row above it: its formulas (e.g. Left) come along one row
  // down, its formatting is pasted, and its plain values are replaced.
  const neighbour = row - 1;
  const categoryIndex = lettersToIndex(box.categoryCol);
  const budgetIndex = box.budgetCol === null ? null : lettersToIndex(box.budgetCol);
  const newValues: sheets_v4.Schema$CellData[] = [];
  for (let c = span.colStart; c <= span.colEnd; c++) {
    const above = tab.cells[neighbour - 1]?.[c];
    if (isFormula(above)) {
      const adjusted = adjustFormula(above, tab.title, shift);
      if (!adjusted.ok) return refuse(`Can't copy the formula in ${cellKey(tab.title, c, neighbour)} (${adjusted.detail})`);
      const copied = copyFormulaDown(adjusted.formula, 1);
      newValues.push({ userEnteredValue: { formulaValue: copied } });
      predicted.expected.set(cellKey(tab.title, c, row), normalizeFormula(copied));
      predicted.changes.push({ cell: cellKey(tab.title, c, row), before: '', after: copied });
    } else if (c === categoryIndex) {
      newValues.push({ userEnteredValue: { stringValue: name } });
    } else if (c === budgetIndex && budget !== null) {
      newValues.push({ userEnteredValue: { numberValue: budget } });
    } else {
      newValues.push({});
    }
  }

  const range = gridRow(tab.tabId, row, span.colStart, span.colEnd);
  return {
    ok: true,
    plan: {
      ...predicted,
      shift,
      tabId: tab.tabId,
      columns: `${indexToLetters(span.colStart)}:${indexToLetters(span.colEnd)}`,
      removedCells: [],
      requests: [
        { insertRange: { range, shiftDimension: 'ROWS' } },
        {
          copyPaste: {
            source: gridRow(tab.tabId, neighbour, span.colStart, span.colEnd),
            destination: range,
            pasteType: 'PASTE_FORMAT',
          },
        },
        {
          updateCells: {
            start: { sheetId: tab.tabId, rowIndex: row - 1, columnIndex: span.colStart },
            rows: [{ values: newValues }],
            fields: 'userEnteredValue',
          },
        },
        ...otherTabWrites(book, shift, predicted.changes),
      ],
    },
  };
}

/** Plans removing the category's row from the box. */
export function planDelete(book: Workbook, box: Box, category: string): PlanResult {
  const tab = findTab(book, box.tab);
  if (!tab) return refuse(`No tab "${box.tab}"`);
  const target = box.categories.find((c) => c.name.toLowerCase() === category.trim().toLowerCase());
  if (!target) return refuse(`No category "${category}" in section "${box.section}"`);
  if (box.categories.length === 1) return refuse(`"${target.name}" is the only category in "${box.section}"`);

  const span = shiftColumns(tab, box, target.row);
  if (!span.ok) return refuse(span.message);
  const shift: RowShift = { tab: tab.title, kind: 'delete', row: target.row, colStart: span.colStart, colEnd: span.colEnd };
  const predicted = predict(book, shift);
  if (!predicted.ok) return predicted;

  const removedCells: CellValue[] = [];
  for (let c = span.colStart; c <= span.colEnd; c++) removedCells.push(tab.cells[target.row - 1]?.[c] ?? '');
  return {
    ok: true,
    plan: {
      ...predicted,
      shift,
      tabId: tab.tabId,
      columns: `${indexToLetters(span.colStart)}:${indexToLetters(span.colEnd)}`,
      removedCells,
      requests: [
        { deleteRange: { range: gridRow(tab.tabId, target.row, span.colStart, span.colEnd), shiftDimension: 'ROWS' } },
        ...otherTabWrites(book, shift, predicted.changes),
      ],
    },
  };
}

function refuse(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function findTab(book: Workbook, title: string): TabGrid | undefined {
  return book.tabs.find((t) => t.title.toLowerCase() === title.trim().toLowerCase());
}

function gridRow(sheetId: number, row: number, colStart: number, colEnd: number): sheets_v4.Schema$GridRange {
  return { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: colStart, endColumnIndex: colEnd + 1 };
}

/** Writes each changed formula outside the edited tab, which Sheets would leave unchanged. */
function otherTabWrites(book: Workbook, shift: RowShift, changes: FormulaChange[]): sheets_v4.Schema$Request[] {
  return changes.flatMap((change) => {
    const match = /^(.*)!([A-Z]+)(\d+)$/.exec(change.cell)!;
    const tab = findTab(book, match[1]!);
    if (!tab || tab.title === shift.tab) return [];
    return [
      {
        updateCells: {
          start: { sheetId: tab.tabId, rowIndex: Number(match[3]) - 1, columnIndex: lettersToIndex(match[2]!) },
          rows: [{ values: [{ userEnteredValue: { formulaValue: change.after } }] }],
          fields: 'userEnteredValue',
        },
      },
    ];
  });
}

/** Formulas on the tab that add up this box's value columns (the section's totals). */
function boxTotals(tab: TabGrid, box: Box, first: number, last: number) {
  const valueIndexes = new Set(box.valueCols.map(lettersToIndex));
  const totals: { cell: string; top: number; bottom: number }[] = [];
  tab.cells.forEach((row, r) =>
    row.forEach((value, c) => {
      if (!isFormula(value)) return;
      for (const range of rangesOnTab(value, tab.title, tab.title)) {
        const inBox = range.left === range.right && valueIndexes.has(range.left);
        if (inBox && range.top <= last && range.bottom >= first) {
          totals.push({ cell: cellKey(tab.title, c, r + 1), top: range.top, bottom: range.bottom });
        }
      }
    }),
  );
  return totals;
}

/**
 * The box's columns, widened so no merged cell at or below `row` is cut by the
 * shift. A merge that spans `row` itself can't be shifted at all.
 */
function shiftColumns(tab: TabGrid, box: Box, row: number) {
  const indexes = [box.categoryCol, ...box.valueCols].map(lettersToIndex);
  let colStart = Math.min(...indexes);
  let colEnd = Math.max(...indexes);
  for (let widened = true; widened; ) {
    widened = false;
    for (const m of tab.merges) {
      const [top, bottom] = [(m.startRowIndex ?? 0) + 1, m.endRowIndex ?? 0];
      const [left, right] = [m.startColumnIndex ?? 0, (m.endColumnIndex ?? 1) - 1];
      if (bottom < row || right < colStart || left > colEnd) continue;
      if (top < row) {
        return { ok: false as const, message: `The merged cells ${indexToLetters(left)}${top}:${indexToLetters(right)}${bottom} sit across row ${row}` };
      }
      if (left < colStart || right > colEnd) {
        colStart = Math.min(colStart, left);
        colEnd = Math.max(colEnd, right);
        widened = true;
      }
    }
  }
  return { ok: true as const, colStart, colEnd };
}

/** How every formula in the workbook must read after `shift`, or why it can't be predicted. */
function predict(
  book: Workbook,
  shift: RowShift,
): ({ ok: true } & Pick<RowEditPlan, 'expected' | 'changes' | 'knownErrors'>) | { ok: false; message: string } {
  const editedTab = findTab(book, shift.tab);
  if (editedTab && book.namedRangeTabIds.includes(editedTab.tabId)) {
    return refuse(`Tab "${shift.tab}" has named ranges, which this check can't follow`);
  }
  const moveCell = (tab: string, col: number, row: number): number | null =>
    tab === shift.tab && col >= shift.colStart && col <= shift.colEnd ? moveRow(row, shift) : row;

  const expected = new Map<string, string>();
  const changes: FormulaChange[] = [];
  for (const tab of book.tabs) {
    for (let r = 0; r < tab.cells.length; r++) {
      const row = tab.cells[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        const value = row[c];
        if (!isFormula(value)) continue;
        const newRow = moveCell(tab.title, c, r + 1);
        if (newRow === null) continue; // the formula is in the deleted row and goes with it
        const adjusted = adjustFormula(value, tab.title, shift);
        const here = cellKey(tab.title, c, r + 1);
        if (!adjusted.ok) {
          const why = adjusted.reason === 'deleted-cell' ? `refers to ${adjusted.detail}, which would be removed` : adjusted.detail;
          return refuse(`${here} (${value}) ${why}`);
        }
        const key = cellKey(tab.title, c, newRow);
        expected.set(key, normalizeFormula(adjusted.formula));
        if (adjusted.formula !== value) changes.push({ cell: key, before: value, after: adjusted.formula });
      }
    }
  }

  const knownErrors = new Set<string>();
  for (const key of errorCells(book.tabs)) {
    const match = /^(.*)!([A-Z]+)(\d+)$/.exec(key)!;
    const newRow = moveCell(match[1]!, lettersToIndex(match[2]!), Number(match[3]));
    if (newRow !== null) knownErrors.add(`${match[1]}!${match[2]}${newRow}`);
  }
  return { ok: true, expected, changes, knownErrors };
}
