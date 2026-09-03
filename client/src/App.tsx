import { useState, useEffect } from 'react';
import { LayoutDashboard, AlertCircle, CheckCircle2, Play, Database, FileSearch, X } from 'lucide-react';
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
        className="flex items-center gap-2 px-4 py-2 bg-transparent border border-border hover:bg-surface-raised text-text rounded-md transition-colors disabled:opacity-50 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched focus-visible:ring-offset-2 focus-visible:ring-offset-base"
      >
        <Database size={18} />
        {ingesting ? 'Ingesting...' : 'Reset & Ingest Data'}
      </button>
      <button
        onClick={handleRunReconcile}
        disabled={loading || ingesting}
        className="flex items-center gap-2 px-4 py-2 bg-accent-matched hover:brightness-110 text-[#0B0E14] rounded-md transition-all font-medium disabled:opacity-50 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched focus-visible:ring-offset-2 focus-visible:ring-offset-base"
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
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

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

  const toggleExpand = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const formatReason = (r: string) => {
    const spaced = r.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  };

  if (exceptions.length === 0) {
    return <div className="text-text-muted mt-8 text-sm">No open exceptions. Great job!</div>;
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-bold text-text mb-4">Exceptions Queue</h2>
      {exceptions.map(exc => {
        const isExpanded = expandedIds.has(exc.exception_id);
        
        return (
          <div 
            key={exc.exception_id} 
            onClick={() => toggleExpand(exc.exception_id)}
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(exc.exception_id); } }}
            className="bg-surface rounded-md border border-border p-4 cursor-pointer hover:border-surface-raised transition-colors flex flex-col gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <span className="font-mono text-sm font-medium text-text">{exc.ledger_ref}</span>
                  <span className="px-2 py-0.5 text-xs font-medium bg-accent-exception/10 text-accent-exception rounded-full border border-accent-exception/20">
                    {formatReason(exc.reason)}
                  </span>
                </div>
                <div className="text-sm text-text-muted">
                  <p className={cn("leading-relaxed", !isExpanded && "line-clamp-2")}>
                    <strong className="text-text font-medium mr-1.5">Agent reasoning:</strong>
                    {exc.reasoning}
                  </p>
                  {!isExpanded && <span className="text-text-muted text-xs hover:text-text mt-1 inline-block transition-colors underline decoration-border underline-offset-2">Read more</span>}
                </div>
              </div>
              
              <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                {exc.status === 'open' ? (
                  <>
                    <button
                      disabled={loading || !exc.best_candidate_txn_id}
                      onClick={() => handleResolve(exc.exception_id, 'match', exc.best_candidate_txn_id)} 
                      className="px-3 py-1.5 text-xs font-medium border border-accent-matched text-accent-matched hover:bg-accent-matched hover:text-[#0B0E14] rounded transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                    >
                      Approve
                    </button>
                    <button
                      disabled={loading}
                      onClick={() => handleResolve(exc.exception_id, 'reject', null)} 
                      className="px-3 py-1.5 text-xs font-medium border border-accent-error text-accent-error hover:bg-accent-error hover:text-white rounded transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-error focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <span className="px-3 py-1.5 text-xs font-medium text-text-muted border border-transparent">Resolved</span>
                )}
                <button
                  onClick={() => onTrace(exc.ledger_id)} 
                  className="px-3 py-1.5 text-xs font-medium border border-border text-text hover:bg-surface-raised rounded transition-colors ml-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                  Trace
                </button>
              </div>
            </div>

            {isExpanded && exc.best_candidate_txn_id && (
              <div className="mt-2 p-3 bg-base rounded border border-border/50 text-sm w-full md:w-3/4">
                <div className="font-medium text-text mb-3 text-xs uppercase tracking-wider text-text-muted">Best Candidate Details</div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-text-muted text-xs mb-1">Ledger Target</p>
                    <p className="font-mono text-text">
                      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(exc.ledger_amount)}
                    </p>
                    <p className="font-mono text-text-muted text-xs truncate mt-0.5">{exc.ledger_ref}</p>
                  </div>
                  <div>
                    <p className="text-text-muted text-xs mb-1">Found Bank Txn</p>
                    <p className="font-mono text-text">
                      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(exc.best_candidate_amount || 0)}
                    </p>
                    <p className="font-mono text-text-muted text-xs mt-0.5">{exc.best_candidate_txn_id}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const MatchesView = ({ onTrace }: { onTrace: (id: number) => void }) => {
  const [matches, setMatches] = useState<Match[]>([]);
  useEffect(() => { fetchMatches().then(setMatches); }, []);

  return (
    <div className="space-y-4 animate-in fade-in">
      <h2 className="text-xl font-bold text-text mb-4">Matched Records</h2>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm text-text">
          <thead className="bg-surface-raised text-text-muted font-medium text-xs">
            <tr>
              <th className="px-4 py-2 font-normal">Ledger ID</th>
              <th className="px-4 py-2 font-normal">Bank Txn ID</th>
              <th className="px-4 py-2 font-normal text-right">Amount</th>
              <th className="px-4 py-2 font-normal">Method</th>
              <th className="px-4 py-2 font-normal">Confidence</th>
              <th className="px-4 py-2 font-normal text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((m, i) => (
              <tr key={m.match_id} className={cn("hover:brightness-110 transition-colors", i % 2 === 0 ? "bg-surface" : "bg-base")}>
                <td className="px-4 py-1.5 font-mono text-xs font-medium text-text">{m.invoice_id}</td>
                <td className="px-4 py-1.5 font-mono text-xs">{m.bank_txn_id}</td>
                <td className="px-4 py-1.5 font-mono text-xs text-right">
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(m.ledger_amount)}
                </td>
                <td className="px-4 py-1.5">
                  <span className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider",
                    m.method === 'exact' ? "bg-accent-matched/10 text-accent-matched" :
                    m.method === 'fuzzy' ? "bg-accent-matched/20 text-accent-matched" : "bg-surface-raised text-text"
                  )}>
                    {m.method}
                  </span>
                </td>
                <td className="px-4 py-1.5">
                  <div className="flex items-center gap-3 max-w-[120px]">
                    <span className="font-mono text-xs w-8 text-right">{(m.confidence * 100).toFixed(0)}%</span>
                    <div className="flex-1 h-1 bg-surface-raised rounded-full overflow-hidden">
                      <div className="h-full bg-accent-matched" style={{ width: `${m.confidence * 100}%` }} />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-1.5 text-right">
                  <button onClick={() => onTrace((m as any).ledger_id || parseInt(m.invoice_id.split('-')[2]))} 
                    className="text-text-muted hover:text-accent-matched text-xs font-medium transition-colors underline decoration-border underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded-sm"
                  >
                    View trace
                  </button>
                </td>
              </tr>
            ))}
            {matches.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-muted bg-surface">No matches yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const TraceModal = ({ ledgerId, onClose }: { ledgerId: number; onClose: () => void }) => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());

  useEffect(() => { fetchAuditLog(ledgerId).then(setLogs); }, [ledgerId]);

  const toggleStep = (index: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const getSummary = (name: string, input: any) => {
    try {
      if (name === 'find_exact_candidates') return `Searched exact amount ${input.ledger_amount} and ref ${input.ledger_ref}`;
      if (name === 'find_fuzzy_candidates') return `Searched variations near ${input.amount}`;
      if (name === 'compare_names') return `Compared "${input.name1}" with "${input.name2}"`;
      if (name === 'check_duplicate_ref') return `Checked for duplicates of ${input.reference_number}`;
      if (name === 'commit_match') return `Committed match to txn ${input.bank_txn_id}`;
      if (name === 'flag_exception') return `Flagged as exception: ${input.reason}`;
      if (name === 'precheck_exact') return `Database index found perfect match`;
    } catch (e) {}
    return 'Action executed';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-surface border border-border w-full max-w-3xl max-h-[85vh] rounded-md flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h3 className="text-xl font-bold text-text flex items-center gap-2">
            <FileSearch size={22} className="text-text-muted" />
            Investigation Trace
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded-sm">
            <X size={24} />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-8">
          {logs.length === 0 ? (
            <div className="text-center text-text-muted py-8">Loading trace...</div>
          ) : (
            <div className="space-y-0">
              {logs.map((log, i) => {
                const isTerminal = ['commit_match', 'flag_exception', 'precheck_exact'].includes(log.tool_name);
                const isExpanded = expandedSteps.has(i);
                
                return (
                  <div key={i} className="flex gap-6 relative">
                    {i < logs.length - 1 && (
                      <div className="absolute left-[9px] top-6 bottom-[-24px] w-px bg-border"></div>
                    )}
                    
                    <div className="relative z-10 flex flex-col items-center mt-1">
                      {isTerminal ? (
                        <div className="w-5 h-5 rounded-full bg-text border-[4px] border-surface"></div>
                      ) : (
                        <div className="w-5 h-5 rounded-full bg-surface border-2 border-border"></div>
                      )}
                    </div>
                    
                    <div className="flex-1 pb-10">
                      <div className="flex items-center gap-3 mb-1">
                        <span className="font-mono text-[10px] px-1.5 py-0.5 bg-surface-raised text-text-muted rounded">T{log.turn}</span>
                        <span className="font-mono font-medium text-text">{log.tool_name}</span>
                        <span className="text-xs font-mono text-text-muted ml-auto">{new Date(log.created_at).toLocaleTimeString()}</span>
                      </div>
                      
                      <div className="text-sm text-text-muted font-sans">
                        {getSummary(log.tool_name, log.tool_input)}
                      </div>
                      
                      <button 
                        onClick={() => toggleStep(i)}
                        className="text-xs font-medium text-text-muted hover:text-text transition-colors mt-3 underline decoration-border underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded-sm"
                      >
                        {isExpanded ? 'Hide raw details' : 'View input/output'}
                      </button>
                      
                      {isExpanded && (
                        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <p className="text-[10px] text-text-muted uppercase font-semibold tracking-wider">Input</p>
                            <pre className="text-xs font-mono text-text bg-base p-3 rounded border border-border overflow-x-auto whitespace-pre-wrap">
                              {JSON.stringify(log.tool_input, null, 2)}
                            </pre>
                          </div>
                          <div className="space-y-2">
                            <p className="text-[10px] text-text-muted uppercase font-semibold tracking-wider">Result</p>
                            <pre className="text-xs font-mono text-text bg-base p-3 rounded border border-border overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                              {JSON.stringify(log.tool_result, null, 2)}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
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
  <div className="w-16 md:w-64 flex-shrink-0 bg-surface border-r border-border flex flex-col transition-all duration-300">
  <div className="p-4 md:p-6 border-b border-border">
  <div className="flex items-center justify-center md:justify-start gap-3 text-text">
  <div className="w-8 h-8 rounded-md bg-border flex items-center justify-center shrink-0">
  <Database size={20} className="text-text"/>
  </div>
  <span className="hidden md:inline text-xl font-bold text-text tracking-tight">ReconAgent</span>
  </div>
  </div>
  
  <nav className="flex-1 px-2 md:px-4 space-y-2 mt-4">
   {tabs.map((tab) => {
   const Icon = tab.icon;
   const active = currentTab === tab.id;
   return (
   <button
   key={tab.id}
   onClick={() => setCurrentTab(tab.id)}
   className={cn("w-full flex items-center justify-center md:justify-start gap-3 px-2 md:px-4 py-3 transition-all duration-200 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
   active 
   ?"md:border-l-2 md:border-accent-matched bg-surface-raised text-text md:pl-[14px]":"md:border-l-2 md:border-transparent text-text-muted hover:bg-surface-raised hover:text-text")}
   title={tab.label}
   >
   <Icon size={18} className={active ?"text-text":"text-text-muted"} />
   <span className="hidden md:inline">{tab.label}</span>
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
