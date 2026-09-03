import { useState, useEffect } from 'react';
import { LayoutDashboard, AlertCircle, CheckCircle2, Play, Database, FileSearch, X, Check, XCircle } from 'lucide-react';
import { fetchMetrics, triggerIngest, triggerReconcile, fetchMatches, fetchExceptions, fetchAuditLog, resolveException } from './api';
import type { Metrics, Match, Exception, AuditLog } from './api';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';


// Simple utility for Tailwind class merging
export function cn(...inputs: (string | undefined | null | false)[]) {
 return twMerge(clsx(inputs));
}

// Dummy components for now
const Dashboard = () => {
 const [metrics, setMetrics] = useState<Metrics | null>(null);
 const [matches, setMatches] = useState<Match[]>([]);
 const [loading, setLoading] = useState(false);
 const [ingesting, setIngesting] = useState(false);

 const loadData = async () => {
 try {
 const [m, mats] = await Promise.all([fetchMetrics(), fetchMatches()]);
 setMetrics(m);
 setMatches(mats);
 } catch (err) {
 console.error(err);
 }
 };

 useEffect(() => {
 loadData();
 }, []);

 const handleIngest = async () => {
 setIngesting(true);
 await triggerIngest();
 await loadData();
 setIngesting(false);
 };

 const handleRunReconcile = async () => {
 setLoading(true);
 // Limit to 4 to avoid hitting the 15 RPM / 20 RPD Gemini free limits too quickly
 await triggerReconcile(4);
 await loadData();
 setLoading(false);
 };

  const methodCounts = matches.reduce((acc, m) => {
    acc[m.method] = (acc[m.method] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const totalProcessed = Number(metrics?.total_matches || 0) + Number(metrics?.total_exceptions || 0);
  const getPercentage = (count: number) => totalProcessed === 0 ? 0 : (count / totalProcessed) * 100;
  
  const exactCount = methodCounts['exact'] || 0;
  const fuzzyCount = methodCounts['fuzzy'] || 0;
  const reasonedCount = methodCounts['reasoned'] || 0;
  const exceptionCount = Number(metrics?.total_exceptions || 0);

  const hasData = totalProcessed > 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
  <div className="flex justify-between items-center">
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2 text-sm text-text-muted font-medium">
        <span>ReconAgent</span>
        <span>/</span>
        <span className="text-text font-semibold">Dashboard</span>
      </div>
      <span className="px-2 py-0.5 text-xs font-mono text-text-muted bg-surface-raised border border-border rounded-full">
        Demo dataset &middot; synthetic
      </span>
    </div>
    <div className="flex gap-4">
      <button
        onClick={handleIngest}
        disabled={ingesting || loading}
        className="flex items-center gap-2 px-4 py-2 bg-transparent border border-border hover:bg-surface-raised text-text rounded-md transition-colors disabled:opacity-50 text-sm font-medium"
      >
        <Database size={18} />
        {ingesting ? 'Ingesting...' : 'Reset & Ingest Data'}
      </button>
      <button
        onClick={handleRunReconcile}
        disabled={loading || ingesting}
        className="flex items-center gap-2 px-4 py-2 bg-accent-matched hover:brightness-110 text-[#0B0E14] rounded-md transition-all font-medium disabled:opacity-50 text-sm shadow-sm shadow-accent-matched/20"
      >
        <Play size={18} className={loading ? 'animate-pulse' : ''} />
        {loading ? 'Reconciling...' : 'Run Agent (Next 4)'}
      </button>
    </div>
  </div>

      <div className="flex flex-col md:flex-row bg-surface border border-border rounded-md divide-y md:divide-y-0 md:divide-x divide-border">
        <div className="flex-1 p-6 flex flex-col justify-center">
          <span className="text-xs font-sans text-text-muted mb-1">Total records</span>
          <span className="text-3xl font-mono font-bold text-text">{metrics?.total_records || '0'}</span>
        </div>
        <div className="flex-1 p-6 flex flex-col justify-center">
          <span className="text-xs font-sans text-text-muted mb-1">Total matches</span>
          <span className="text-3xl font-mono font-bold text-text">{metrics?.total_matches || '0'}</span>
          <span className="text-[11px] font-sans text-text-muted mt-2">{metrics?.total_matches || '0'} of {metrics?.total_records || '0'} auto-matched</span>
        </div>
        <div className="flex-1 p-6 flex flex-col justify-center">
          <span className="text-xs font-sans text-text-muted mb-1">Exceptions</span>
          <span className="text-3xl font-mono font-bold text-accent-exception">{metrics?.total_exceptions || '0'}</span>
          <span className="text-[11px] font-sans text-text-muted mt-2">Requires manual review</span>
        </div>
        <div className="flex-1 p-6 flex flex-col justify-center">
          <span className="text-xs font-sans text-text-muted mb-1">Precision</span>
          <span className="text-3xl font-mono font-bold text-text">{metrics?.precision !== undefined ? ((metrics.precision * 100).toFixed(1) + '%') : '0%'}</span>
          <span className="text-[11px] font-sans text-text-muted mt-2">Accuracy of automated matches</span>
        </div>
      </div>

      <div className="bg-surface p-6 rounded-md border border-border">
        <h2 className="text-sm font-sans font-medium text-text mb-6">Match Method Distribution</h2>
        
        {hasData ? (
          <div className="mt-2">
            <div className="w-full h-3 flex rounded-full overflow-hidden bg-surface-raised">
              {getPercentage(exactCount) > 0 && <div style={{ width: `${getPercentage(exactCount)}%` }} className="bg-accent-matched transition-all duration-500" title={`Exact: ${exactCount}`} />}
              {getPercentage(fuzzyCount) > 0 && <div style={{ width: `${getPercentage(fuzzyCount)}%` }} className="bg-accent-matched/60 transition-all duration-500" title={`Fuzzy: ${fuzzyCount}`} />}
              {getPercentage(reasonedCount) > 0 && <div style={{ width: `${getPercentage(reasonedCount)}%` }} className="bg-border transition-all duration-500" title={`Reasoned: ${reasonedCount}`} />}
              {getPercentage(exceptionCount) > 0 && <div style={{ width: `${getPercentage(exceptionCount)}%` }} className="bg-accent-exception transition-all duration-500" title={`Exceptions: ${exceptionCount}`} />}
            </div>
            
            <div className="flex flex-wrap gap-x-8 gap-y-3 mt-6 text-sm font-sans text-text-muted">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-accent-matched"></span>
                <span>Exact <span className="font-mono text-text ml-1.5">{exactCount}</span></span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-accent-matched/60"></span>
                <span>Fuzzy <span className="font-mono text-text ml-1.5">{fuzzyCount}</span></span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-border"></span>
                <span>Reasoned <span className="font-mono text-text ml-1.5">{reasonedCount}</span></span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-accent-exception"></span>
                <span>Exception <span className="font-mono text-text ml-1.5">{exceptionCount}</span></span>
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full py-12 flex items-center justify-center">
            <p className="text-text-muted text-sm font-sans">Ingest data, then run the agent to see how it matched each record.</p>
          </div>
        )}
      </div>
    </div>
  );
};

const ExceptionsQueue = ({ onTrace }: { onTrace: (id: number) => void }) => {
 const [exceptions, setExceptions] = useState<Exception[]>([]);
 const [loading, setLoading] = useState(false);

 const load = async () => {
 const data = await fetchExceptions();
 setExceptions(data);
 };

 useEffect(() => { load(); }, []);

 const handleResolve = async (id: number, action: 'match' | 'reject', bankTxnId: string | null) => {
 setLoading(true);
 await resolveException(id, action, bankTxnId || undefined);
 await load();
 setLoading(false);
 };

 if (exceptions.length === 0) {
 return <div className="text-text-muted mt-8">No open exceptions. Great job!</div>;
 }

 return (
 <div className="space-y-4">
 <h2 className="text-2xl font-bold text-text mb-6">Exceptions Queue</h2>
 {exceptions.map(exc => (
 <div key={exc.exception_id} className="bg-surface p-6 rounded-md border border-border flex flex-col md:flex-row gap-6">
 <div className="flex-1 space-y-4">
 <div className="flex items-center gap-3">
 <span className="px-2.5 py-1 text-xs font-semibold bg-accent-error/10 text-accent-error rounded-full">
 {exc.reason}
 </span>
 <span className="text-text font-mono font-medium">{exc.invoice_id}</span>
 <span className="text-text-muted text-sm">— {exc.customer_name}</span>
 </div>
 <div className="grid grid-cols-2 gap-4 text-sm">
 <div className="bg-surface-raised p-3 rounded-md border border-border/50">
 <p className="text-text-muted mb-1">Ledger Info</p>
 <p className="text-text font-mono">Amount: {exc.ledger_amount}</p>
 <p className="text-text font-mono truncate">Ref: {exc.ledger_ref}</p>
 </div>
 <div className="bg-surface-raised p-3 rounded-md border border-border/50">
 <p className="text-text-muted mb-1">Best Candidate</p>
 {exc.best_candidate_txn_id ? (
 <>
 <p className="text-text font-mono">Txn: {exc.best_candidate_txn_id}</p>
 <p className="text-text font-mono">Amount: {exc.best_candidate_amount}</p>
 </>
 ) : (
 <p className="text-text-muted italic">No candidate found</p>
 )}
 </div>
 </div>
 <div>
 <p className="text-sm text-text-muted font-medium mb-1">Agent Reasoning:</p>
 <p className="text-sm text-text/90 leading-relaxed bg-base p-3 rounded-md border border-border">
 {exc.reasoning}
 </p>
 </div>
 </div>
 
 <div className="flex flex-col gap-3 min-w-[200px] justify-center border-t md:border-t-0 md:border-l border-border pt-4 md:pt-0 md:pl-6">
 {exc.status === 'open' ? (
 <>
 <button
 disabled={loading || !exc.best_candidate_txn_id}
 onClick={() => handleResolve(exc.exception_id, 'match', exc.best_candidate_txn_id)} className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-accent-matched/10 hover:bg-accent-matched/20 text-accent-matched border border-accent-matched/20 rounded-md transition-colors disabled:opacity-50">
 <Check size={18} />
 Approve Match
 </button>
 <button
 disabled={loading}
 onClick={() => handleResolve(exc.exception_id, 'reject', null)} className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-surface-raised hover:bg-surface-border text-text border border-border rounded-md transition-colors disabled:opacity-50">
 <XCircle size={18} />
 Write Off
 </button>
 </>
 ) : (
 <div className="flex items-center justify-center gap-2 text-text-muted bg-surface-raised px-4 py-2 rounded-md">
 <CheckCircle2 size={18} />
 Resolved
 </div>
 )}
 
 <button
 onClick={() => onTrace(exc.ledger_id)} className="w-full flex items-center justify-center gap-2 px-4 py-2 text-text hover:bg-surface-raised rounded-md transition-colors mt-2">
 <FileSearch size={18} />
 View Trace
 </button>
 </div>
 </div>
 ))}
 </div>
 );
};

const MatchesView = ({ onTrace }: { onTrace: (id: number) => void }) => {
 const [matches, setMatches] = useState<Match[]>([]);
 useEffect(() => { fetchMatches().then(setMatches); }, []);

 return (
 <div className="space-y-4 animate-in fade-in">
 <h2 className="text-2xl font-bold text-text mb-6">Matched Records</h2>
 <div className="overflow-x-auto bg-surface rounded-md border border-border">
 <table className="w-full text-left text-sm text-text">
 <thead className="bg-surface-raised text-text-muted font-medium border-b border-border">
 <tr>
 <th className="px-6 py-4">Invoice ID</th>
 <th className="px-6 py-4">Bank Txn ID</th>
 <th className="px-6 py-4">Method</th>
 <th className="px-6 py-4">Confidence</th>
 <th className="px-6 py-4 text-right">Actions</th>
 </tr>
 </thead>
 <tbody>
 {matches.map(m => (
 <tr key={m.match_id} className="border-b border-border/50 hover:bg-surface-raised/30">
 <td className="px-6 py-4 font-mono font-medium text-text">{m.invoice_id}</td>
 <td className="px-6 py-4 font-mono text-xs">{m.bank_txn_id}</td>
 <td className="px-6 py-4">
 <span className={cn("px-2.5 py-1 rounded-full text-xs font-semibold",
 m.method === 'exact' ?"bg-accent-matched/10 text-accent-matched":
 m.method === 'fuzzy' ?"bg-surface-raised text-text":"bg-accent-exception/10 text-accent-exception")}>
 {m.method}
 </span>
 </td>
 <td className="px-6 py-4 font-mono">{(m.confidence * 100).toFixed(0)}%</td>
 <td className="px-6 py-4 text-right">
 <button onClick={() => onTrace((m as any).ledger_id || parseInt(m.invoice_id.split('-')[2])) /* fallback if ledger_id missing from join */} className="text-text hover:text-text p-2 rounded-md hover:bg-surface-raised transition-colors">
 <FileSearch size={18} />
 </button>
 </td>
 </tr>
 ))}
 {matches.length === 0 && (
 <tr><td colSpan={5} className="px-6 py-8 text-center text-text-muted">No matches yet.</td></tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 );
};

const TraceModal = ({ ledgerId, onClose }: { ledgerId: number; onClose: () => void }) => {
 const [logs, setLogs] = useState<AuditLog[]>([]);
 useEffect(() => { fetchAuditLog(ledgerId).then(setLogs); }, [ledgerId]);

 return (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
 <div className="bg-surface border border-border w-full max-w-3xl max-h-[85vh] rounded-md border border-border flex flex-col overflow-hidden">
 <div className="flex items-center justify-between p-6 border-b border-border">
 <h3 className="text-xl font-bold text-text flex items-center gap-2">
 <FileSearch size={22} className="text-text"/>
 Agent Investigation Trace
 </h3>
 <button onClick={onClose} className="text-text-muted hover:text-text transition-colors">
 <X size={24} />
 </button>
 </div>
 
 <div className="flex-1 overflow-y-auto p-6 space-y-6">
 {logs.length === 0 ? (
 <div className="text-center text-text-muted py-8">Loading trace...</div>
 ) : (
 logs.map((log, i) => (
 <div key={i} className="flex gap-4">
 <div className="flex flex-col items-center">
 <div className="w-8 h-8 rounded-full bg-border text-text flex items-center justify-center font-mono font-bold text-sm shrink-0">
 {log.turn}
 </div>
 {i < logs.length - 1 && <div className="w-px h-full bg-surface-border my-2"></div>}
 </div>
 <div className="flex-1 bg-surface-raised border border-border rounded-md p-4 space-y-3">
 <div className="flex justify-between items-start">
 <span className="font-mono text-sm font-bold text-text">{log.tool_name}</span>
 <span className="text-xs font-mono text-text-muted">{new Date(log.created_at).toLocaleTimeString()}</span>
 </div>
 
 <div className="space-y-1">
 <p className="text-xs text-text-muted uppercase font-semibold">Input</p>
 <pre className="text-xs text-text bg-base p-2 rounded border border-border/50 overflow-x-auto whitespace-pre-wrap">
 {JSON.stringify(log.tool_input, null, 2)}
 </pre>
 </div>
 
 <div className="space-y-1">
 <p className="text-xs text-text-muted uppercase font-semibold">Result</p>
 <pre className="text-xs text-text bg-base p-2 rounded border border-border/50 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">
 {JSON.stringify(log.tool_result, null, 2)}
 </pre>
 </div>
 </div>
 </div>
 ))
 )}
 </div>
 </div>
 </div>
 );
};

function App() {
 const [currentTab, setCurrentTab] = useState<'dashboard' | 'exceptions' | 'matches'>('dashboard');
 const [traceId, setTraceId] = useState<number | null>(null);

 const tabs = [
 { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
 { id: 'exceptions', label: 'Exceptions', icon: AlertCircle },
 { id: 'matches', label: 'Matches', icon: CheckCircle2 },
 ] as const;

 return (
 <div className="flex h-screen bg-base text-text overflow-hidden font-sans">
 {/* Sidebar */}
 <div className="w-64 bg-surface border-r border-border flex flex-col">
 <div className="p-6">
 <div className="flex items-center gap-3 text-text">
 <div className="w-8 h-8 rounded-md bg-border flex items-center justify-center">
 <Database size={20} className="text-text"/>
 </div>
 <span className="text-xl font-bold text-text tracking-tight">ReconAgent</span>
 </div>
 </div>
 
 <nav className="flex-1 px-4 space-y-2 mt-4">
  {tabs.map((tab) => {
  const Icon = tab.icon;
  const active = currentTab === tab.id;
  return (
  <button
  key={tab.id}
  onClick={() => setCurrentTab(tab.id)}
  className={cn("w-full flex items-center gap-3 px-4 py-3 transition-all duration-200 text-sm font-medium border-l-2",
  active 
  ?"border-accent-matched bg-surface-raised text-text":"border-transparent text-text-muted hover:bg-surface-raised hover:text-text")}
  >
  <Icon size={18} className={active ?"text-text":"text-text-muted"} />
  {tab.label}
  </button>
  );
  })}
 </nav>
 </div>

 {/* Main Content */}
 <main className="flex-1 overflow-auto bg-base">
 <div className="p-8 max-w-7xl mx-auto">
 {currentTab === 'dashboard' && <Dashboard />}
 {currentTab === 'exceptions' && <ExceptionsQueue onTrace={setTraceId} />}
 {currentTab === 'matches' && <MatchesView onTrace={setTraceId} />}
 </div>
 </main>

 {/* Trace Modal */}
 {traceId !== null && (
 <TraceModal ledgerId={traceId} onClose={() => setTraceId(null)} />
 )}
 </div>
 );
}

export default App;
