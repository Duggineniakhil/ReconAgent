import { describe, it, expect } from 'vitest';
import {
  parseCsvRows,
  parseAmount,
  parseDate,
  suggestMapping,
  mapRows,
  findDuplicates,
  LEDGER_FIELDS,
  BANK_FIELDS,
} from '../src/services/csv_import';

describe('parseCsvRows', () => {
  it('handles quoted newlines, a BOM and blank lines', () => {
    const rows = parseCsvRows('\uFEFFid,note\n1,"line one\nline two"\n\n2,plain\n');
    expect(rows).toEqual([['id', 'note'], ['1', 'line one\nline two'], ['2', 'plain']]);
  });

  it('keeps a final row with no trailing newline', () => {
    expect(parseCsvRows('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parseAmount', () => {
  it.each([
    ['1234.5', 1234.5],
    ['₹1,23,456.70', 123456.7],
    ['Rs. 500', 500],
    ['INR 1,000.00', 1000],
    ['(250.00)', -250],
    ['-99.999', -100],
    ['1,000 Cr', 1000],
    ['1,000 Dr', -1000],
  ])('parses %s', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });

  it.each(['', 'abc', '12.3.4', '1e5'])('rejects %j', (raw) => {
    expect(parseAmount(raw)).toBeNull();
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-08-07', 'auto', '2026-08-07'],
    ['2026/8/7', 'auto', '2026-08-07'],
    ['07/08/2026', 'auto', '2026-08-07'],
    ['07-08-26', 'auto', '2026-08-07'],
    ['08/07/2026', 'MDY', '2026-08-07'],
    ['07-Aug-2026', 'auto', '2026-08-07'],
    ['7 August 2026', 'auto', '2026-08-07'],
    ['07/08/2026 14:32:00', 'auto', '2026-08-07'],
    ['2026-08-07T10:00:00Z', 'auto', '2026-08-07'],
  ] as const)('parses %s (%s)', (raw, format, expected) => {
    expect(parseDate(raw, format)).toBe(expected);
  });

  it.each(['31/02/2026', '2026-13-01', 'yesterday', '07-Foo-2026'])('rejects %s', (raw) => {
    expect(parseDate(raw)).toBeNull();
  });
});

describe('suggestMapping', () => {
  it('maps a typical bank statement export', () => {
    const headers = ['Value Date', 'Narration', 'Chq/Ref No', 'Withdrawal Amt', 'Deposit Amt', 'Closing Balance'];
    expect(suggestMapping(headers, BANK_FIELDS)).toEqual({
      txn_id: null,
      utr_ref: 'Chq/Ref No',
      amount: 'Deposit Amt',
      txn_date: 'Value Date',
      payer_name: 'Narration',
      status: null,
    });
  });

  it('ignores punctuation in headers', () => {
    const mapping = suggestMapping(['Date', 'Narration', 'Chq./Ref.No.', 'Deposit Amt.'], BANK_FIELDS);
    expect(mapping).toMatchObject({ utr_ref: 'Chq./Ref.No.', amount: 'Deposit Amt.' });
  });

  it('maps our own column names exactly', () => {
    const headers = ['invoice_id', 'customer_name', 'amount', 'invoice_date', 'payment_ref'];
    const mapping = suggestMapping(headers, LEDGER_FIELDS);
    for (const h of headers) expect(mapping[h]).toBe(h);
  });

  it('never assigns one header to two fields', () => {
    const mapping = suggestMapping(['Date', 'Name', 'Amount'], BANK_FIELDS);
    const used = Object.values(mapping).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('mapRows', () => {
  const mapping = {
    invoice_id: 'Inv', customer_name: 'Party', amount: 'Total', invoice_date: 'Date', payment_ref: null,
  };

  it('converts values and reports bad rows with their line numbers', () => {
    const { records, errors } = mapRows([
      { Inv: 'A-1', Party: 'Acme', Total: '₹1,000', Date: '07/08/2026' },
      { Inv: 'A-2', Party: '', Total: 'ten', Date: '2026-02-30' },
    ], mapping, LEDGER_FIELDS);

    expect(records[0]).toEqual({
      invoice_id: 'A-1', customer_name: 'Acme', amount: 1000, invoice_date: '2026-08-07', payment_ref: null,
    });
    expect(errors.map((e) => [e.row, e.field])).toEqual([
      [3, 'customer_name'], [3, 'amount'], [3, 'invoice_date'],
    ]);
  });

  it('skips rows with an empty skipIfEmpty field and keeps original line numbers', () => {
    const bankMapping = { txn_id: null, utr_ref: null, amount: 'Deposit', txn_date: 'Date', payer_name: 'Narration', status: null };
    const { records, errors, skipped } = mapRows([
      { Date: '01/09/26', Narration: 'NEFT ACME', Deposit: '1,000.00' },
      { Date: '02/09/26', Narration: 'ELECTRICITY BILL', Deposit: '' },
      { Date: 'bad', Narration: 'NEFT BETA', Deposit: '50' },
    ], bankMapping, BANK_FIELDS, 'auto', 'amount');

    expect(skipped).toBe(1);
    expect(records).toHaveLength(2);
    expect(errors).toEqual([expect.objectContaining({ row: 4, field: 'txn_date' })]);
  });

  it('requires every required field to be mapped', () => {
    const { errors } = mapRows([], { ...mapping, amount: null }, LEDGER_FIELDS);
    expect(errors).toEqual([expect.objectContaining({ field: 'amount', row: 1 })]);
  });
});

describe('findDuplicates', () => {
  it('points at the first occurrence', () => {
    const errors = findDuplicates([{ id: 'X' }, { id: 'Y' }, { id: 'X' }], 'id', 'Invoice ID');
    expect(errors).toEqual([{ row: 4, field: 'id', message: 'Invoice ID "X" duplicates row 2' }]);
  });
});
