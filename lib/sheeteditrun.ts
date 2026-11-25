import type { sheets_v4 } from 'googleapis';
import { lettersToIndex } from './formularefs';
import { LOG_TAB } from './logtab';
import { SaveFlowError } from './saveflow';
import {
  type Box,
  cellKey,
  errorCells,
  type FormulaChange,
  formulaMap,
  planDelete,
  planInsert,
  type PlanResult,
  type RowEditPlan,
  type Workbook,
} from './sheetedit';
import { batchUpdate, type CellValue, readWorkbook, type Sheets } from './sheets';

// Carries out a plan from lib/sheetedit.ts and holds Sheets to it: after the edit
// every formula in the workbook must read exactly as planned and no new error may
// appear. On any difference the edit is reversed and the formulas are put back as
// they were, so the sheet is never left half-changed.

export type ReadWorkbook = () => Promise<Workbook>;

/** What a row edit did, or with `dryRun` would do. */
export interface RowEditSummary {
  tab: string;
  row: number;
  columns: string;
  formulasChanged: FormulaChange[];
}

/** Adds `name` as a new category row in the box, keeping every formula intact. */
export async function insertCategoryRow(
  sheets: Sheets,
  sheetId: string,
  box: Box,
  name: string,
  budget: number | null,
  dryRun = false,
): Promise<RowEditSummary> {
  return runPlanned(sheets, sheetId, (book) => planInsert(book, box, name, budget), dryRun);
}

/** Removes the category's row from the box, keeping every formula intact. */
export async function deleteCategoryRow(
  sheets: Sheets,
  sheetId: string,
  box: Box,
  category: string,
  dryRun = false,
): Promise<RowEditSummary> {
  return runPlanned(sheets, sheetId, (book) => planDelete(book, box, category), dryRun);
}

async function runPlanned(
  sheets: Sheets,
  sheetId: string,
  makePlan: (book: Workbook) => PlanResult,
  dryRun: boolean,
): Promise<RowEditSummary> {
  const read = () => readWorkbook(sheets, sheetId, [LOG_TAB]);
  const before = await read();
  const result = makePlan(before);
  if (!result.ok) {
    throw new SaveFlowError(409, 'INVALID_REQUEST', `Not changed, to keep the formulas intact: ${result.message}`);
  }
  const { plan } = result;
  if (!dryRun) await applyRowEdit(sheets, sheetId, plan, before, read);
  return { tab: plan.shift.tab, row: plan.shift.row, columns: plan.columns, formulasChanged: plan.changes };
}

/** Problems found after the edit, worst first; empty when Sheets did exactly what was planned. */
export function verifyEdit(plan: RowEditPlan, after: Workbook): string[] {
  const problems: string[] = [];
  const actual = formulaMap(after.tabs);
  for (const [key, want] of plan.expected) {
    const got = actual.get(key);
    if (got !== want) problems.push(`${key} reads ${got ?? '(empty)'}, expected ${want}`);
  }
  for (const key of actual.keys()) {
    if (!plan.expected.has(key)) problems.push(`${key} has an unexpected formula`);
  }
  for (const key of errorCells(after.tabs)) {
    if (!plan.knownErrors.has(key)) problems.push(`${key} now shows an error`);
  }
  return problems;
}

/**
 * Applies the plan, then checks it. Throws SaveFlowError if Sheets didn't match
 * the plan: 409 when the edit was undone cleanly, 500 if even the undo left a
 * difference (the message names the cells).
 */
