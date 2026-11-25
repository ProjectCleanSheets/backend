import type { sheets_v4 } from 'googleapis';
import { adjustFormula, type RowShift } from '../../lib/formularefs';
import type { CellValue, Sheets } from '../../lib/sheets';
import type { Workbook } from '../../lib/sheetedit';

// A small in-memory Google Sheets for the calls the backend makes: reads in the
// three render modes, single-cell writes, appends, and the batchUpdate requests a
// row edit sends. Reference rewriting on insert/delete follows Sheets' documented
// behaviour via lib/formularefs; `misbehave` lets a test make "Sheets" disagree
// with the plan, to exercise the check and the undo.
export interface SimOptions {
  /** Called with each formula Sheets rewrote; return something else to simulate a surprise. */
  misbehave?: (tab: string, formula: string) => string;
}

interface SimTab {
  title: string;
  tabId: number;
  cells: CellValue[][];
  merges: sheets_v4.Schema$GridRange[];
}

export function simSheets(book: Workbook, options: SimOptions = {}) {
  const tabs: SimTab[] = book.tabs.map((t) => ({
    title: t.title,
    tabId: t.tabId,
    cells: t.cells.map((row) => [...row]),
    merges: t.merges.map((m) => ({ ...m })),
  }));
  let batchUpdates = 0;
  const byTitle = (raw: string) => {
    const title = raw.replace(/^'|'$/g, '').replace(/''/g, "'");
    const tab = tabs.find((t) => t.title === title);
    if (!tab) throw Object.assign(new Error('not found'), { response: { status: 400 } });
    return tab;
  };
  const byId = (id: number | null | undefined) => tabs.find((t) => t.tabId === id)!;

  const shown = (tab: SimTab, value: CellValue): CellValue => {
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    const sheetsNamed = [...value.matchAll(/([A-Za-z][A-Za-z0-9_]*)!/g)].map((m) => m[1]!);
    if (value.includes('#REF!') || sheetsNamed.some((n) => !tabs.some((t) => t.title === n))) return '#REF!';
    return 1; // stands in for any evaluated result
  };

  const readRange = (range: string, mode: string): CellValue[][] => {
    const [title, a1] = splitRange(range);
    const tab = byTitle(title);
    const render = (v: CellValue) => (mode === 'FORMULA' ? v : shown(tab, v));
    if (!a1) return tab.cells.map((row) => row.map(render));
    const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1)!;
    const [c1, r1] = [col(m[1]!), Number(m[2])];
    const [c2, r2] = m[3] ? [col(m[3]), Number(m[4])] : [c1, r1];
    const out: CellValue[][] = [];
    for (let r = r1; r <= Math.min(r2, tab.cells.length); r++) {
      out.push(Array.from({ length: c2 - c1 + 1 }, (_, i) => render(tab.cells[r - 1]?.[c1 + i] ?? '')));
    }
    return out;
  };

  const rewriteAll = (shift: RowShift) => {
    for (const tab of tabs) {
      tab.cells = tab.cells.map((row) =>
        row.map((v) => {
          if (typeof v !== 'string' || !v.startsWith('=')) return v;
          const adjusted = adjustFormula(v, tab.title, shift);
          const next = adjusted.ok ? adjusted.formula : '=#REF!';
          return next === v ? v : (options.misbehave?.(tab.title, next) ?? next);
        }),
      );
    }
  };

  const shiftRows = (range: sheets_v4.Schema$GridRange, kind: 'insert' | 'delete') => {
    const tab = byId(range.sheetId);
    const row = (range.startRowIndex ?? 0) + 1;
    const [c1, c2] = [range.startColumnIndex ?? 0, (range.endColumnIndex ?? 1) - 1];
    const shift: RowShift = { tab: tab.title, kind, row, colStart: c1, colEnd: c2 };
    rewriteAll(shift);
    const height = tab.cells.length + 1;
    const take = (r: number, c: number) => tab.cells[r - 1]?.[c] ?? '';
    const next: CellValue[][] = [];
    for (let r = 1; r <= height; r++) {
      const line: CellValue[] = [...(tab.cells[r - 1] ?? [])];
      for (let c = c1; c <= c2; c++) {
        if (r < row) continue;
        line[c] = kind === 'insert' ? (r === row ? '' : take(r - 1, c)) : take(r + 1, c);
      }
      next.push(line);
    }
    tab.cells = next;
  };

  const client = {
    spreadsheets: {
      get: async () => ({
        data: {
          namedRanges: [],
          sheets: tabs.map((t) => ({ properties: { title: t.title, sheetId: t.tabId }, merges: t.merges })),
        },
      }),
      batchUpdate: async ({ requestBody }: { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest }) => {
        batchUpdates++;
        for (const req of requestBody.requests ?? []) {
          if (req.insertRange) shiftRows(req.insertRange.range!, 'insert');
          else if (req.deleteRange) shiftRows(req.deleteRange.range!, 'delete');
          else if (req.copyPaste) continue; // formatting only
          else if (req.updateCells) {
            const { start, rows } = req.updateCells;
            const tab = byId(start!.sheetId);
            (rows ?? []).forEach((row, ri) =>
              (row.values ?? []).forEach((cell, ci) => {
                const v = cell.userEnteredValue;
                const value = v?.formulaValue ?? v?.stringValue ?? v?.numberValue ?? v?.boolValue ?? '';
                const r = (start!.rowIndex ?? 0) + ri;
                (tab.cells[r] ??= [])[(start!.columnIndex ?? 0) + ci] = value;
              }),
            );
          } else if (req.addSheet) {
            const tabId = 100 + tabs.length;
            tabs.push({ title: req.addSheet.properties!.title!, tabId, cells: [], merges: [] });
            return { data: { replies: [{ addSheet: { properties: { sheetId: tabId } } }] } };
          } else throw new Error(`sim: unsupported request ${Object.keys(req)}`);
        }
        return { data: { replies: [] } };
      },
      values: {
        get: async ({ range, valueRenderOption }: { range: string; valueRenderOption: string }) => ({
          data: { values: readRange(range, valueRenderOption) },
        }),
        batchGet: async ({ ranges, valueRenderOption }: { ranges: string[]; valueRenderOption: string }) => ({
          data: { valueRanges: ranges.map((range) => ({ values: readRange(range, valueRenderOption) })) },
        }),
        update: async ({ range, requestBody }: { range: string; requestBody: { values: CellValue[][] } }) => {
          const [title, a1] = splitRange(range);
          const tab = byTitle(title);
          const m = /^([A-Z]+)(\d+)$/.exec(a1!)!;
          (tab.cells[Number(m[2]) - 1] ??= [])[col(m[1]!)] = requestBody.values[0]![0]!;
          return { data: {} };
        },
        append: async ({ range, requestBody }: { range: string; requestBody: { values: CellValue[][] } }) => {
          const tab = byTitle(splitRange(range)[0]);
          tab.cells.push([...requestBody.values[0]!]);
          return { data: {} };
        },
      },
    },
  };

  /** The sim's current state as a Workbook (formulas and what they show). */
  const snapshot = (): Workbook => ({
    tabs: tabs.map((t) => ({
      title: t.title,
      tabId: t.tabId,
      cells: t.cells.map((row) => [...row]),
      shown: t.cells.map((row) => row.map((v) => shown(t, v))),
      merges: t.merges,
    })),
    namedRangeTabIds: [],
  });

  return { sheets: client as unknown as Sheets, snapshot, batchUpdates: () => batchUpdates };
}

function splitRange(range: string): [string, string | undefined] {
  const bang = range.lastIndexOf('!');
  return bang === -1 ? [range, undefined] : [range.slice(0, bang), range.slice(bang + 1)];
}

function col(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
