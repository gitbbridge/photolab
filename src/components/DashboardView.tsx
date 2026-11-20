import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Link2,
  Play,
  RefreshCw,
  Upload,
} from 'lucide-react';
import type {
  JobMode,
  JobRecord,
  PackageUrlRecord,
  SpreadsheetPreviewResult,
  SystemStatus,
} from '../types';

interface DashboardViewProps {
  activeJob: JobRecord | null;
  packages: PackageUrlRecord[];
  systemStatus: SystemStatus | null;
  onJobCreated: (job: JobRecord) => void;
  onNavigate: (tab: 'dashboard' | 'processing' | 'images' | 'suppliers' | 'exports') => void;
  onRetryFailed: () => Promise<void>;
}

export function DashboardView({
  activeJob,
  packages,
  systemStatus,
  onJobCreated,
  onNavigate,
  onRetryFailed,
}: DashboardViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SpreadsheetPreviewResult | null>(null);

  const [runMode, setRunMode] = useState<JobMode>('test_10');
  const [customLimit, setCustomLimit] = useState<number>(25);
  const [concurrency, setConcurrency] = useState<number>(3);
  const [launching, setLaunching] = useState(false);

  const [showDirectInput, setShowDirectInput] = useState(false);
  const [directUrlsText, setDirectUrlsText] = useState('');

  const handleFileSelected = async (file: File) => {
    setUploadError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/spreadsheet/preview', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to parse spreadsheet.');
      }
      setPreview(data as SpreadsheetPreviewResult);
      setRunMode('test_10');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleLaunchFromSpreadsheet = async () => {
    if (!preview) return;
    setUploadError(null);
    setLaunching(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadToken: preview.uploadToken,
          filename: preview.filename,
          mode: runMode,
          customLimit: runMode === 'custom' ? customLimit : undefined,
          concurrency,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start job.');
      }
      setPreview(null);
      onJobCreated(data.job as JobRecord);
      onNavigate('processing');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to start discovery run.');
    } finally {
      setLaunching(false);
    }
  };

  const handleLaunchDirectUrls = async () => {
    const urls = directUrlsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      setUploadError('Enter at least one valid package URL.');
      return;
    }
    setUploadError(null);
    setLaunching(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: urls,
          filename: 'direct_package_urls.csv',
          mode: urls.length > 10 ? runMode : 'all',
          customLimit: runMode === 'custom' ? customLimit : undefined,
          concurrency,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start job.');
      }
      setDirectUrlsText('');
      setShowDirectInput(false);
      onJobCreated(data.job as JobRecord);
      onNavigate('processing');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to launch URLs.');
    } finally {
      setLaunching(false);
    }
  };

  const erroredPackages = packages.filter((p) => p.status === 'error');

  return (
    <div className="space-y-8">
      {/* Header & Claude Config Warning if missing */}
      {systemStatus && !systemStatus.claudeConfigured && (
        <div className="flex items-start gap-3 p-4 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-900">
          <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">ANTHROPIC_API_KEY is not configured</p>
            <p className="text-rose-700 mt-0.5">
              Set <code className="font-mono text-xs bg-rose-100 px-1 py-0.5 rounded">ANTHROPIC_API_KEY</code> in
              the project .env file to enable visual image classification and supplier discovery.
            </p>
          </div>
        </div>
      )}

      {/* Upload & Run Launcher */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Upload Package Spreadsheet
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Reads package URLs from <span className="font-mono text-slate-700">column L (url)</span> starting at row 2. Supports <span className="font-mono text-slate-700">gather_giveholidays.csv</span> and <span className="font-mono text-slate-700">.xlsx</span> workbooks.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/api/spreadsheet/template"
              download="gather_giveholidays_template.csv"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Column-L Template
            </a>
            <button
              type="button"
              onClick={() => setShowDirectInput((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Link2 className="w-3.5 h-3.5" />
              {showDirectInput ? 'Hide URL Paste' : 'Paste Package URLs'}
            </button>
          </div>
        </div>

        {uploadError && (
          <div className="mt-4 flex items-center gap-2 p-3 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-800">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
            <span>{uploadError}</span>
          </div>
        )}

        {!preview && !showDirectInput && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFileSelected(file);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`mt-5 border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
              dragging
                ? 'border-blue-500 bg-blue-50/50'
                : 'border-slate-200 hover:border-slate-300 bg-slate-50/50'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileSelected(file);
                e.target.value = '';
              }}
            />
            <div className="mx-auto w-11 h-11 rounded-lg bg-white border border-slate-200 flex items-center justify-center mb-3">
              <Upload className="w-5 h-5 text-blue-600" />
            </div>
            <p className="text-sm font-medium text-slate-900">
              {uploading ? 'Parsing spreadsheet...' : 'Drop gather_giveholidays.csv or .xlsx here, or click to browse'}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Original spreadsheet row numbers are preserved; empty rows are ignored and duplicate URLs are flagged automatically.
            </p>
          </div>
        )}

        {showDirectInput && !preview && (
          <div className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Enter package URLs (one per line, assigned sequential rows starting at Row 2)
              </label>
              <textarea
                rows={5}
                value={directUrlsText}
                onChange={(e) => setDirectUrlsText(e.target.value)}
                placeholder="https://example-charity-auction.com/packages/villa-tuscany&#10;https://example-charity-auction.com/packages/bali-resort"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <label className="text-xs font-medium text-slate-600">Concurrency</label>
                <select
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-mono bg-white"
                >
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n} workers
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                disabled={launching}
                onClick={() => void handleLaunchDirectUrls()}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors"
              >
                <Play className="w-4 h-4" />
                {launching ? 'Starting...' : 'Run Discovery on URLs'}
              </button>
            </div>
          </div>
        )}

        {preview && (
          <div className="mt-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="w-5 h-5 text-blue-700 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-900">{preview.filename}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-0.5 tabular-nums">
                    <span>Column {preview.columnLetter} ({preview.columnHeader})</span>
                    <span aria-hidden="true">·</span>
                    <span>{preview.totalRowsScanned} rows scanned</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-slate-900 font-medium">{preview.uniqueValidUrls} unique valid URLs</span>
                    <span aria-hidden="true">·</span>
                    <span>{preview.duplicateUrlsDetected} duplicates</span>
                    <span aria-hidden="true">·</span>
                    <span>{preview.emptyRowsIgnored} empty ignored</span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Choose another file
              </button>
            </div>

            {preview.warnings.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 space-y-1">
                {preview.warnings.map((w, idx) => (
                  <p key={idx}>{w}</p>
                ))}
              </div>
            )}

            {/* Preview Table (first 6 rows) */}
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="py-2 px-3 font-medium w-20">Row</th>
                    <th className="py-2 px-3 font-medium">Extracted Package URL (Col {preview.columnLetter})</th>
                    <th className="py-2 px-3 font-medium w-36 text-right">Deduplication</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.previewRows.slice(0, 6).map((row) => (
                    <tr key={row.spreadsheetRow} className="hover:bg-slate-50/70">
                      <td className="py-2 px-3 font-mono tabular-nums text-slate-600">
                        #{row.spreadsheetRow}
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-800 truncate max-w-md">
                        {row.url}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {row.isDuplicate ? (
                          <span className="text-amber-700 font-medium">
                            Duplicate of #{row.duplicateOfRow}
                          </span>
                        ) : (
                          <span className="text-emerald-700 font-medium">Unique</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Scope & Concurrency Controls */}
            <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
              <div className="flex flex-wrap items-center gap-3">
                <div className="inline-flex items-center p-1 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setRunMode('test_10')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      runMode === 'test_10'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Initial 10-URL Test ({Math.min(10, preview.uniqueValidUrls)})
                  </button>
                  <button
                    type="button"
                    onClick={() => setRunMode('custom')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      runMode === 'custom'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Custom Count
                  </button>
                  <button
                    type="button"
                    onClick={() => setRunMode('all')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      runMode === 'all'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    All Valid URLs ({preview.uniqueValidUrls})
                  </button>
                </div>

                {runMode === 'custom' && (
                  <input
                    type="number"
                    min={1}
                    max={preview.uniqueValidUrls}
                    value={customLimit}
                    onChange={(e) => setCustomLimit(Math.max(1, Number(e.target.value)))}
                    className="w-24 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-mono tabular-nums"
                  />
                )}

                <select
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-mono bg-white"
                >
                  {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n} concurrent
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                disabled={launching}
                onClick={() => void handleLaunchFromSpreadsheet()}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="w-4 h-4" />
                {launching
                  ? 'Launching Pipeline...'
                  : runMode === 'test_10'
                    ? 'Run 10-URL Test'
                    : 'Start Discovery Run'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Active Job Overview KPIs */}
      {activeJob ? (
        <>
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Active Run Metrics — {activeJob.filename}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-0.5">
                  <span>Mode: {activeJob.mode === 'test_10' ? 'Initial 10-URL Test' : activeJob.mode}</span>
                  <span aria-hidden="true">·</span>
                  <span>Status: <strong className="text-slate-800 capitalize">{activeJob.status}</strong></span>
                  <span aria-hidden="true">·</span>
                  <span>Provider: {activeJob.reverse_image_provider}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeJob.error_count > 0 && (
                  <button
                    type="button"
                    onClick={() => void onRetryFailed()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry {activeJob.error_count} Failed
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onNavigate('suppliers')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Review Suppliers
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('exports')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
                >
                  Export Results
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricTile
                label="Total Package URLs"
                value={activeJob.total_urls}
                sub={`${activeJob.duplicate_urls_count} dup · ${activeJob.empty_rows_count} empty`}
              />
              <MetricTile
                label="Pages Processed"
                value={activeJob.processed_pages}
                sub={`of ${activeJob.total_urls} queued`}
              />
              <MetricTile
                label="Images Examined"
                value={activeJob.images_classified}
                sub={`${activeJob.images_discovered} downloaded`}
              />
              <MetricTile
                label="Accommodation Retained"
                value={activeJob.images_kept}
                accent="emerald"
                sub="Classified KEEP"
              />
              <MetricTile
                label="Suppliers Discovered"
                value={activeJob.suppliers_discovered}
                accent="blue"
                sub="Verified / Proposed / Approved"
              />
              <MetricTile
                label="Unresolved Records"
                value={activeJob.unresolved_count}
                accent={activeJob.unresolved_count > 0 ? 'amber' : undefined}
                sub="Needs research or rejected"
              />
              <MetricTile
                label="Page Errors"
                value={activeJob.error_count}
                accent={activeJob.error_count > 0 ? 'rose' : undefined}
                sub="Timeouts / blocked / HTTP errors"
              />
              <MetricTile
                label="AI Usage & Est. Cost"
                value={`$${activeJob.estimated_cost_usd.toFixed(4)}`}
                sub={`${(activeJob.prompt_tokens + activeJob.output_tokens).toLocaleString()} tokens`}
              />
            </div>

            {/* Bright Data Cost Protection & End-of-Run Summary */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Bright Data Cost Protection & Verification Report
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Hard cap: {activeJob.serpapi_request_limit || 100} requests/run · Rate limit: 10 req/min · Duplicate queries served from SQLite cache
                  </p>
                </div>
                <span className="text-xs font-mono text-slate-600 tabular-nums">
                  {activeJob.serpapi_requests_made >= (activeJob.serpapi_request_limit || 100)
                    ? 'Budget Limit Reached'
                    : `${Math.max(0, (activeJob.serpapi_request_limit || 100) - activeJob.serpapi_requests_made)} requests remaining`}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4">
                <div>
                  <p className="text-xs text-slate-500">Total Bright Data Requests Made</p>
                  <p className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
                    {activeJob.serpapi_requests_made} / {activeJob.serpapi_request_limit || 100}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Remaining Request Allowance</p>
                  <p className="text-lg font-semibold font-mono tabular-nums text-emerald-700 mt-0.5">
                    {Math.max(0, (activeJob.serpapi_request_limit || 100) - activeJob.serpapi_requests_made)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Cached / Deduplicated Lookups</p>
                  <p className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
                    {activeJob.serpapi_cache_hits}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Unique Verified Properties</p>
                  <p className="text-lg font-semibold font-mono tabular-nums text-blue-700 mt-0.5">
                    {activeJob.unique_verified_count}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Errors / Operational Alerts */}
          {erroredPackages.length > 0 && (
            <section className="bg-white border border-slate-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-slate-900 mb-3">
                Extraction & Processing Errors ({erroredPackages.length})
              </h3>
              <div className="divide-y divide-slate-100">
                {erroredPackages.slice(0, 8).map((pkg) => (
                  <div key={pkg.id} className="py-2.5 flex items-start justify-between gap-4 text-xs">
                    <div className="min-w-0">
                      <span className="font-mono text-slate-500 mr-2">Row #{pkg.spreadsheet_row}</span>
                      <a
                        href={pkg.package_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-blue-700 hover:underline break-all"
                      >
                        {pkg.package_url}
                      </a>
                      <p className="text-rose-700 mt-0.5">{pkg.error_message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        <section className="bg-white border border-slate-200 rounded-xl p-8 text-center">
          <CheckCircle2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <h3 className="text-base font-semibold text-slate-900">Ready for Discovery</h3>
          <p className="text-sm text-slate-500 max-w-lg mx-auto mt-1">
            Upload <span className="font-mono text-slate-700">gather_giveholidays.csv</span> or any spreadsheet with package URLs in column L, then start the Initial 10-URL Test to inspect real pages, classify accommodation photos with Claude, and verify direct suppliers.
          </p>
        </section>
      )}
    </div>
  );
}

function MetricTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number | string;
  sub: string;
  accent?: 'emerald' | 'blue' | 'amber' | 'rose';
}) {
  const valueColor =
    accent === 'emerald'
      ? 'text-emerald-700'
      : accent === 'blue'
        ? 'text-blue-700'
        : accent === 'amber'
          ? 'text-amber-700'
          : accent === 'rose'
            ? 'text-rose-700'
            : 'text-slate-900';

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`text-2xl font-semibold font-mono tabular-nums mt-1 ${valueColor}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      <p className="text-xs text-slate-400 mt-1 truncate">{sub}</p>
    </div>
  );
}
