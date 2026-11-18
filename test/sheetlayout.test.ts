import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  columnIndex,
  columnLetter,
  detectSections,
  findCategoryRow,
  scanSection,
} from '../lib/sheetlayout';
import { DASHBOARD, toColumn, toGrid } from './fixtures/dashboard';

const F = toColumn(DASHBOARD, 'F');
const H = toColumn(DASHBOARD, 'H');
const I = toColumn(DASHBOARD, 'I');
const B = toColumn(DASHBOARD, 'B');
const D = toColumn(DASHBOARD, 'D');

describe('columnLetter / columnIndex', () => {
  test('round-trip single letters', () => {
    assert.equal(columnLetter(0), 'A');
    assert.equal(columnLetter(25), 'Z');
    assert.equal(columnIndex('F'), 5);
    assert.equal(columnIndex(columnLetter(7)), 7);
  });
});

describe('scanSection', () => {
  test('reads a box under a merged banner and finds its first free row', () => {
    const scan = scanSection(F, 'Expenses', ['Bills', 'Liabilities'], H);
    assert.deepEqual(scan, {
      categories: [
        { row: 4, name: 'Groceries' },
        { row: 5, name: 'Transport' },
        { row: 6, name: 'Eating out' },
      ],
      freeRow: 7,
    });
  });

  test('a box followed directly by another box has no free row', () => {
    const scan = scanSection(F, 'Bills', ['Expenses', 'Liabilities'], I);
    assert.deepEqual(scan, {
      categories: [
        { row: 13, name: 'Rent' },
        { row: 14, name: 'Internet' },
      ],
      freeRow: null,
    });
  });

  test('a box ends at the end of the read', () => {
    const scan = scanSection(F, 'Liabilities', ['Expenses', 'Bills'], I);
    assert.deepEqual(scan?.categories, [{ row: 17, name: 'Student loan' }]);
  });

  test('the value column skips a summary row labelled like the section', () => {
    const scan = scanSection(B, 'Income', ['Expenses'], D);
    assert.deepEqual(scan, {
      categories: [
        { row: 11, name: 'Salary' },
        { row: 12, name: 'Other' },
      ],
      freeRow: null,
    });
  });

  test('without the value column it anchors on the summary row', () => {
    const scan = scanSection(B, 'Income', ['Expenses']);
    assert.deepEqual(scan?.categories.map((c) => c.name), ['Invest', 'Bills & Expenses']);
  });

  test('section names match case- and space-insensitively', () => {
    assert.ok(scanSection(F, '  expenses ', [], H));
  });

  test('a missing section is null', () => {
    assert.equal(scanSection(F, 'Savings', [], H), null);
  });

  test('a stop name ends the box even without a blank row', () => {
    const column = toColumn({ F1: 'Expenses', F2: 'Food', F3: 'Fun', F4: 'Bills' }, 'F');
    assert.deepEqual(
      scanSection(column, 'Expenses', ['Bills'])?.categories.map((c) => c.name),
      ['Food', 'Fun'],
    );
  });

  test('up to four blank rows may sit between the title and the first category', () => {
    const column = toColumn({ F1: 'Expenses', F6: 'Food' }, 'F');
    assert.deepEqual(scanSection(column, 'Expenses', [])?.categories, [{ row: 6, name: 'Food' }]);
    const tooFar = toColumn({ F1: 'Expenses', F7: 'Food' }, 'F');
    assert.deepEqual(scanSection(tooFar, 'Expenses', [])?.categories, []);
  });
});

describe('findCategoryRow', () => {
  test('finds a category by name inside its own box only', () => {
    assert.equal(findCategoryRow(F, 'Expenses', 'transport', ['Bills'], H), 5);
    assert.equal(findCategoryRow(F, 'Expenses', 'Rent', ['Bills'], H), null);
    assert.equal(findCategoryRow(F, 'Bills', 'Rent', ['Expenses', 'Liabilities'], I), 13);
  });
});

describe('detectSections', () => {
  const sections = detectSections(toGrid(DASHBOARD));

  test('finds every box, side by side and stacked', () => {
    assert.deepEqual(
      sections.map((s) => s.name),
      ['Cash flow', 'Expenses', 'Income', 'Bills', 'Liabilities'],
    );
  });

  test('takes columns from the header row, with the title anchoring the names', () => {
    const bills = sections.find((s) => s.name === 'Bills');
    assert.deepEqual(bills?.columns, { category: 'F', budget: 'H', actual: 'I', left: null });
    const expenses = sections.find((s) => s.name === 'Expenses');
    assert.deepEqual(expenses?.columns, { category: 'F', budget: 'G', actual: 'H', left: 'I' });
  });

  test('reads categories with numbers, blanks as null', () => {
    const expenses = sections.find((s) => s.name === 'Expenses');
    assert.deepEqual(expenses?.categories, [
      { name: 'Groceries', budget: 4000, actual: 3120.75 },
      { name: 'Transport', budget: 800, actual: 640 },
      { name: 'Eating out', budget: 1200, actual: null },
    ]);
  });

  test('a box stops at the next box title even without a blank row', () => {
    const bills = sections.find((s) => s.name === 'Bills');
    assert.deepEqual(bills?.categories.map((c) => c.name), ['Rent', 'Internet']);
  });

  test('stops at Total', () => {
    const income = sections.find((s) => s.name === 'Income');
    assert.deepEqual(income?.categories.map((c) => c.name), ['Salary', 'Other']);
  });

  test('falls back to known section names in the default columns', () => {
    const plain = detectSections(toGrid({ F1: 'Expenses', F2: 'Food', G2: 100, H2: 40 }));
    assert.deepEqual(plain, [
      {
        name: 'Expenses',
        columns: { category: 'F', budget: 'G', actual: 'H', left: 'I' },
        categories: [{ name: 'Food', budget: 100, actual: 40 }],
      },
    ]);
  });
});

// The two readers disagree here. Pinned as they are today so task 39 moves them
// unchanged; task 32 decides which rule wins.
describe('detectSections vs scanSection differences', () => {
  test('a blank row between header and first category: onboarding sees none, saves see it', () => {
    const cells = { F1: 'Expenses', G2: 'Budget', H2: 'Actual', F4: 'Food', G4: 100 };
    const onboarding = detectSections(toGrid(cells)).find((s) => s.name === 'Expenses');
    assert.deepEqual(onboarding?.categories, []);
    const saves = scanSection(toColumn(cells, 'F'), 'Expenses', [], toColumn(cells, 'H'));
    assert.deepEqual(saves?.categories, [{ row: 4, name: 'Food' }]);
  });

  test('a summary row labelled like the section: onboarding lists it as its own box', () => {
    const names = detectSections(toGrid(DASHBOARD)).map((s) => s.name);
    assert.ok(names.includes('Cash flow'));
  });
});
