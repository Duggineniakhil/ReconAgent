import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import {
  fetchSettlements, fetchSettlementLines, fetchGatewayFees, fetchRazorpayStatus, syncRazorpay, apiError,
} from '../api';
import type { Settlement, SettlementLine, SettlementStatus, FeeSummary } from '../api';
import { cn, inr, formatPercent, btnSecondary } from '../lib/format';

const STATUS_STYLES: Record<SettlementStatus | 'pending', string> = {
  matched: 'bg-accent-matched/10 text-accent-matched',
  mismatch: 'bg-accent-error/10 text-accent-error',
  missing: 'bg-accent-exception/10 text-accent-exception',
  pending: 'bg-surface-raised text-text-muted',
};

const SettlementBadge = ({ status }: { status: SettlementStatus | null }) => (
  <span className={cn('px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider', STATUS_STYLES[status ?? 'pending'])}>
    {status ?? 'not reconciled'}
  </span>
);

/** Razorpay settlements: fees and GST, each payout with its bank credit, and API sync. */
export const SettlementsView = () => {
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [fees, setFees] = useState<FeeSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [s, f] = await Promise.all([fetchSettlements(), fetchGatewayFees()]);
      setSettlements(s);
      setFees(f);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => { load(); }, []);

  if (!loaded) return <div className="text-text-muted mt-8 text-sm">Loading settlements…</div>;

  const pending = settlements.filter((s) => !s.outcome).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold font-serif text-text">Razorpay Settlements</h2>
          <p className="text-sm text-text-muted mt-1">
            Razorpay pays out many payments as one bank credit, net of fees, GST and refunds. Each settlement is
            checked against the bank credit with its UTR.
          </p>
        </div>
        <RazorpaySync onSynced={load} />
      </div>

      {error && <p className="text-sm text-accent-error">{error}</p>}

      {fees && fees.total.payments > 0 && <FeeCards fees={fees} />}

      {pending > 0 && (
        <p className="text-xs text-text-muted">
          {pending} settlement{pending === 1 ? ' is' : 's are'} not reconciled yet. Start a run on the dashboard to check them.
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border/50 bg-surface/50 backdrop-blur-md">
        <table className="w-full text-left text-sm text-text">
          <thead className="bg-surface-raised text-text-muted font-medium text-xs">
            <tr>
              <th className="px-4 py-2 font-normal w-6"></th>
              <th className="px-4 py-2 font-normal">Settlement</th>
              <th className="px-4 py-2 font-normal">Settled</th>
              <th className="px-4 py-2 font-normal text-right">Payments</th>
              <th className="px-4 py-2 font-normal text-right">Gross</th>
              <th className="px-4 py-2 font-normal text-right">Fees + GST</th>
              <th className="px-4 py-2 font-normal text-right">Refunds</th>
              <th className="px-4 py-2 font-normal text-right">Expected</th>
              <th className="px-4 py-2 font-normal text-right">Bank credit</th>
              <th className="px-4 py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {settlements.map((s, i) => {
              const isOpen = expanded === s.settlement_id;
              const diff = s.outcome?.difference;
              return (
                <Fragment key={s.settlement_id}>
                  <tr
                    onClick={() => setExpanded(isOpen ? null : s.settlement_id)}
                    className={cn('hover:bg-surface transition-colors cursor-pointer', i % 2 === 0 ? 'bg-surface/80' : 'bg-base/60')}
                  >
                    <td className="px-4 py-1.5 text-text-muted">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td className="px-4 py-1.5 font-mono text-xs">
                      {s.settlement_id}
                      <div className="text-text-muted text-[10px]">UTR {s.settlement_utr ?? '—'}</div>
                    </td>
                    <td className="px-4 py-1.5 font-mono text-xs">{s.settled_at ?? '—'}</td>
                    <td className="px-4 py-1.5 font-mono text-xs text-right">{s.payment_count}</td>
                    <td className="px-4 py-1.5 font-mono text-xs text-right">{inr.format(s.gross)}</td>
                    <td className="px-4 py-1.5 font-mono text-xs text-right text-text-muted">−{inr.format(s.fees)}</td>
                    <td className="px-4 py-1.5 font-mono text-xs text-right text-text-muted">{s.refunds ? `−${inr.format(s.refunds)}` : '—'}</td>
                    <td className="px-4 py-1.5 font-mono text-xs text-right">{inr.format(s.net)}</td>
                    <td className="px-4 py-1.5 font-mono text-xs text-right">
                      {s.outcome?.bank_amount != null ? inr.format(s.outcome.bank_amount) : '—'}
                      {diff ? (
                        <div className="text-accent-error text-[10px]">{diff > 0 ? '+' : '−'}{inr.format(Math.abs(diff))}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-1.5"><SettlementBadge status={s.outcome?.status ?? null} /></td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-base/60">
                      <td colSpan={10} className="px-10 py-4">
                        <SettlementDetail settlement={s} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {settlements.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-text-muted bg-surface/80">
                  No gateway settlements in this dataset. Load the demo data or sync from Razorpay.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const FeeCards = ({ fees }: { fees: FeeSummary }) => (
  <div className="grid md:grid-cols-[repeat(4,minmax(0,1fr))_2fr] bg-surface/80 backdrop-blur-md border border-border/50 rounded-md divide-y md:divide-y-0 md:divide-x divide-border/50">
    <Stat label="Collected via Razorpay" value={inr.format(fees.total.gross)} note={`${fees.total.payments} payments`} />
    <Stat label="Gateway fees" value={inr.format(fees.total.fees)} note="Including GST on fees" />
    <Stat label="GST on fees" value={inr.format(fees.total.tax)} note="Claimable as input tax credit" />
    <Stat label="Effective rate" value={formatPercent(fees.total.effective_rate)} note="Fees ÷ gross" />
    <div className="p-4">
      <p className="text-xs text-text-muted mb-2">By payment method</p>
      <table className="w-full text-xs font-mono">
        <tbody>
          {fees.by_method.map((m) => (
            <tr key={m.method}>
              <td className="py-0.5 font-sans text-text-muted capitalize">{m.method}</td>
              <td className="py-0.5 text-right">{m.payments}</td>
              <td className="py-0.5 text-right">{inr.format(m.fees)}</td>
              <td className="py-0.5 text-right">{formatPercent(m.effective_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

const Stat = ({ label, value, note }: { label: string; value: string; note: string }) => (
  <div className="p-4 flex flex-col justify-center">
    <span className="text-xs text-text-muted mb-1">{label}</span>
    <span className="text-2xl font-mono font-bold text-text">{value}</span>
    <span className="text-[11px] text-text-muted mt-1">{note}</span>
  </div>
);

const SettlementDetail = ({ settlement }: { settlement: Settlement }) => {
  const [lines, setLines] = useState<SettlementLine[] | null>(null);
  useEffect(() => {
    fetchSettlementLines(settlement.settlement_id).then(setLines);
  }, [settlement.settlement_id]);

  return (
    <div className="space-y-4 text-xs">
      {settlement.outcome && <p className="text-sm text-text leading-relaxed">{settlement.outcome.reasoning}</p>}
      {!lines ? (
        <p className="text-text-muted">Loading lines…</p>
      ) : (
        <table className="w-full font-mono">
          <thead className="text-text-muted">
            <tr>
              <th className="py-1 font-normal text-left font-sans">Line</th>
              <th className="py-1 font-normal text-left font-sans">Type</th>
              <th className="py-1 font-normal text-left font-sans">Method</th>
              <th className="py-1 font-normal text-right font-sans">Amount</th>
              <th className="py-1 font-normal text-right font-sans">Fee (GST)</th>
              <th className="py-1 font-normal text-right font-sans">Net</th>
              <th className="py-1 font-normal text-left font-sans pl-6">Invoice</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.entity_id} className="border-t border-border/50">
                <td className="py-1">{l.entity_id}</td>
                <td className="py-1 font-sans">{l.entity_type}{l.payment_id ? ` of ${l.payment_id}` : ''}</td>
                <td className="py-1 font-sans text-text-muted">{l.method ?? '—'}</td>
                <td className="py-1 text-right">{inr.format(l.amount)}</td>
                <td className="py-1 text-right text-text-muted">{l.fee ? `${inr.format(l.fee)} (${inr.format(l.tax)})` : '—'}</td>
                <td className={cn('py-1 text-right', l.net < 0 && 'text-accent-error')}>{inr.format(l.net)}</td>
                <td className="py-1 pl-6">
                  {l.matched_invoice ?? (l.entity_type === 'payment'
                    ? <span className="font-sans text-text-muted">{l.order_receipt ? `receipt ${l.order_receipt}, not matched yet` : 'not matched yet'}</span>
                    : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

/** Pull settlement reports from the Razorpay API (only shown when keys are configured). */
const RazorpaySync = ({ onSynced }: { onSynced: () => void }) => {
  const [status, setStatus] = useState<{ configured: boolean; mode: string | null } | null>(null);
  // Default to the last 7 days
  const [from, setFrom] = useState(() => new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    fetchRazorpayStatus().then(setStatus).catch(() => setStatus({ configured: false, mode: null }));
  }, []);

  if (!status) return null;
  if (!status.configured) {
    return (
      <p className="text-xs text-text-muted max-w-xs">
        To pull your own settlements, add <span className="font-mono">RAZORPAY_KEY_ID</span> and{' '}
        <span className="font-mono">RAZORPAY_KEY_SECRET</span> (test-mode keys work) to <span className="font-mono">.env</span>.
      </p>
    );
  }

  const handleSync = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await syncRazorpay(from, to);
      setMessage({ text: `Synced ${r.items} lines from ${r.settlements} settlements.`, error: false });
      onSynced();
    } catch (err) {
      setMessage({ text: apiError(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  const dateClass = 'px-2 py-1.5 text-xs font-mono bg-surface border border-border rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched';
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Razorpay {status.mode}</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={dateClass} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={dateClass} aria-label="To" />
        <button onClick={handleSync} disabled={busy} className={btnSecondary}>
          <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
          {busy ? 'Syncing…' : 'Sync'}
        </button>
      </div>
      {message && <p className={cn('text-xs', message.error ? 'text-accent-error' : 'text-text-muted')}>{message.text}</p>}
    </div>
  );
};
