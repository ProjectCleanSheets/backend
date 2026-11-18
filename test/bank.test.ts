import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeBankStatus } from '../api/auth/bank';
import { toQueueTransaction } from '../api/transactions';
import { MS_PER_DAY } from '../lib/constants';
import type { EnableBankingTransaction } from '../lib/enablebanking';
import { toWholeSecondISO } from '../lib/time';

describe('computeBankStatus', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const at = (ms: number) => new Date(ms).toISOString();

  test('never connected is expired with no date', () => {
    assert.deepEqual(computeBankStatus(null, now), { status: 'expired', expiresAt: null, renewAvailable: true });
  });

  test('expiring exactly now is expired', () => {
    assert.equal(computeBankStatus(at(now), now).status, 'expired');
  });

  test('14 days out is expiring, a second more is healthy', () => {
    assert.equal(computeBankStatus(at(now + 14 * MS_PER_DAY), now).status, 'expiring');
    const healthy = computeBankStatus(at(now + 14 * MS_PER_DAY + 1000), now);
    assert.equal(healthy.status, 'healthy');
    assert.equal(healthy.renewAvailable, false);
  });

  test('the date goes out at whole seconds', () => {
    assert.equal(computeBankStatus('2026-12-30T09:30:12.473Z', now).expiresAt, '2026-12-30T09:30:12Z');
  });

  test('an unparseable stored date is expired', () => {
    assert.deepEqual(computeBankStatus('soon', now), { status: 'expired', expiresAt: null, renewAvailable: true });
  });
});

describe('toQueueTransaction', () => {
  const base: EnableBankingTransaction = {
    entry_reference: 'ref1',
    transaction_id: 'tid1',
    transaction_amount: { currency: 'DKK', amount: '-195.32' },
    creditor: { name: ' Netto ' },
    debtor: { name: 'Me' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-11-17',
    transaction_date: '2026-11-15',
    remittance_information: ['NETTO 1234'],
  };

  test('a booked debit: positive amount, creditor as merchant', () => {
    assert.deepEqual(toQueueTransaction(base), {
      id: 'ref1',
      merchant: 'Netto',
      amount: 195.32,
      currency: 'DKK',
      date: '2026-11-17',
      direction: 'debit',
      status: 'booked',
    });
  });

  test('a credit takes the debtor as merchant', () => {
    assert.equal(toQueueTransaction({ ...base, credit_debit_indicator: 'CRDT' })?.merchant, 'Me');
  });

  test('pending maps to pending; other statuses are dropped', () => {
    assert.equal(toQueueTransaction({ ...base, status: 'PDNG' })?.status, 'pending');
    assert.equal(toQueueTransaction({ ...base, status: 'CNCL' }), null);
    assert.equal(toQueueTransaction({ ...base, status: null }), null);
  });

  test('the id falls back to transaction_id; no id at all is dropped', () => {
    assert.equal(toQueueTransaction({ ...base, entry_reference: null })?.id, 'tid1');
    assert.equal(toQueueTransaction({ ...base, entry_reference: '', transaction_id: null }), null);
  });

  test('a non-numeric amount is dropped', () => {
    assert.equal(toQueueTransaction({ ...base, transaction_amount: { amount: 'n/a' } }), null);
  });

  test('merchant falls back to remittance text, then Unknown', () => {
    assert.equal(toQueueTransaction({ ...base, creditor: null })?.merchant, 'NETTO 1234');
    assert.equal(
      toQueueTransaction({ ...base, creditor: { name: '  ' }, remittance_information: [null, ' '] })?.merchant,
      'Unknown',
    );
  });

  test('date falls back from booking to transaction to value date', () => {
    assert.equal(toQueueTransaction({ ...base, booking_date: null })?.date, '2026-11-15');
    assert.equal(
      toQueueTransaction({ ...base, booking_date: null, transaction_date: null, value_date: '2026-11-16' })?.date,
      '2026-11-16',
    );
  });
});

describe('toWholeSecondISO', () => {
  test('drops milliseconds and the .000', () => {
    assert.equal(toWholeSecondISO('2026-09-11T20:14:03.000Z'), '2026-09-11T20:14:03Z');
    assert.equal(toWholeSecondISO(new Date('2026-09-11T20:14:03.999Z')), '2026-09-11T20:14:03Z');
  });

  test('normalises offsets to UTC', () => {
    assert.equal(toWholeSecondISO('2026-09-11T22:14:03+02:00'), '2026-09-11T20:14:03Z');
  });

  test('missing or unparseable is empty', () => {
    assert.equal(toWholeSecondISO(null), '');
    assert.equal(toWholeSecondISO(undefined), '');
    assert.equal(toWholeSecondISO('not a date'), '');
  });
});