export async function applyRowEdit(
  sheets: Sheets,
  sheetId: string,
  plan: RowEditPlan,
  before: Workbook,
  readWorkbook: ReadWorkbook,
): Promise<void> {
  await batchUpdate(sheets, sheetId, plan.requests);
  const problems = verifyEdit(plan, await readWorkbook());
  if (problems.length === 0) return;

  console.error('sheetedit: edit did not match the plan, undoing:', problems.slice(0, 5).join('; '));
  await batchUpdate(sheets, sheetId, undoRequests(plan));
  const left = await restoreFormulas(sheets, sheetId, before, readWorkbook);
  if (left.length > 0) {
    throw new SaveFlowError(
      500,
      'SHEET_WRITE_FAILED',
      `The sheet changed differently than planned and could not be fully restored: ${left.slice(0, 3).join('; ')}`,
    );
  }
  throw new SaveFlowError(
    409,
    'INVALID_REQUEST',
    `The sheet would not change safely, so nothing was changed: ${problems[0]}`,
  );
}

function undoRequests(plan: RowEditPlan): sheets_v4.Schema$Request[] {
  const { shift, tabId } = plan;
  const range: sheets_v4.Schema$GridRange = {
    sheetId: tabId,
    startRowIndex: shift.row - 1,
    endRowIndex: shift.row,
    startColumnIndex: shift.colStart,
    endColumnIndex: shift.colEnd + 1,
  };
  if (shift.kind === 'insert') return [{ deleteRange: { range, shiftDimension: 'ROWS' } }];

  // Put the deleted row back: cells as typed, formatting from the row above (or below).
  const neighbour = shift.row > 1 ? shift.row - 1 : shift.row + 1;
  return [
    { insertRange: { range, shiftDimension: 'ROWS' } },
    {
      copyPaste: {
        source: { ...range, startRowIndex: neighbour - 1, endRowIndex: neighbour },
        destination: range,
        pasteType: 'PASTE_FORMAT',
      },
    },
    {
      updateCells: {
        start: { sheetId: tabId, rowIndex: shift.row - 1, columnIndex: shift.colStart },
        rows: [{ values: plan.removedCells.map(asTyped) }],
        fields: 'userEnteredValue',
      },
    },
  ];
}

/**
 * Rewrites every formula that no longer reads as it did in `before` (e.g. a total
 * whose range Sheets didn't widen back on the undo). Returns cells still different.
 */
async function restoreFormulas(
  sheets: Sheets,
  sheetId: string,
  before: Workbook,
  readWorkbook: ReadWorkbook,
): Promise<string[]> {
  const wanted = formulaMap(before.tabs);
  const raw = new Map<string, { tabId: number; col: number; row: number; value: CellValue }>();
  for (const tab of before.tabs) {
    tab.cells.forEach((cells, r) =>
      cells.forEach((value, c) => raw.set(cellKey(tab.title, c, r + 1), { tabId: tab.tabId, col: c, row: r + 1, value })),
    );
  }
  const differing = (book: Workbook) => {
    const now = formulaMap(book.tabs);
    return [...new Set([...wanted.keys(), ...now.keys()])].filter((key) => wanted.get(key) !== now.get(key));
  };

  const after = await readWorkbook();
  const repairs: sheets_v4.Schema$Request[] = [];
  for (const key of differing(after)) {
    const cell = raw.get(key) ?? locate(after, key);
    if (!cell) continue;
    repairs.push({
      updateCells: {
        start: { sheetId: cell.tabId, rowIndex: cell.row - 1, columnIndex: cell.col },
        rows: [{ values: [asTyped(raw.get(key)?.value ?? '')] }],
        fields: 'userEnteredValue',
      },
    });
  }
  if (repairs.length === 0) return [];
  await batchUpdate(sheets, sheetId, repairs);
  return differing(await readWorkbook());
}

function locate(book: Workbook, key: string) {
  const match = /^(.*)!([A-Z]+)(\d+)$/.exec(key);
  const tab = match && book.tabs.find((t) => t.title === match[1]);
  return tab ? { tabId: tab.tabId, col: lettersToIndex(match[2]!), row: Number(match[3]) } : undefined;
}

function asTyped(value: CellValue): sheets_v4.Schema$CellData {
  if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
  if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
  if (value === '') return {};
  if (value.startsWith('=')) return { userEnteredValue: { formulaValue: value } };
  return { userEnteredValue: { stringValue: value } };
}
