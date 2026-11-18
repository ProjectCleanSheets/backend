import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { buildBudgetOverview, type ResolvedSection } from '../api/sheet/budget';
import { buildLogMatcher, LOG_HEADER, parseLogRows } from '../lib/logtab';
import { findMonthTab, resolveColumns, roundAmount, SaveFlowError } from '../lib/saveflow';
import { DASHBOARD, toColumn } from './fixtures/dashboard';

describe('parseLogRows', () => {
  test('skips the header and blank rows, keeps 1-based row numbers', () => {
    const entries = parseLogRows([
      [...LOG_HEADER],
      ['tx1', 'Expenses', 'Food', 12.5, '2026-11-01', 'booked', '2026-11-02T10:00:00Z'],
      [],
      [4711, ' Bills ', 'Rent', 9000, '2026-11-01', 'PENDING'],
    ]);
    assert.deepEqual(entries, [
      { rowNumber: 2, transactionId: 'tx1', section: 'Expenses', category: 'Food', amount: 12.5, date: '2026-11-01', status: 'booked' },
      { rowNumber: 4, transactionId: '4711', section: 'Bills', category: 'Rent', amount: 9000, date: '2026-11-01', status: 'pending' },
    ]);
  });

  test('a non-numeric amount is null', () => {
    assert.equal(parseLogRows([['tx', 'S', 'C', 'abc', '2026-11-01', 'booked']])[0]?.amount, null);
  });
});

describe('buildLogMatcher', () => {
  const entries = parseLogRows([
    ['split', 'Bills', 'Rent', 9000, '2026-11-01', 'booked'],
    ['pend', 'Expenses', 'Food', 50, '2026-11-03', 'pending'],
    ['legacy', 'Expenses', 'Food'],
  ]);
  const saved = buildLogMatcher(entries);

  test('a booked save matches on id + amount + date', () => {
    assert.equal(saved({ id: 'split', amount: 9000, date: '2026-11-01' }), true);
  });

  test('amounts compare by absolute value at two decimals', () => {
    assert.equal(saved({ id: 'split', amount: -9000.001, date: '2026-11-01' }), true);
  });

  test('another line of a split payment with the same id is not a duplicate', () => {
    assert.equal(saved({ id: 'split', amount: 450, date: '2026-11-01' }), false);
    assert.equal(saved({ id: 'split', amount: 9000, date: '2026-11-02' }), false);
  });

  test('a pending save matches on id alone, so it stays saved once it books', () => {
    assert.equal(saved({ id: 'pend', amount: 52.1, date: '2026-11-05' }), true);
  });

  test('a row missing amount, date or status falls back to id only', () => {
    assert.equal(saved({ id: 'legacy', amount: 1, date: '2026-01-01' }), true);
  });

  test('an unknown id is not saved', () => {
    assert.equal(saved({ id: 'new', amount: 9000, date: '2026-11-01' }), false);
  });
});

describe('resolveColumns', () => {
  test('an unmapped section gets the default F/G/H/I layout', () => {
    assert.deepEqual(resolveColumns({ Bills: {} }, 'Expenses'), {
      categoryCol: 'F',
      budgetCol: 'G',
      actualCol: 'H',
      leftCol: 'I',
      otherSections: ['Bills'],
    });
  });

  test('a mapped section uses its own columns and leaves unmapped ones null', () => {
    const mapping = { Expenses: { category_col: 'F', actual_col: 'H' }, Bills: { actual_col: 'I' } };
    assert.deepEqual(resolveColumns(mapping, ' expenses '), {
      categoryCol: 'F',
      budgetCol: null,
      actualCol: 'H',
      leftCol: null,
      otherSections: ['Bills'],
    });
  });

  test('a corrupt stored column is refused before it reaches a range', () => {
    assert.throws(
      () => resolveColumns({ Expenses: { actual_col: 'H1:Z9' } }, 'Expenses'),
      (err: unknown) => err instanceof SaveFlowError && err.status === 500 && err.code === 'SUPABASE_ERROR',
    );
  });
});

describe('findMonthTab', () => {
  afterEach(() => mock.timers.reset());

  test('matches the current English month name, ignoring case and spaces', () => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-18T12:00:00Z') });
    const tabs = [{ title: 'October', tabId: 1 }, { title: ' november ', tabId: 2 }];
    assert.equal(findMonthTab(tabs).tabId, 2);
  });

  test('no tab for this month is SHEET_NOT_FOUND', () => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-01T12:00:00Z') });
    assert.throws(
      () => findMonthTab([{ title: 'November', tabId: 2 }]),
      (err: unknown) => err instanceof SaveFlowError && err.status === 404 && err.code === 'SHEET_NOT_FOUND',
    );
  });
});

describe('roundAmount', () => {
  test('removes float artefacts at two decimals', () => {
    assert.equal(roundAmount(0.1 + 0.2), 0.3);
    assert.equal(roundAmount(195.32000000000001), 195.32);
  });
});

describe('buildBudgetOverview', () => {
  const columnData = new Map(['B', 'C', 'D', 'F', 'G', 'H', 'I'].map((l) => [l, toColumn(DASHBOARD, l)]));
  const mapping = {
    Income: { category_col: 'B', budget_col: 'C', actual_col: 'D' },
    Expenses: { category_col: 'F', budget_col: 'G', actual_col: 'H' },
    Bills: { category_col: 'F', budget_col: 'H', actual_col: 'I' },
    Savings: { category_col: 'K', actual_col: 'L' },
  };
  const resolved: ResolvedSection[] = Object.keys(mapping).map((name) => ({
    name,
    columns: resolveColumns(mapping, name),
  }));
  const overview = buildBudgetOverview(resolved, columnData);

  test('a mapped section missing from the tab is skipped', () => {
    assert.deepEqual(overview.sections.map((s) => s.name), ['Income', 'Expenses', 'Bills']);
  });

  test('per-section totals count blanks as 0', () => {
    const expenses = overview.sections.find((s) => s.name === 'Expenses');
    assert.deepEqual(expenses?.totals, { budget: 6000, actual: 3760.75 });
    assert.equal(expenses?.categories[2]?.actual, null);
  });

  test('Income reads its real box, not the Cash flow summary row', () => {
    const income = overview.sections.find((s) => s.name === 'Income');
    assert.deepEqual(income?.categories.map((c) => c.name), ['Salary', 'Other']);
  });

  test('grand totals leave Income out', () => {
    assert.deepEqual(overview.totals, { budget: 6000 + 9299, actual: 3760.75 + 9000 });
  });
});
