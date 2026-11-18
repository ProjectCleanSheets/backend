import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addToActual,
  currentActualAt,
  locateActualCell,
  SaveFlowError,
  type SheetConfig,
} from '../lib/saveflow';
import { DASHBOARD } from './fixtures/dashboard';
import { fakeSheets } from './fixtures/fakesheets';

const config: SheetConfig = {
  sheetId: 'sheet',
  columnMapping: {
    Income: { category_col: 'B', budget_col: 'C', actual_col: 'D' },
    Expenses: { category_col: 'F', budget_col: 'G', actual_col: 'H', left_col: 'I' },
    Bills: { category_col: 'F', budget_col: 'H', actual_col: 'I' },
  },
};

describe('currentActualAt', () => {
  test('a number is read as is; blank or text counts as 0', () => {
    const column = [[], [], [], [3120.75], ['n/a']];
    assert.equal(currentActualAt(column, 4), 3120.75);
    assert.equal(currentActualAt(column, 5), 0);
    assert.equal(currentActualAt(column, 9), 0);
  });
});

describe('locateActualCell', () => {
  test('finds the row and its current Actual in the mapped columns', async () => {
    const { sheets } = fakeSheets({ ...DASHBOARD });
    assert.deepEqual(await locateActualCell(sheets, config, 'November', 'Bills', 'Internet'), {
      row: 14,
      cell: 'I14',
      currentActual: 0,
    });
    assert.deepEqual(await locateActualCell(sheets, config, 'November', 'Expenses', 'groceries'), {
      row: 4,
      cell: 'H4',
      currentActual: 3120.75,
    });
  });

  test('Income resolves to its real box, not the Cash flow summary row', async () => {
    const { sheets } = fakeSheets({ ...DASHBOARD });
    const target = await locateActualCell(sheets, config, 'November', 'Income', 'Other');
    assert.equal(target.cell, 'D12');
  });

  test('an unknown category is CATEGORY_NOT_FOUND', async () => {
    const { sheets } = fakeSheets({ ...DASHBOARD });
    await assert.rejects(
      locateActualCell(sheets, config, 'November', 'Expenses', 'Rent'),
      (err: unknown) => err instanceof SaveFlowError && err.status === 404 && err.code === 'CATEGORY_NOT_FOUND',
    );
  });
});

describe('addToActual', () => {
  test('writes the rounded total to that one cell and returns it', async () => {
    const { sheets, writes } = fakeSheets({ ...DASHBOARD });
    const target = await locateActualCell(sheets, config, 'November', 'Expenses', 'Groceries');
    assert.equal(await addToActual(sheets, 'sheet', 'November', target, 195.32), 3316.07);
    assert.deepEqual(writes, [{ range: "'November'!H4", value: 3316.07 }]);
  });

  test('a negative amount undoes a save exactly', async () => {
    const { sheets } = fakeSheets({ ...DASHBOARD });
    const saved = await locateActualCell(sheets, config, 'November', 'Expenses', 'Groceries');
    await addToActual(sheets, 'sheet', 'November', saved, 0.1);
    const again = await locateActualCell(sheets, config, 'November', 'Expenses', 'Groceries');
    assert.equal(await addToActual(sheets, 'sheet', 'November', again, -0.1), 3120.75);
  });
});
