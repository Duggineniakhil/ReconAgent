import { describe, it, expect } from 'vitest';
import { checkCommit, type CommitTarget } from '../src/agent/guardrails';

const target = (over: Partial<CommitTarget> = {}): CommitTarget => ({
  txn_id: 'TXN-1',
  utr_ref: 'REF-1',
  amount: 1000,
  ref_count: 1,
  matched_to: null,
  ...over,
});

describe('checkCommit', () => {
  it('accepts a clean, confident match', () => {
    expect(checkCommit(1000, 0.95, target(), 'TXN-1')).toEqual({ ok: true });
  });

  it('accepts a rounding difference within 1%', () => {
    expect(checkCommit(1000, 0.9, target({ amount: 995 }), 'TXN-1').ok).toBe(true);
  });

  it('rejects a transaction that does not exist', () => {
    const r = checkCommit(1000, 0.95, null, 'TXN-404');
    expect(r).toMatchObject({ ok: false, reason: 'unexplained_discrepancy' });
  });

  it('rejects confidence below 0.85', () => {
    expect(checkCommit(1000, 0.84, target(), 'TXN-1')).toMatchObject({ ok: false, reason: 'unexplained_discrepancy' });
  });

  it('rejects a non-numeric confidence', () => {
    expect(checkCommit(1000, NaN, target(), 'TXN-1').ok).toBe(false);
  });

  it('rejects a transaction already matched to another invoice', () => {
    const r = checkCommit(1000, 0.95, target({ matched_to: 'INV-9' }), 'TXN-1');
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous_candidates' });
  });

  it('rejects a duplicated reference', () => {
    const r = checkCommit(1000, 0.99, target({ ref_count: 2 }), 'TXN-1');
    expect(r).toMatchObject({ ok: false, reason: 'duplicate_reference' });
  });

  it('rejects an amount more than 1% off', () => {
    const r = checkCommit(1000, 0.99, target({ amount: 980 }), 'TXN-1');
    expect(r).toMatchObject({ ok: false, reason: 'unexplained_discrepancy' });
  });
});
