import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planDelete, planInsert, type PlanResult } from '../lib/sheetedit';
import { boxFor, workbook } from './fixtures/workbook';

function plan(result: PlanResult) {
  if (!result.ok) assert.fail(result.message);
  return result.plan;
}

const changed = (result: PlanResult) =>
  Object.fromEntries(plan(result).changes.map((c) => [c.cell, c.after]));

describe('planInsert', () => {
  test('Bills has no spare row inside its totals, so the new row goes above the last bill', () => {
    const book = workbook();
    const p = plan(planInsert(book, boxFor(book, 'Bills'), 'Water', 120));
    assert.equal(p.shift.row, 30);
    assert.equal(p.columns, 'K:N');
    assert.deepEqual(changed({ ok: true, plan: p }), {
      'Overview!B16': '=November!M34',
      'November!C16': '=G29+M32',
      'November!D16': '=H29+N32',
      'November!C17': '=L39',
      'November!D17': '=M39',
      'November!M32': '=sum(M21:M31)',
      'November!N32': '=sum(N21:N31)',
      'November!L39': '=sum(L37:L38)',
      'November!M39': '=sum(M37:M38)',
    });
  });

  test('the request shifts only the box columns and writes name and budget', () => {
    const book = workbook();
    const p = plan(planInsert(book, boxFor(book, 'Bills'), 'Water', 120));
    assert.deepEqual(p.requests[0], {
      insertRange: {
        range: { sheetId: 2, startRowIndex: 29, endRowIndex: 30, startColumnIndex: 10, endColumnIndex: 14 },
        shiftDimension: 'ROWS',
      },
    });
    assert.deepEqual(p.requests[2]?.updateCells?.rows?.[0]?.values, [
      { userEnteredValue: { stringValue: 'Water' } },
      {},
      { userEnteredValue: { numberValue: 120 } },
      {},
    ]);
  });

  test('Expenses has spare rows inside its totals, so the new row goes right after the last category', () => {
    const book = workbook();
    const p = plan(planInsert(book, boxFor(book, 'Expenses'), 'Pets', null));
    assert.equal(p.shift.row, 24);
    assert.equal(p.columns, 'F:I');
    const after = changed({ ok: true, plan: p });
    assert.equal(after['November!G30'], '=sum(G13:G29)');
    assert.equal(after['November!I27'], '=IF(H27="" ; ""; G27-H27)');
    assert.equal(after['November!C16'], '=G30+M31');
    // Overview's references to cells above the new row stay put.
    assert.equal(after['Overview!B9'], undefined);
  });

  test('the new row copies the Left formula from the row above when there is one', () => {
    const book = workbook();
    const box = boxFor(book, 'Expenses');
    box.categories = box.categories.slice(0, -1); // pretend Games (row 22, with Left) is last
    const p = plan(planInsert(book, box, 'Pets', 50));
    assert.equal(p.shift.row, 23);
    assert.equal(changed({ ok: true, plan: p })['November!I23'], '=IF(H23="" ; ""; G23-H23)');
  });

  test('Income (one category, spare rows) adds below it; the Save & Invest box moves with it', () => {
    const book = workbook();
    const p = plan(planInsert(book, boxFor(book, 'Income'), 'Bonus', 0));
    assert.equal(p.shift.row, 24);
    assert.equal(p.columns, 'B:D');
    const after = changed({ ok: true, plan: p });
    assert.equal(after['November!C29'], '=sum(C23:C28)');
    assert.equal(after['November!C14'], '=C29');
    assert.equal(after['November!C37'], '=sum(C34:C36)');
    assert.equal(after['Overview!B23'], '=November!D35');
    assert.equal(after['December!C8'], undefined); // D18 is above the shift
  });

  test('errors that already existed are carried, not blamed on the edit', () => {
    const book = workbook();
    const p = plan(planInsert(book, boxFor(book, 'Bills'), 'Water', null));
    assert.deepEqual([...p.knownErrors], ['Overview!C4']);
  });

  test('a formula the check cannot follow refuses the edit', () => {
    const book = workbook();
    book.tabs[0]!.cells[40] = ['=INDIRECT("November!N"&30)'];
    const result = planInsert(book, boxFor(book, 'Bills'), 'Water', null);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : '', /Overview!A41 .*INDIRECT/);
  });

  test('a range across the edge of the shifted columns refuses the edit', () => {
    const book = workbook();
    book.tabs[1]!.cells[49] = ['=sum(H21:M40)'];
    const result = planInsert(book, boxFor(book, 'Bills'), 'Water', null);
    assert.match(!result.ok ? result.message : '', /crosses the edge/);
  });

  test('a merged cell across the insert row refuses the edit', () => {
    const book = workbook();
    book.tabs[1]!.merges.push({ sheetId: 2, startRowIndex: 28, endRowIndex: 31, startColumnIndex: 13, endColumnIndex: 14 });
    const result = planInsert(book, boxFor(book, 'Bills'), 'Water', null);
    assert.match(!result.ok ? result.message : '', /merged cells N29:N31/);
  });

  test('a one-category box whose totals end at that category refuses', () => {
    const book = workbook();
    const box = boxFor(book, 'Liablities');
    box.categories = box.categories.slice(0, 1);
    book.tabs[1]!.cells[37]![11] = '=sum(L36:L36)';
    book.tabs[1]!.cells[37]![12] = '=sum(M36:M36)';
    const result = planInsert(book, box, 'Card', null);
    assert.match(!result.ok ? result.message : '', /can't be added inside the totals \(November!L38, November!M38\)/);
  });
});

describe('planDelete', () => {
  test('a category another tab points at is refused, naming the cell', () => {
    const book = workbook();
    const result = planDelete(book, boxFor(book, 'Expenses'), 'Food');
    assert.match(!result.ok ? result.message : '', /^Overview!B9 \(=November!H13\) refers to November!H13/);
  });

  test('a bill nothing points at is removed; totals shrink and cells below move up', () => {
    const book = workbook();
    const p = plan(planDelete(book, boxFor(book, 'Bills'), 'internet'));
    assert.equal(p.shift.row, 26);
    assert.deepEqual(p.removedCells, ['Internet', 18, 300, 300]);
    const after = changed({ ok: true, plan: p });
    assert.equal(after['November!M30'], '=sum(M21:M29)');
    assert.equal(after['Overview!B17'], '=November!N27');
    assert.equal(after['November!C17'], '=L37');
  });

  test('the row Left formula goes with the deleted row', () => {
    const book = workbook();
    const p = plan(planDelete(book, boxFor(book, 'Expenses'), 'Dining'));
    assert.equal(p.expected.get('November!I28'), '=SUM(I13:I27)'); // the total, was I29
    assert.equal(p.expected.get('November!I15'), '=IF(H15="";"";G15-H15)'); // Treats, was row 16
    assert.equal([...p.expected.values()].filter((f) => f.includes('H15=""')).length, 1);
  });

  test('the only category in a box cannot be removed', () => {
    const book = workbook();
    const result = planDelete(book, boxFor(book, 'Income'), 'Salary');
    assert.match(!result.ok ? result.message : '', /only category/);
  });
});
