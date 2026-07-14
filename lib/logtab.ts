import type { CellValue } from './sheets';

// The hidden `_log` tab is the dedup source of truth (product spec §7b): one
// row per saved transaction. The save endpoint and the transaction-queue
// filter must apply identical matching rules, so both read the tab through
// this module.

export const LOG_TAB = '_log';

// Columns A..G. `date` is the bank transaction's date (part of the dedup
// key), `savedAt` the ISO timestamp of the save itself.
export const LOG_HEADER = [
  'transactionId',
  'section',
  'category',
  'amount',
  'date',
  'status',
  'savedAt',
] as const;

export const LOG_RANGE = 'A1:G10000';

export interface LogEntry {
  rowNumber: number; // 1-based sheet row
  transactionId: string;
  section: string;
  category: string;
  amount: number | null;
  date: string;
  status: string;
}

function text(cell: CellValue | undefined): string {
  if (typeof cell === 'string') {
    return cell.trim();
  }
  // UNFORMATTED_VALUE returns purely numeric ids as numbers.
  if (typeof cell === 'number') {
    return String(cell);
  }
  return '';
}

/** Parses raw `_log` rows; blank rows and the header row are skipped. */
export function parseLogRows(rows: CellValue[][]): LogEntry[] {
  const entries: LogEntry[] = [];
  rows.forEach((row, index) => {
    const transactionId = text(row[0]);
    // A bank id can never equal the literal header label.
    if (!transactionId || transactionId === LOG_HEADER[0]) {
      return;
    }
    entries.push({
      rowNumber: index + 1,
      transactionId,
      section: text(row[1]),
      category: text(row[2]),
      amount: typeof row[3] === 'number' && Number.isFinite(row[3]) ? row[3] : null,
      date: text(row[4]),
      status: text(row[5]).toLowerCase(),
    });
  });
  return entries;
}

// Banks reuse one entry_reference across split transaction lines (e.g. a rent
// payment split into Husleje/El/TV rows), so booked saves match on the strict
// triple id + amount + date (owner-approved 2026-07-12). Rows saved while the
// transaction was still pending match on id alone: a pending transaction can
// keep its id but change amount/date when it books, and a strict triple would
// resurface it as new — reintroducing the double-count. Legacy/malformed rows
// missing amount, date, or status also fall back to id-only (the safe side).
// Amounts compare by absolute value: the queue reports positive amounts with
// a separate direction, saves may carry a sign.
export function buildLogMatcher(
  entries: LogEntry[],
): (tx: { id: string; amount: number; date: string }) => boolean {
  const idOnly = new Set<string>();
  const bookedTriples = new Set<string>();
  for (const entry of entries) {
    if (entry.status === 'booked' && entry.amount !== null && entry.date !== '') {
      bookedTriples.add(tripleKey(entry.transactionId, entry.amount, entry.date));
    } else {
      idOnly.add(entry.transactionId);
    }
  }
  return (tx) => idOnly.has(tx.id) || bookedTriples.has(tripleKey(tx.id, tx.amount, tx.date));
}

// NUL separator: cannot occur inside an id, amount, or date.
function tripleKey(id: string, amount: number, date: string): string {
  return `${id}\u0000${Math.abs(amount).toFixed(2)}\u0000${date}`;
}
