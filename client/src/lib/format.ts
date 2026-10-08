import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';

// Simple utility for Tailwind class merging
export function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

export const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

const count = new Intl.NumberFormat('en-IN');
export const formatCount = (n: number | string) => count.format(Number(n));

export const formatPercent = (ratio: number | undefined | null) =>
  ratio === undefined || ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`;

/** "42s", "3m 05s", "1h 02m" */
export function formatDuration(fromIso: string, toIso?: string | null): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export const btnPrimary =
  'flex items-center gap-2 px-4 py-2 bg-accent-matched hover:brightness-110 text-surface rounded-md transition-all font-medium disabled:opacity-50 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched focus-visible:ring-offset-2 focus-visible:ring-offset-base';

export const btnSecondary =
  'flex items-center gap-2 px-4 py-2 bg-transparent border border-border hover:bg-surface-raised text-text rounded-md transition-colors disabled:opacity-50 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched focus-visible:ring-offset-2 focus-visible:ring-offset-base';
