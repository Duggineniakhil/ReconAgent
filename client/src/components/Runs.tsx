import { useEffect, useState } from 'react';
import { Square, ChevronDown, ChevronRight } from 'lucide-react';
import { cancelRun, fetchRuns, subscribeRun, apiError } from '../api';
import type { Run, RunStatus } from '../api';
import { cn, formatCount, formatDuration, formatPercent } from '../lib/format';

const STATUS_STYLES: Record<RunStatus, string> = {
  running: 'bg-accent-matched/10 text-accent-matched',
  completed: 'bg-surface-raised text-text',
  cancelled: 'bg-surface-raised text-text-muted',
  interrupted: 'bg-accent-exception/10 text-accent-exception',
  failed: 'bg-accent-error/10 text-accent-error',
};

export const StatusBadge = ({ status }: { status: RunStatus }) => (
  <span className={cn('px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider', STATUS_STYLES[status])}>
    {status === 'running' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-matched mr-1.5 animate-pulse align-middle" />}
    {status}
  </span>
);

/** Re-render every second while `active`, so elapsed times tick. */
function useTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/** Live progress for one run. Subscribes to its event stream while it is running. */
export const RunProgress = ({ run: initial, onFinished }: { run: Run; onFinished?: (run: Run) => void }) => {
  const [run, setRun] = useState(initial);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = run.status === 'running';
  useTick(running);

  useEffect(() => {
    if (initial.status !== 'running') return;
    return subscribeRun(initial.id, (update) => {
      setRun(update);
      if (update.status !== 'running') onFinished?.(update);
    });
    // onFinished is a callback prop; re-subscribing when it changes would replay events
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id, initial.status]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelRun(run.id);
    } catch (err) {
      setError(apiError(err));
      setCancelling(false);
    }
  };

  const pct = run.total === 0 ? 100 : (run.processed / run.total) * 100;
  const remaining = run.total - run.processed;
  const elapsedMs = (run.finished_at ? new Date(run.finished_at) : new Date()).getTime() - new Date(run.started_at).getTime();
  const perRecordMs = run.processed > 0 ? elapsedMs / run.processed : 0;

  return (
    <div className="bg-surface/80 backdrop-blur-md p-6 rounded-md border border-border/50 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-serif font-medium text-text">Run #{run.id}</h2>
          <StatusBadge status={run.status} />
        </div>
        <div className="flex items-center gap-4 text-xs font-mono text-text-muted">
          <span>{formatDuration(run.started_at, run.finished_at)}</span>
          {running && remaining > 0 && perRecordMs > 0 && (
            <span>~{formatDuration(new Date(Date.now() - perRecordMs * remaining).toISOString())} left</span>
          )}
          {running && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="flex items-center gap-1.5 px-2.5 py-1 border border-border rounded text-text hover:bg-surface-raised disabled:opacity-50 font-sans font-medium"
            >
              <Square size={12} />
              {cancelling ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
      </div>

      <div>
        <div className="w-full h-2 bg-surface-raised rounded-full overflow-hidden">
          <div
            className={cn('h-full transition-all duration-500', run.status === 'failed' ? 'bg-accent-error' : 'bg-accent-matched')}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs font-sans text-text-muted">
          <span><span className="font-mono text-text">{run.processed}</span> / {run.total} records</span>
          <span><span className="font-mono text-text">{run.matched}</span> matched</span>
          <span><span className="font-mono text-text">{run.exceptions}</span> exceptions</span>
          {run.errors > 0 && <span className="text-accent-error"><span className="font-mono">{run.errors}</span> errors</span>}
          <span><span className="font-mono text-text">{run.precheck_hits}</span> via precheck</span>
          <span><span className="font-mono text-text">{run.llm_calls}</span> LLM calls</span>
          <span><span className="font-mono text-text">{formatCount(run.input_tokens + run.output_tokens)}</span> tokens</span>
        </div>
      </div>

      {(run.error || error) && <p className="text-xs text-accent-error">{run.error || error}</p>}
    </div>
  );
};

/** History of runs, newest first, with per-run metrics. */
export const RunsView = () => {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = () => fetchRuns().then((data) => { setRuns(data); setLoaded(true); });
  useEffect(() => { load(); }, []);

  const active = runs.find((r) => r.status === 'running');

  if (!loaded) return <div className="text-text-muted mt-8 text-sm">Loading runs…</div>;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold font-serif text-text mb-4">Reconciliation Runs</h2>

      {active && <RunProgress key={active.id} run={active} onFinished={load} />}

      <div className="overflow-x-auto rounded-md border border-border/50 bg-surface/50 backdrop-blur-md">
        <table className="w-full text-left text-sm text-text">
          <thead className="bg-surface-raised text-text-muted font-medium text-xs">
            <tr>
              <th className="px-4 py-2 font-normal w-6"></th>
              <th className="px-4 py-2 font-normal">Run</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Dataset</th>
              <th className="px-4 py-2 font-normal text-right">Records</th>
              <th className="px-4 py-2 font-normal text-right">Matched</th>
              <th className="px-4 py-2 font-normal text-right">Exceptions</th>
              <th className="px-4 py-2 font-normal text-right">Accuracy</th>
              <th className="px-4 py-2 font-normal text-right">LLM calls</th>
              <th className="px-4 py-2 font-normal text-right">Tokens</th>
              <th className="px-4 py-2 font-normal text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run, i) => {
              const isOpen = expanded === run.id;
              return [
                <tr
                  key={run.id}
                  onClick={() => setExpanded(isOpen ? null : run.id)}
                  className={cn('hover:bg-surface transition-colors cursor-pointer', i % 2 === 0 ? 'bg-surface/80' : 'bg-base/60')}
                >
                  <td className="px-4 py-1.5 text-text-muted">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                  <td className="px-4 py-1.5 font-mono text-xs">
                    #{run.id}
                    <span className="text-text-muted ml-2">{new Date(run.started_at).toLocaleString()}</span>
                  </td>
                  <td className="px-4 py-1.5"><StatusBadge status={run.status} /></td>
                  <td className="px-4 py-1.5 text-xs text-text-muted truncate max-w-[180px]">{run.dataset_name ?? '—'}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-right">{run.processed}/{run.total}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-right">{run.matched}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-right">
                    {run.exceptions}
                    {run.errors > 0 && <span className="text-accent-error ml-1">+{run.errors} err</span>}
                  </td>
                  <td className="px-4 py-1.5 font-mono text-xs text-right">{formatPercent(run.metrics?.accuracy)}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-right">{run.llm_calls}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-right">{formatCount(run.input_tokens + run.output_tokens)}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-right">{formatDuration(run.started_at, run.finished_at)}</td>
                </tr>,
                isOpen && (
                  <tr key={`${run.id}-detail`} className="bg-base/60">
                    <td colSpan={11} className="px-10 py-4">
                      <RunDetail run={run} />
                    </td>
                  </tr>
                ),
              ];
            })}
            {runs.length === 0 && (
              <tr><td colSpan={11} className="px-4 py-6 text-center text-text-muted bg-surface/80">No runs yet. Start one from the dashboard.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const RunDetail = ({ run }: { run: Run }) => {
  const m = run.metrics;
  return (
    <div className="grid md:grid-cols-3 gap-6 text-xs">
      <div className="space-y-1.5">
        <p className="text-[10px] text-text-muted uppercase font-semibold tracking-wider mb-2">Configuration</p>
        <p><span className="text-text-muted">Model:</span> <span className="font-mono">{run.model}</span></p>
        <p><span className="text-text-muted">Prompt version:</span> <span className="font-mono">{run.prompt_version}</span></p>
        <p><span className="text-text-muted">Concurrency:</span> <span className="font-mono">{run.concurrency}</span></p>
        <p><span className="text-text-muted">Tokens in / out:</span> <span className="font-mono">{formatCount(run.input_tokens)} / {formatCount(run.output_tokens)}</span></p>
      </div>

      <div>
        <p className="text-[10px] text-text-muted uppercase font-semibold tracking-wider mb-2">Accuracy by case type</p>
        {m?.by_case_type ? (
          <table className="w-full font-mono">
            <tbody>
              {Object.entries(m.by_case_type)
                .filter(([, s]) => s.total - s.pending > 0)
                .map(([caseType, s]) => (
                  <tr key={caseType}>
                    <td className="py-0.5 font-sans text-text-muted">{caseType.replace(/_/g, ' ')}</td>
                    <td className="py-0.5 text-right">{s.correct}/{s.total - s.pending}</td>
                  </tr>
                ))}
              <tr className="border-t border-border">
                <td className="pt-1 font-sans text-text-muted">precision / recall</td>
                <td className="pt-1 text-right">{formatPercent(m.precision)} / {formatPercent(m.recall)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="text-text-muted">
            {run.status === 'running' ? 'Available when the run finishes.' : 'No ground truth for this dataset.'}
          </p>
        )}
      </div>

      <div>
        <p className="text-[10px] text-text-muted uppercase font-semibold tracking-wider mb-2">Errors</p>
        {run.error && <p className="text-accent-error mb-2">{run.error}</p>}
        {run.failures.length === 0 ? (
          <p className="text-text-muted">None</p>
        ) : (
          <ul className="space-y-1 max-h-32 overflow-y-auto">
            {run.failures.map((f, i) => (
              <li key={i} className="font-mono text-text-muted truncate" title={f.error}>
                ledger {f.ledger_id}: {f.error}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
