import { useState } from 'react';
import { Upload, X, AlertTriangle } from 'lucide-react';
import { previewUpload, uploadDataset, apiError } from '../api';
import type { ColumnMapping, Dataset, DateFormat, FilePreview, UploadErrors, UploadPreview } from '../api';
import { btnPrimary, btnSecondary } from '../lib/format';

const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: 'auto', label: 'Auto (day first, e.g. 07/08/2026 = 7 Aug)' },
  { value: 'DMY', label: 'DD/MM/YYYY' },
  { value: 'MDY', label: 'MM/DD/YYYY' },
  { value: 'YMD', label: 'YYYY-MM-DD' },
];

const FILE_LABELS = { ledger: 'Ledger / invoices', bank: 'Bank statement' } as const;

const inputClass =
  'w-full px-2 py-1.5 text-sm bg-surface border border-border rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-matched';

/**
 * Upload a ledger CSV and a bank statement CSV, map their columns to our
 * fields, and load them as the current dataset.
 */
export const UploadModal = ({ onClose, onUploaded }: { onClose: () => void; onUploaded: (dataset: Dataset) => void }) => {
  const [ledgerFile, setLedgerFile] = useState<File | null>(null);
  const [bankFile, setBankFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [csv, setCsv] = useState<{ ledger: string; bank: string } | null>(null);
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [mapping, setMapping] = useState<{ ledger: ColumnMapping; bank: ColumnMapping }>({ ledger: {}, bank: {} });
  const [dateFormat, setDateFormat] = useState<DateFormat>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<UploadErrors | null>(null);

  const handlePreview = async () => {
    if (!ledgerFile || !bankFile) return;
    setBusy(true);
    setError(null);
    try {
      const [ledger, bank] = await Promise.all([ledgerFile.text(), bankFile.text()]);
      const result = await previewUpload(ledger, bank);
      setCsv({ ledger, bank });
      setPreview(result);
      setMapping({ ledger: result.ledger.suggested, bank: result.bank.suggested });
      if (!name) setName(bankFile.name.replace(/\.csv$/i, ''));
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!csv) return;
    setBusy(true);
    setError(null);
    setRowErrors(null);
    try {
      const result = await uploadDataset({
        name,
        dateFormat,
        ledger: { csv: csv.ledger, mapping: mapping.ledger },
        bank: { csv: csv.bank, mapping: mapping.bank },
      });
      if ('dataset' in result) onUploaded(result.dataset);
      else setRowErrors(result);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const missingRequired = preview
    ? (['ledger', 'bank'] as const).some((file) =>
        preview[file].fields.some((f) => f.required && !mapping[file][f.key]))
    : true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base/60 backdrop-blur-md p-4">
      <div className="bg-surface/95 border border-border/50 w-full max-w-4xl max-h-[90vh] rounded-md flex flex-col overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between p-6 border-b border-border/50">
          <h3 className="text-xl font-bold font-serif text-text flex items-center gap-2">
            <Upload size={20} className="text-text-muted" />
            Upload data
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text transition-colors rounded-sm" aria-label="Close">
            <X size={24} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {!preview ? (
            <>
              <p className="text-sm text-text-muted">
                Choose a CSV export of your invoices and a CSV of your bank statement. You'll match their
                columns to ReconAgent's fields next.
              </p>
              <div className="grid md:grid-cols-2 gap-4">
                <FilePicker label={FILE_LABELS.ledger} file={ledgerFile} onChange={setLedgerFile} />
                <FilePicker label={FILE_LABELS.bank} file={bankFile} onChange={setBankFile} />
              </div>
            </>
          ) : (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <label className="text-xs text-text-muted space-y-1">
                  <span>Dataset name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
                </label>
                <label className="text-xs text-text-muted space-y-1">
                  <span>Date format</span>
                  <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat)} className={inputClass}>
                    {DATE_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </label>
              </div>

              {(['ledger', 'bank'] as const).map((file) => (
                <MappingTable
                  key={file}
                  title={FILE_LABELS[file]}
                  preview={preview[file]}
                  mapping={mapping[file]}
                  onChange={(key, header) => setMapping((m) => ({ ...m, [file]: { ...m[file], [key]: header } }))}
                />
              ))}

              {rowErrors && (
                <div className="p-4 border border-accent-error/30 bg-accent-error/5 rounded text-sm space-y-3">
                  <p className="font-medium text-accent-error flex items-center gap-2">
                    <AlertTriangle size={16} /> Nothing was imported. Fix these rows and try again.
                  </p>
                  {rowErrors.files.map((f) => (
                    <div key={f.file}>
                      <p className="text-xs font-semibold text-text mb-1">{FILE_LABELS[f.file]}</p>
                      <ul className="text-xs font-mono text-text-muted space-y-0.5 max-h-40 overflow-y-auto">
                        {f.errors.map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {error && <p className="text-sm text-accent-error">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-4 p-6 border-t border-border/50">
          <p className="text-xs text-text-muted">
            {preview ? 'Importing replaces the current dataset and all its matches and exceptions. Run history is kept.' : ''}
          </p>
          <div className="flex gap-3">
            {preview && <button onClick={() => { setPreview(null); setRowErrors(null); }} className={btnSecondary}>Back</button>}
            {!preview ? (
              <button onClick={handlePreview} disabled={!ledgerFile || !bankFile || busy} className={btnPrimary}>
                {busy ? 'Reading…' : 'Next'}
              </button>
            ) : (
              <button onClick={handleImport} disabled={missingRequired || busy} className={btnPrimary}>
                {busy ? 'Importing…' : `Import ${preview.ledger.rowCount} invoices & ${preview.bank.rowCount} transactions`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const FilePicker = ({ label, file, onChange }: { label: string; file: File | null; onChange: (f: File | null) => void }) => (
  <label className="flex flex-col gap-2 p-4 border border-dashed border-border rounded-md cursor-pointer hover:bg-surface-raised transition-colors">
    <span className="text-sm font-medium text-text">{label}</span>
    <span className="text-xs text-text-muted font-mono truncate">{file ? file.name : 'Choose a .csv file'}</span>
    <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
  </label>
);

const MappingTable = ({
  title, preview, mapping, onChange,
}: {
  title: string;
  preview: FilePreview;
  mapping: ColumnMapping;
  onChange: (key: string, header: string | null) => void;
}) => (
  <div>
    <h4 className="text-sm font-serif font-medium text-text mb-2">
      {title} <span className="text-xs font-sans text-text-muted">· {preview.rowCount} rows</span>
    </h4>
    <table className="w-full text-sm border border-border/50 rounded-md overflow-hidden">
      <thead className="bg-surface-raised text-text-muted text-xs">
        <tr>
          <th className="px-3 py-2 font-normal text-left w-1/4">Field</th>
          <th className="px-3 py-2 font-normal text-left w-1/3">Column in your file</th>
          <th className="px-3 py-2 font-normal text-left">First values</th>
        </tr>
      </thead>
      <tbody>
        {preview.fields.map((field) => {
          const header = mapping[field.key];
          const samples = header ? preview.sample.slice(0, 3).map((r) => r[header]).filter(Boolean) : [];
          return (
            <tr key={field.key} className="border-t border-border/50">
              <td className="px-3 py-1.5 text-xs">
                {field.label}
                {field.required && <span className="text-accent-error ml-0.5">*</span>}
              </td>
              <td className="px-3 py-1.5">
                <select
                  value={header ?? ''}
                  onChange={(e) => onChange(field.key, e.target.value || null)}
                  className={inputClass + (field.required && !header ? ' border-accent-error' : '')}
                >
                  <option value="">{field.required ? 'Choose a column…' : 'Not in this file'}</option>
                  {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </td>
              <td className="px-3 py-1.5 text-xs font-mono text-text-muted truncate max-w-[260px]">
                {samples.join(' · ') || (field.key === 'txn_id' && !header ? 'Generated (BANK-00001, …)' : '')}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);
