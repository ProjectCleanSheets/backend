import type { sheets_v4 } from 'googleapis';
import { resolveColumns } from '../../lib/saveflow';
import type { Box, Workbook } from '../../lib/sheetedit';
import { scanSection } from '../../lib/sheetlayout';
import type { CellValue, TabGrid } from '../../lib/sheets';

// A month tab with the owner's real layout and formulas (positions, merges and
// formula text as read from the sheet, `;` separators included), with neutral
// category names and made-up amounts. Plus an Overview tab and the next month's
// carry-over, which reference it from outside.
export const MONTH: Record<string, CellValue> = {
  B2: 'November', B4: 'Overview', B6: 'Start date', C6: 46000, B7: 'End date', C7: 46030,
  B8: 'Start balance', C8: '=October!D18',
  B10: ' Cash flow ', F10: 'Expenses',
  C12: 'Budget', D12: 'Actual', G12: 'Budget', H12: 'Actual', I12: 'Left',
  B13: 'Start balance ', C13: '=C8', D13: '=C8',
  B14: 'Income ', C14: '=C28', D14: '=D28',
  B15: 'Invest', C15: '=C36', D15: '=D36',
  B16: 'Bills & Expenses', C16: '=G29+M31', D16: '=H29+N31',
  B17: 'Liablities', C17: '=L38', D17: '=M38',
  B18: 'Left', C18: '=C13+C14-C15-C16-C17', D18: '=D13+D14-D15-D16-D17',
  B19: 'Left to spend', C19: '=D18', D19: '=D14-C19',
  F13: 'Food', G13: 4000, H13: 3100, I13: '=IF(H13="" ; ""; G13-H13)',
  F14: 'Fuel', G14: 800, H14: 600,
  F15: 'Dining', G15: 1200, H15: 900, I15: '=IF(H15="" ; ""; G15-H15)',
  F16: 'Treats', G16: 500, H16: 450, I16: '=IF(H16="" ; ""; G16-H16)',
  F17: 'Presents', G17: 300, I17: '=IF(H17="" ; ""; G17-H17)',
  F18: 'Home', G18: 600, I18: '=IF(H18="" ; ""; G18-H18)',
  F19: 'Clothes', G19: 700, H19: 200, I19: '=IF(H19="" ; ""; G19-H19)',
  F20: 'Tools ', G20: 100, I20: '=IF(H20="" ; ""; G20-H20)',
  F21: 'Care', G21: 300, H21: 120, I21: '=IF(H21="" ; ""; G21-H21)',
  F22: 'Games', G22: 200, H22: 50, I22: '=IF(H22="" ; ""; G22-H22)',
  F23: 'Hobby', G23: 400, H23: 380,
  I26: '=IF(H26="" ; ""; G26-H26)', I27: '=IF(H27="" ; ""; G27-H27)', I28: '=IF(H28="" ; ""; G28-H28)',
  F29: 'Total', G29: '=sum(G13:G28)', H29: '=sum(H13:H28)', I29: '=sum(I13:I28)',
  K18: ' Bills', L20: 'Due', M20: 'Budget', N20: 'Actual',
  K21: 'Rent', L21: 1, M21: 9000, N21: 9000,
  K22: 'Power', L22: 5, M22: 600, N22: 580,
  K23: 'Phone ', L23: 10, M23: 200, N23: 200,
  K24: 'Car insurance', L24: 12, M24: 400, N24: 400,
  K25: 'Gym', L25: 15, M25: 250, N25: 250,
  K26: 'Internet', L26: 18, M26: 300, N26: 300,
  K27: 'Music', L27: 20, M27: 99,
  K28: 'Fees', L28: 25, M28: 150, N28: 150,
  K29: 'Car wash', L29: 26, M29: 100, N29: 100,
  K30: 'Software', L30: 28, M30: 180, N30: 180,
  K31: 'Total', M31: '=sum(M21:M30)', N31: '=sum(N21:N30)',
  B20: 'Income', C22: 'Budget', D22: 'Actual', B23: 'Salary', C23: 30000, D23: 30000, C27: ' ',
  B28: 'Total', C28: '=sum(C23:C27)', D28: '=sum(D23:D27)',
  B30: ' Save & Invest', C32: 'Budget', D32: 'Actual',
  B33: 'Invest', C33: 2000, D33: 2000, H33: '  ', B34: 'Emergency fund ', C34: 1000, D34: 1000,
  B36: 'Total', C36: '=sum(C33:C35)', D36: '=sum(D33:D35)',
  K33: 'Liablities', L35: 'Budget', M35: 'Actual',
  K36: 'Car', L36: 1500, M36: 1500, K37: 'Loan', L37: 500, M37: 500,
  K38: 'Total', L38: '=sum(L36:L37)', M38: '=sum(M36:M37)',
};

