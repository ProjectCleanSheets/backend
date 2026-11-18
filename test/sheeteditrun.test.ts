import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SaveFlowError } from '../lib/saveflow';
import { formulaMap } from '../lib/sheetedit';
import { deleteCategoryRow, insertCategoryRow } from '../lib/sheeteditrun';
import { simSheets } from './fixtures/simsheets';
import { boxFor, trimmed, workbook } from './fixtures/workbook';

const month = (sim: ReturnType<typeof simSheets>) => sim.snapshot().tabs.find((t) => t.title === 'November')!;
const at = (sim: ReturnType<typeof simSheets>, ref: string) => {
  const m = /^([A-Z])(\d+)$/.exec(ref)!;
  return month(sim).cells[Number(m[2]) - 1]?.[m[1]!.charCodeAt(0) - 65];
};

describe('insertCategoryRow', () => {
  test('adds a bill inside the totals; every formula reads as planned', async () => {
    const book = workbook();
    const sim = simSheets(book);
    const summary = await insertCategoryRow(sim.sheets, 'id', boxFor(book, 'Bills'), 'Water', 120);
    assert.deepEqual([summary.tab, summary.row, summary.columns], ['November', 30, 'K:N']);
    assert.deepEqual([at(sim, 'K30'), at(sim, 'M30'), at(sim, 'N30')], ['Water', 120, '']);
    assert.deepEqual([at(sim, 'K31'), at(sim, 'K32')], ['Software', 'Total']);
    assert.equal(at(sim, 'M32'), '=sum(M21:M31)');
    assert.equal(at(sim, 'C16'), '=G29+M32');
    // Cash flow and Expenses beside the bills did not move.
    assert.deepEqual([at(sim, 'B30'), at(sim, 'F29')], [' Save & Invest', 'Total']);
  });

  test('a dry run reports the plan and changes nothing', async () => {
    const book = workbook();
    const sim = simSheets(book);
    const summary = await insertCategoryRow(sim.sheets, 'id', boxFor(book, 'Expenses'), 'Pets', null, true);
    assert.equal(summary.row, 24);
    assert.ok(summary.formulasChanged.some((c) => c.cell === 'November!G30' && c.after === '=sum(G13:G29)'));
    assert.equal(sim.batchUpdates(), 0);
  });

  test('when Sheets rewrites a formula differently, the edit is undone and nothing is left changed', async () => {
    const book = workbook();
    const original = formulaMap(book.tabs);
    const sim = simSheets(book, {
      misbehave: (tab, formula) => (tab === 'Overview' ? formula.replace('M34', 'M33') : formula),
    });
    await assert.rejects(
      insertCategoryRow(sim.sheets, 'id', boxFor(book, 'Bills'), 'Water', null),
      (err: unknown) =>
        err instanceof SaveFlowError && err.status === 409 && /Overview!B16 reads =NOVEMBER!M33/.test(err.message),
    );
    assert.deepEqual(formulaMap(sim.snapshot().tabs), original);
    assert.deepEqual(trimmed(month(sim).cells), trimmed(book.tabs[1]!.cells));
  });

  test('an edit the plan refuses never reaches Sheets', async () => {
    const book = workbook();
    book.tabs[0]!.cells[40] = ['=OFFSET(November!N30;0;0)'];
    const sim = simSheets(book);
    await assert.rejects(
      insertCategoryRow(sim.sheets, 'id', boxFor(book, 'Bills'), 'Water', null),
      (err: unknown) => err instanceof SaveFlowError && err.status === 409 && /OFFSET/.test(err.message),
    );
    assert.equal(sim.batchUpdates(), 0);
  });
});

describe('deleteCategoryRow', () => {
  test('removes a bill; totals shrink; Overview follows the bill below it', async () => {
    const book = workbook();
    const sim = simSheets(book);
    await deleteCategoryRow(sim.sheets, 'id', boxFor(book, 'Bills'), 'Internet');
    assert.deepEqual([at(sim, 'K26'), at(sim, 'K30')], ['Music', 'Total']);
    assert.equal(at(sim, 'N30'), '=sum(N21:N29)');
    const overview = sim.snapshot().tabs.find((t) => t.title === 'Overview')!;
    assert.equal(overview.cells[16]?.[1], '=November!N27');
  });

  test('a failed delete puts the row and its values back', async () => {
    const book = workbook();
    const original = formulaMap(book.tabs);
    const sim = simSheets(book, { misbehave: (tab, f) => (tab === 'November' ? f.replace('N29', 'N28') : f) });
    await assert.rejects(
      deleteCategoryRow(sim.sheets, 'id', boxFor(book, 'Bills'), 'Internet'),
      (err: unknown) => err instanceof SaveFlowError && err.status === 409,
    );
    assert.deepEqual([at(sim, 'K26'), at(sim, 'L26'), at(sim, 'M26'), at(sim, 'N26')], ['Internet', 18, 300, 300]);
    assert.deepEqual(formulaMap(sim.snapshot().tabs), original);
  });
});
