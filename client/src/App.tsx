import { useState, useEffect } from 'react';
import { LayoutDashboard, AlertCircle, CheckCircle2, Play, Database } from 'lucide-react';
import { fetchMetrics, triggerIngest, triggerReconcile, fetchMatches, Metrics, Match } from './api';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

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

  // Group matches by method for chart
  const methodCounts = matches.reduce((acc, m) => {
    acc[m.method] = (acc[m.method] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const chartData = Object.entries(methodCounts).map(([name, count]) => ({ name, count }));
  const colors = { exact: '#10b981', fuzzy: '#3b82f6', reasoned: '#8b5cf6' };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight text-white">Dashboard</h1>
        <div className="flex gap-4">
          <button
            onClick={handleIngest}
            disabled={ingesting || loading}
            className="flex items-center gap-2 px-4 py-2 bg-surface-hover hover:bg-surface-border text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <Database size={18} />
            {ingesting ? 'Ingesting...' : 'Reset & Ingest Data'}
          </button>
          <button
            onClick={handleRunReconcile}
            disabled={loading || ingesting}
            className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors font-medium shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            <Play size={18} className={loading ? 'animate-pulse' : ''} />
            {loading ? 'Reconciling...' : 'Run Agent (Next 4)'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard title="Total Records" value={metrics?.total_records || '0'} />
        <MetricCard title="Total Matches" value={metrics?.total_matches || '0'} />
        <MetricCard title="Exceptions" value={metrics?.total_exceptions || '0'} />
        <MetricCard title="Precision" value={metrics?.precision !== undefined ? \`\${(metrics.precision * 100).toFixed(1)}%\` : '0%'} />
      </div>

      <div className="bg-surface p-6 rounded-xl border border-surface-border">
        <h2 className="text-xl font-semibold text-white mb-6">Match Method Distribution</h2>
        <div className="h-72">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <XAxis dataKey="name" stroke="#9ca3af" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="#9ca3af" fontSize={12} tickLine={false} axisLine={false} />
                <Tooltip 
                  cursor={{ fill: '#292d3b' }}
                  contentStyle={{ backgroundColor: '#1e212b', borderColor: '#333848', color: '#fff', borderRadius: '8px' }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={60}>
                  {chartData.map((entry, index) => (
                    <Cell key={\`cell-\${index}\`} fill={colors[entry.name as keyof typeof colors] || '#3b82f6'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-text-muted border border-dashed border-surface-border rounded-lg bg-surface-hover/30">
              <Database size={32} className="mb-2 opacity-50" />
              <p>No matches yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const MetricCard = ({ title, value }: { title: string; value: string | number }) => (
  <div className="bg-surface p-6 rounded-xl border border-surface-border shadow-sm">
    <h3 className="text-sm font-medium text-text-muted">{title}</h3>
    <p className="text-3xl font-bold text-white mt-2">{value}</p>
  </div>
);

const ExceptionsQueue = () => <div className="text-white">Exceptions Queue (Coming soon)</div>;
const MatchesView = () => <div className="text-white">Matches (Coming soon)</div>;

function App() {
  const [currentTab, setCurrentTab] = useState<'dashboard' | 'exceptions' | 'matches'>('dashboard');

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'exceptions', label: 'Exceptions', icon: AlertCircle },
    { id: 'matches', label: 'Matches', icon: CheckCircle2 },
  ] as const;

  return (
    <div className="flex h-screen bg-background text-text-main overflow-hidden font-sans">
      {/* Sidebar */}
      <div className="w-64 bg-surface border-r border-surface-border flex flex-col">
        <div className="p-6">
          <div className="flex items-center gap-3 text-primary">
            <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
              <Database size={20} className="text-primary" />
            </div>
            <span className="text-xl font-bold text-white tracking-tight">ReconAgent</span>
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
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 text-sm font-medium",
                  active 
                    ? "bg-primary/10 text-primary" 
                    : "text-text-muted hover:bg-surface-hover hover:text-white"
                )}
              >
                <Icon size={18} className={active ? "text-primary" : "text-text-muted"} />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-background">
        <div className="p-8 max-w-7xl mx-auto">
          {currentTab === 'dashboard' && <Dashboard />}
          {currentTab === 'exceptions' && <ExceptionsQueue />}
          {currentTab === 'matches' && <MatchesView />}
        </div>
      </main>
    </div>
  );
}

export default App;