export const MONTH_MERGES = ['B10:D11', 'B20:D21', 'B30:D31', 'B2:D2', 'B4:D5', 'C6:D6', 'C7:D7', 'C8:D8', 'F10:I11', 'K18:N19', 'K33:N34'];

// The Overview tab points at single category cells and at a tab that no longer
// exists ("Dec"), which already shows #REF! before any edit.
export const OVERVIEW: Record<string, CellValue> = {
  B4: '=November!D23', C4: '=Dec!D23',
  B9: '=November!H13', B10: '=November!H14', B16: '=November!M33', B17: '=November!N28',
  B18: '=November!H21', B23: '=November!D34',
};

export const NEXT_MONTH: Record<string, CellValue> = { B2: 'December', C8: '=November!D18' };

export const MAPPING = {
  Bills: { actual_col: 'N', budget_col: 'M', category_col: 'K' },
  Income: { actual_col: 'D', budget_col: 'C', category_col: 'B' },
  Expenses: { left_col: 'I', actual_col: 'H', budget_col: 'G', category_col: 'F' },
  Liablities: { actual_col: 'M', budget_col: 'L', category_col: 'K' },
  'Save & Invest': { actual_col: 'D', budget_col: 'C', category_col: 'B' },
};

export function parseA1(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad ref ${ref}`);
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + ch.charCodeAt(0) - 64;
  return { col: col - 1, row: Number(m[2]) };
}

export function gridOf(cells: Record<string, CellValue>): CellValue[][] {
  const grid: CellValue[][] = [];
  for (const [ref, value] of Object.entries(cells)) {
    const { col, row } = parseA1(ref);
    (grid[row - 1] ??= [])[col] = value;
  }
  for (let r = 0; r < grid.length; r++) {
    const line = (grid[r] ??= []);
    for (let c = 0; c < line.length; c++) line[c] ??= '';
  }
  return grid;
}

export function mergesOf(sheetId: number, refs: string[]): sheets_v4.Schema$GridRange[] {
  return refs.map((ref) => {
    const [a, b] = ref.split(':').map(parseA1);
    return { sheetId, startRowIndex: a!.row - 1, endRowIndex: b!.row, startColumnIndex: a!.col, endColumnIndex: b!.col + 1 };
  });
}

/** The three tabs as a Workbook snapshot, with Overview's broken "Dec" reference showing #REF!. */
export function workbook(): Workbook {
  const tab = (title: string, tabId: number, cells: Record<string, CellValue>, merges: string[] = []): TabGrid => {
    const grid = gridOf(cells);
    const shown = grid.map((row) => row.map((v) => (typeof v === 'string' && /Dec!/.test(v) ? '#REF!' : v)));
    return { title, tabId, cells: grid, shown, merges: mergesOf(tabId, merges) };
  };
  return {
    tabs: [tab('Overview', 1, OVERVIEW), tab('November', 2, MONTH, MONTH_MERGES), tab('December', 3, NEXT_MONTH)],
    namedRangeTabIds: [],
  };
}

/** The box for a mapped section, scanned the way saves scan it. */
export function boxFor(book: Workbook, section: keyof typeof MAPPING): Box {
  const tab = book.tabs.find((t) => t.title === 'November')!;
  const cols = resolveColumns(MAPPING, section);
  const column = (letter: string) => tab.cells.map((row) => [row[letter.charCodeAt(0) - 65] ?? '']);
  // Saves read evaluated values; here a formula stands in as a number so a
  // summary row (Cash flow's "Income ") is still told apart from the box title.
  const actual = tab.cells.map((row) => {
    const v = row[cols.actualCol.charCodeAt(0) - 65];
    return [typeof v === 'string' && v.startsWith('=') ? 1 : v ?? ''];
  });
  const scan = scanSection(column(cols.categoryCol), section, cols.otherSections, actual)!;
  return {
    tab: 'November',
    section,
    categoryCol: cols.categoryCol,
    budgetCol: cols.budgetCol,
    valueCols: [cols.budgetCol, cols.actualCol, cols.leftCol].filter((c): c is string => c !== null),
    categories: scan.categories,
  };
}

/** Cell values with trailing blanks dropped, for comparing grids. */
export function trimmed(cells: CellValue[][]): CellValue[][] {
  const rows = cells.map((row) => {
    const out = [...row].map((v) => v ?? '');
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  });
  while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop();
  return rows;
}
