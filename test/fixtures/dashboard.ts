import type { CellValue } from '../../lib/sheets';

// A month tab shaped like the owner's dashboard, with made-up names and amounts.
// Rows are 1-based in the comments, as in the sheet.
//
//   B/C/D: "Cash flow" summary box (rows 2–6) whose labels repeat section names
//          next to numbers, then the real "Income" box (rows 9–13).
//   F/G/H/I: "Expenses" with a merged banner above its header (rows 2–9, two
//          spare rows above Total), then "Bills" with a "Due" column between
//          the names and Budget, and "Liabilities" stacked directly below it.
export const DASHBOARD: Record<string, CellValue> = {
  B2: 'Cash flow',
  C3: 'Budget',
  D3: 'Actual',
  B4: 'Income',
  C4: 30000,
  D4: 29500,
  B5: 'Invest',
  C5: 2000,
  D5: 2000,
  B6: 'Bills & Expenses',
  C6: 15000,
  D6: 14210.5,

  B9: 'Income',
  C10: 'Budget',
  D10: 'Actual',
  B11: 'Salary',
  C11: 28000,
  D11: 28000,
  B12: 'Other',
  C12: 2000,
  D12: 1500,
  B13: 'Total income',
  C13: 30000,
  D13: 29500,

  F2: 'Expenses',
  G3: 'Budget',
  H3: 'Actual',
  I3: 'Left',
  F4: 'Groceries',
  G4: 4000,
  H4: 3120.75,
  I4: 879.25,
  F5: 'Transport',
  G5: 800,
  H5: 640,
  F6: 'Eating out',
  G6: 1200,
  F9: 'Total expenses',

  F11: 'Bills',
  G12: 'Due',
  H12: 'Budget',
  I12: 'Actual',
  F13: 'Rent',
  G13: 1,
  H13: 9000,
  I13: 9000,
  F14: 'Internet',
  G14: 15,
  H14: 299,
  F15: 'Liabilities',
  H16: 'Budget',
  I16: 'Actual',
  F17: 'Student loan',
  H17: 1500,
  I17: 1500,
};

// The grid as values.get returns it: row-major, ragged (trailing blanks omitted).
export function toGrid(cells: Record<string, CellValue>): CellValue[][] {
  const grid: CellValue[][] = [];
  for (const [ref, value] of Object.entries(cells)) {
    const { col, row } = parseRef(ref);
    const line = (grid[row] ??= []);
    line[col] = value;
  }
  for (let r = 0; r < grid.length; r++) {
    const line = (grid[r] ??= []);
    for (let c = 0; c < line.length; c++) {
      if (line[c] === undefined) line[c] = '';
    }
  }
  return grid;
}

// One column as a single-column range read returns it: one row per sheet row.
export function toColumn(cells: Record<string, CellValue>, letter: string): CellValue[][] {
  const column: CellValue[][] = [];
  for (const [ref, value] of Object.entries(cells)) {
    const { col, row } = parseRef(ref);
    if (String.fromCharCode(65 + col) === letter) column[row] = [value];
  }
  for (let r = 0; r < column.length; r++) column[r] ??= [];
  return column;
}

function parseRef(ref: string): { col: number; row: number } {
  const match = /^([A-Z])(\d+)$/.exec(ref);
  if (!match) throw new Error(`bad cell ref ${ref}`);
  return { col: match[1]!.charCodeAt(0) - 65, row: Number(match[2]) - 1 };
}
