import { ExternalLink, Pause, Play, RefreshCw } from 'lucide-react';
import type { JobLogRecord, JobRecord, PackageUrlRecord } from '../types';
import { PackageStatusLabel } from './StatusLabel';

interface ProcessingViewProps {
  job: JobRecord | null;
  packages: PackageUrlRecord[];
  logs: JobLogRecord[];
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onRetryFailed: () => Promise<void>;
  onChangeConcurrency: (val: number) => Promise<void>;
}

export function ProcessingView({
  job,
  packages,
  logs,
  onPause,
  onResume,
  onRetryFailed,
  onChangeConcurrency,
}: ProcessingViewProps) {
  if (!job) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <p className="text-sm text-slate-500">No active job selected. Upload a spreadsheet from the Dashboard to start processing.</p>
      </div>
    );
  }

  const pct =
    job.total_urls > 0
      ? Math.min(100, Math.round((job.processed_pages / job.total_urls) * 100))
      : 0;

  return (
    <div className="space-y-6">
      {/* Live Status Banner */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              {job.status === 'running' && (
                <span className="w-2.5 h-2.5 rounded-full bg-blue-600 animate-pulse" aria-hidden="true" />
              )}
              <h2 className="text-lg font-semibold text-slate-900">
                {job.filename} — <span className="capitalize">{job.status}</span>
              </h2>
            </div>
            <p className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
              {job.processed_pages} / {job.total_urls} pages · {job.images_classified} images · {job.suppliers_discovered} suppliers ({job.unique_verified_count} unique verified) · Bright Data {job.serpapi_requests_made}/{job.serpapi_request_limit || 100} ({Math.max(0, (job.serpapi_request_limit || 100) - job.serpapi_requests_made)} left, {job.serpapi_cache_hits} cached, 10/min cap) · ${job.estimated_cost_usd.toFixed(4)} est. Claude cost
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={job.concurrency}
              onChange={(e) => void onChangeConcurrency(Number(e.target.value))}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-mono bg-white"
              title="Worker Concurrency"
            >
              {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n} workers
                </option>
              ))}
            </select>

            {job.status === 'running' ? (
              <button
                type="button"
                onClick={() => void onPause()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
              >
                <Pause className="w-3.5 h-3.5" />
                Pause
              </button>
            ) : (
              job.processed_pages < job.total_urls && (
                <button
                  type="button"
                  onClick={() => void onResume()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  Resume
                </button>
              )
            )}

            {job.error_count > 0 && (
              <button
                type="button"
                onClick={() => void onRetryFailed()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry Failed ({job.error_count})
              </button>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        <div>
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1.5 tabular-nums">
            <span>
              {job.current_url ? (
                <span className="font-mono text-slate-700">Current: {job.current_url}</span>
              ) : job.status === 'completed' ? (
                'All queued URLs processed'
              ) : (
                'Checkpoint saved'
              )}
            </span>
            <span className="font-mono font-semibold text-slate-900">{pct}%</span>
          </div>
          <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </section>

      {/* Package Queue Table + Live Log */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <section className="xl:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              Package Processing Queue ({packages.length})
            </h3>
          </div>
          <div className="overflow-x-auto max-h-[540px] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 sticky top-0">
                <tr>
                  <th className="py-2.5 px-4 font-medium w-16">Row</th>
                  <th className="py-2.5 px-4 font-medium">Package URL & Page Title</th>
                  <th className="py-2.5 px-4 font-medium w-40">Stage</th>
                  <th className="py-2.5 px-4 font-medium w-16 text-right">Tries</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {packages.map((pkg) => (
                  <tr key={pkg.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500 align-top">
                      #{pkg.spreadsheet_row}
                    </td>
                    <td className="py-2.5 px-4 align-top">
                      <a
                        href={pkg.package_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-blue-700 hover:underline inline-flex items-center gap-1 break-all"
                      >
                        {pkg.package_url}
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                      {pkg.page_title && (
                        <p className="text-slate-700 mt-0.5 truncate max-w-xl">{pkg.page_title}</p>
                      )}
                      {pkg.error_message && (
                        <p className="text-rose-700 mt-0.5">{pkg.error_message}</p>
                      )}
                    </td>
                    <td className="py-2.5 px-4 align-top whitespace-nowrap">
                      <PackageStatusLabel status={pkg.status} />
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-right text-slate-500 align-top">
                      {pkg.attempts}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-5 py-3.5 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">Activity Log</h3>
          </div>
          <div className="p-4 space-y-2.5 max-h-[540px] overflow-y-auto text-xs font-mono">
            {logs.length === 0 ? (
              <p className="text-slate-400">No log entries yet.</p>
            ) : (
              logs.map((entry) => (
                <div key={entry.id} className="pb-2 border-b border-slate-100 last:border-0">
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span
                      className={
                        entry.level === 'error'
                          ? 'text-rose-600 font-semibold'
                          : entry.level === 'warn'
                            ? 'text-amber-600 font-semibold'
                            : 'text-slate-500'
                      }
                    >
                      {entry.level.toUpperCase()}
                    </span>
                    <span>{new Date(entry.created_at).toLocaleTimeString()}</span>
                  </div>
                  <p className="text-slate-700 mt-0.5 break-words">{entry.message}</p>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
