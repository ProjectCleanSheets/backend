import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  adjustFormula,
  copyFormulaDown,
  indexToLetters,
  lettersToIndex,
  normalizeFormula,
  rangesOnTab,
  referencedSheets,
  type RowShift,
} from '../lib/formularefs';

// Bills is K..N; a row inserted at 30 shifts K..N from row 30 down.
const insertBills: RowShift = { tab: 'November', kind: 'insert', row: 30, colStart: 10, colEnd: 13 };
const deleteBills: RowShift = { ...insertBills, kind: 'delete' };

const adjust = (formula: string, shift: RowShift, home = 'November') => {
  const result = adjustFormula(formula, home, shift);
  return result.ok ? result.formula : `!${result.reason}: ${result.detail}`;
};

describe('column letters', () => {
  test('round-trip one and two letters', () => {
    for (const [letters, index] of [['A', 0], ['Z', 25], ['AA', 26], ['AC', 28]] as const) {
      assert.equal(lettersToIndex(letters), index);
      assert.equal(indexToLetters(index), letters);
    }
  });
});

describe('adjustFormula: insert', () => {
  test('a total whose range contains the new row grows by one', () => {
    assert.equal(adjust('=sum(M21:M30)', insertBills), '=sum(M21:M31)');
  });

  test('a total moves down when its own row moves; a range above is untouched', () => {
    assert.equal(adjust('=sum(N21:N29)', { ...insertBills, row: 31 }), '=sum(N21:N29)');
  });

  test('inserting at the first row of a range moves the whole range (the edge case)', () => {
    assert.equal(adjust('=sum(M21:M30)', { ...insertBills, row: 21 }), '=sum(M22:M31)');
  });

  test('cells below in the shifted columns move; other columns do not', () => {
    assert.equal(adjust('=G29+M31', insertBills), '=G29+M32');
    assert.equal(adjust('=L38', insertBills), '=L39');
    assert.equal(adjust('=C13+C14-C15', insertBills), '=C13+C14-C15');
  });

  test('references from another tab follow; references to other tabs stay', () => {
    assert.equal(adjust('=November!M33', insertBills, 'Overview'), '=November!M34');
    assert.equal(adjust("='November'!N31*2", insertBills, 'Overview'), "='November'!N32*2");
    assert.equal(adjust('=October!N31', insertBills), '=October!N31');
    assert.equal(adjust('=M31', insertBills, 'Overview'), '=M31');
  });

  test('anchors are kept', () => {
    assert.equal(adjust('=$M$31+M$30', insertBills), '=$M$32+M$31');
  });

  test('text inside quotes is never touched', () => {
    assert.equal(adjust('=IF(N31="" ; "M31"; N31)', insertBills), '=IF(N32="" ; "M31"; N32)');
  });

  test('function names that look like cells are not references', () => {
    assert.equal(adjust('=LOG10(M31)', insertBills), '=LOG10(M32)');
  });

  test('a range that straddles the shifted columns is refused', () => {
    assert.match(adjust('=sum(H21:M40)', insertBills), /^!unsupported: range H21:M40/);
  });

  test('a range entirely above the shift is fine even across columns', () => {
    assert.equal(adjust('=sum(A1:Z20)', insertBills), '=sum(A1:Z20)');
  });

  test('INDIRECT, OFFSET and whole-row ranges are refused; whole columns are fine', () => {
    assert.match(adjust('=INDIRECT("M"&30)', insertBills), /^!unsupported/);
    assert.match(adjust('=sum(OFFSET(M21;0;0;10))', insertBills), /^!unsupported/);
    assert.match(adjust('=sum(30:31)', insertBills), /^!unsupported: whole-row/);
    assert.equal(adjust('=sum(M:M)', insertBills), '=sum(M:M)');
  });
});

describe('adjustFormula: delete', () => {
  test('a total shrinks; cells below move up', () => {
    assert.equal(adjust('=sum(M21:M31)', deleteBills), '=sum(M21:M30)');
    assert.equal(adjust('=M38', deleteBills), '=M37');
  });

  test('deleting the first row of a range keeps its start', () => {
    assert.equal(adjust('=sum(M30:M40)', deleteBills), '=sum(M30:M39)');
  });

  test('a reference to the deleted cell itself is reported', () => {
    assert.equal(adjust('=November!N30', deleteBills, 'Overview'), '!deleted-cell: November!N30');
    assert.equal(adjust('=sum(N30:N30)', deleteBills), '!deleted-cell: N30:N30');
  });
});

describe('copyFormulaDown', () => {
  test('relative rows move, anchored rows stay', () => {
    assert.equal(copyFormulaDown('=IF(H13="" ; ""; G13-H13)', 1), '=IF(H14="" ; ""; G14-H14)');
    assert.equal(copyFormulaDown('=H13/$H$29', 2), '=H15/$H$29');
  });
});

describe('normalizeFormula', () => {
  test('ignores case and spacing outside quotes only', () => {
    assert.equal(normalizeFormula('=sum( G13:G28 )'), normalizeFormula('=SUM(G13:G28)'));
    assert.notEqual(normalizeFormula('=IF(A1="a b";1;2)'), normalizeFormula('=IF(A1="AB";1;2)'));
  });
});

describe('referencedSheets / rangesOnTab', () => {
  test('lists explicit sheet names', () => {
    assert.deepEqual(referencedSheets("=November!H13+'My tab'!A1+B2"), ['November', 'My tab']);
  });

  test('finds same-tab ranges only', () => {
    assert.deepEqual(rangesOnTab('=sum(G13:G28)+October!H1:H5', 'November', 'November'), [
      { left: 6, right: 6, top: 13, bottom: 28 },
    ]);
  });
});
