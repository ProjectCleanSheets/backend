// Predicts how Google Sheets rewrites cell references when cells in a block of
// columns are shifted down (insert) or up (delete) by one row. lib/sheetedit.ts
// compares this prediction with what Sheets actually did, so any formula the
// prediction can't describe exactly is reported as unsupported rather than
// guessed at. Pure: strings in, strings out.

/** One row inserted or deleted on `tab`, shifting only columns `colStart..colEnd` (0-based, inclusive). */
export interface RowShift {
  tab: string;
  kind: 'insert' | 'delete';
  row: number; // 1-based: the inserted row, or the deleted one
  colStart: number;
  colEnd: number;
}

export type Adjusted =
  | { ok: true; formula: string }
  | { ok: false; reason: 'deleted-cell' | 'unsupported'; detail: string };

/** "A" → 0, "Z" → 25, "AA" → 26. */
export function lettersToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** 0 → "A", 26 → "AA". */
export function indexToLetters(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

// Functions whose targets are computed from text or offsets, so a shift can't be
// predicted from the formula alone.
const UNPREDICTABLE = /\b(INDIRECT|OFFSET|IMPORTRANGE)\s*\(/i;

// An optional sheet prefix ('Quoted name'! or Bare!), then a cell, an optional
// :cell, or a whole-column / whole-row range. The lookbehind keeps function names
// like LOG10( and parts of longer words from matching.
const REF =
  /(?<![A-Za-z0-9_.$'])((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(?:(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?|(\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3})|(\$?\d+:\$?\d+))(?![A-Za-z0-9_(!])/g;

function sheetName(prefix: string | undefined): string | null {
  if (!prefix) return null;
  const raw = prefix.slice(0, -1);
  return raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
}

/**
 * Calls `onRef` for every reference outside string literals and returns the
 * formula with each reference replaced by what `onRef` returns.
 */
function mapRefs(formula: string, onRef: (match: RegExpExecArray) => string): string {
  let out = '';
  // Split on string literals ("..." with "" as an escaped quote); refs live only between them.
  const parts = formula.split(/("(?:[^"]|"")*")/);
  for (const part of parts) {
    if (part.startsWith('"')) {
      out += part;
      continue;
    }
    out += part.replace(REF, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray;
      return onRef(match);
    });
  }
  return out;
}

/** Every sheet name a formula references explicitly (as written, unquoted). */
export function referencedSheets(formula: string): string[] {
  const names = new Set<string>();
  mapRefs(formula, (m) => {
    const name = sheetName(m[1]);
    if (name) names.add(name);
    return m[0];
  });
  return [...names];
}

/**
 * The formula as it should read after `shift`, for a formula that lives on
 * `homeTab`. References to other tabs are left alone.
 */
export function adjustFormula(formula: string, homeTab: string, shift: RowShift): Adjusted {
  if (UNPREDICTABLE.test(formula)) {
    return { ok: false, reason: 'unsupported', detail: 'uses INDIRECT, OFFSET or IMPORTRANGE' };
  }
  let failure: Adjusted | null = null;
  const fail = (f: Adjusted & { ok: false }, original: string) => {
    failure ??= f;
    return original;
  };
  const sameTab = (name: string | null) =>
    (name ?? homeTab).toLowerCase() === shift.tab.toLowerCase();

  const adjusted = mapRefs(formula, (m) => {
    const [whole, prefix, c1$, c1, r1$, r1, c2$, c2, r2$, r2, columns, rows] = m;
    if (!sameTab(sheetName(prefix))) return whole;
    if (columns) return whole; // whole columns: a row shift doesn't change them
    if (rows) return fail({ ok: false, reason: 'unsupported', detail: `whole-row range ${whole}` }, whole);

    const colA = lettersToIndex(c1!);
    const rowA = Number(r1);
    const inSpan = (col: number) => col >= shift.colStart && col <= shift.colEnd;

    if (c2 === undefined) {
      if (!inSpan(colA)) return whole;
      const moved = moveRow(rowA, shift);
      if (moved === null) {
        return fail({ ok: false, reason: 'deleted-cell', detail: whole }, whole);
      }
      return `${prefix ?? ''}${c1$}${c1}${r1$}${moved}`;
    }

    const colB = lettersToIndex(c2);
    const rowB = Number(r2);
    const [top, bottom] = rowA <= rowB ? [rowA, rowB] : [rowB, rowA];
    const [left, right] = colA <= colB ? [colA, colB] : [colB, colA];
    const touchesShiftedRows = bottom >= shift.row;
    const allIn = left >= shift.colStart && right <= shift.colEnd;
    const allOut = right < shift.colStart || left > shift.colEnd;
    if (allOut || !touchesShiftedRows) return whole;
    if (!allIn) {
      return fail({ ok: false, reason: 'unsupported', detail: `range ${whole} crosses the edge of the shifted columns` }, whole);
    }

    let newTop: number;
    let newBottom: number;
    if (shift.kind === 'insert') {
      newTop = top >= shift.row ? top + 1 : top;
      newBottom = bottom + 1;
    } else {
      if (top === shift.row && bottom === shift.row) {
        return fail({ ok: false, reason: 'deleted-cell', detail: whole }, whole);
      }
      newTop = top > shift.row ? top - 1 : top;
      newBottom = bottom - 1;
    }
    // Keep the written order of the two corners.
    const [first, second] = rowA <= rowB ? [newTop, newBottom] : [newBottom, newTop];
    return `${prefix ?? ''}${c1$}${c1}${r1$}${first}:${c2$}${c2}${r2$}${second}`;
  });

  return failure ?? { ok: true, formula: adjusted };
}

/** Where a 1-based row in the shifted columns ends up; null if it was deleted. */
export function moveRow(row: number, shift: RowShift): number | null {
  if (shift.kind === 'insert') return row >= shift.row ? row + 1 : row;
  if (row === shift.row) return null;
  return row > shift.row ? row - 1 : row;
}

/**
 * The formula as Sheets writes it when a cell is copied `rowDelta` rows down:
 * relative row numbers move, `$`-anchored ones and other columns stay.
 */
export function copyFormulaDown(formula: string, rowDelta: number): string {
  return mapRefs(formula, (m) => {
    const [whole, prefix, c1$, c1, r1$, r1, c2$, c2, r2$, r2, columns, rows] = m;
    if (columns || rows) return whole;
    const move = (anchor: string | undefined, row: string) => (anchor ? row : String(Number(row) + rowDelta));
    const first = `${prefix ?? ''}${c1$}${c1}${r1$}${move(r1$, r1!)}`;
    return c2 === undefined ? first : `${first}:${c2$}${c2}${r2$}${move(r2$, r2!)}`;
  });
}

/**
 * Formula text for comparison: whitespace and letter case outside string
 * literals don't matter (Sheets may re-render `sum(` as `SUM(` after a shift).
 */
export function normalizeFormula(formula: string): string {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part) => (part.startsWith('"') ? part : part.replace(/\s+/g, '').toUpperCase()))
    .join('');
}

/** Every same-tab range reference in a formula, as 0-based columns and 1-based rows. */
export function rangesOnTab(
  formula: string,
  homeTab: string,
  tab: string,
): { left: number; right: number; top: number; bottom: number }[] {
  const ranges: { left: number; right: number; top: number; bottom: number }[] = [];
  mapRefs(formula, (m) => {
    const [whole, prefix, , c1, , r1, , c2, , r2] = m;
    if ((sheetName(prefix) ?? homeTab).toLowerCase() !== tab.toLowerCase() || c2 === undefined) return whole;
    const a = lettersToIndex(c1!);
    const b = lettersToIndex(c2);
    ranges.push({
      left: Math.min(a, b),
      right: Math.max(a, b),
      top: Math.min(Number(r1), Number(r2)),
      bottom: Math.max(Number(r1), Number(r2)),
    });
    return whole;
  });
  return ranges;
}
