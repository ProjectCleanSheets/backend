import type { CellValue, Sheets } from '../../lib/sheets';

// A stand-in for the googleapis Sheets client covering the calls the save flow
// makes: batchGet of single-column ranges and single-cell updates. Reads come
// from `cells` (A1 refs → values); every update is recorded and applied.
export function fakeSheets(cells: Record<string, CellValue>) {
  const writes: { range: string; value: unknown }[] = [];
  const client = {
    spreadsheets: {
      values: {
        batchGet: async ({ ranges }: { ranges: string[] }) => ({
          data: { valueRanges: ranges.map((range) => ({ values: readColumn(cells, range) })) },
        }),
        update: async ({ range, requestBody }: { range: string; requestBody: { values: unknown[][] } }) => {
          const value = requestBody.values[0]?.[0];
          writes.push({ range, value });
          cells[range.split('!')[1]!] = value as CellValue;
          return { data: {} };
        },
      },
    },
  };
  return { sheets: client as unknown as Sheets, writes };
}

// "'Tab'!H1:H300" → that column as rows of one cell, ragged like the real API.
function readColumn(cells: Record<string, CellValue>, range: string): CellValue[][] {
  const letter = /!([A-Z])1:/.exec(range)?.[1];
  const rows: CellValue[][] = [];
  for (const [ref, value] of Object.entries(cells)) {
    if (ref[0] === letter) rows[Number(ref.slice(1)) - 1] = [value];
  }
  for (let r = 0; r < rows.length; r++) rows[r] ??= [];
  return rows;
}
