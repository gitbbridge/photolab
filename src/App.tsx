import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Building2,
  Compass,
  Download,
  Image as ImageIcon,
  LayoutDashboard,
  Menu,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import { DashboardView } from './components/DashboardView';
import { ExportsView } from './components/ExportsView';
import { ImagesView } from './components/ImagesView';
import { ProcessingView } from './components/ProcessingView';
import { SuppliersView } from './components/SuppliersView';
import type {
  ImageDecision,
  ImageRecord,
  JobLogRecord,
  JobRecord,
  PackageUrlRecord,
  SupplierRecord,
  SystemStatus,
} from './types';

type NavTab = 'dashboard' | 'processing' | 'images' | 'suppliers' | 'exports';

const NAV_ITEMS: Array<{ id: NavTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'processing', label: 'Processing', icon: Activity },
  { id: 'images', label: 'Images', icon: ImageIcon },
  { id: 'suppliers', label: 'Suppliers', icon: Building2 },
  { id: 'exports', label: 'Exports', icon: Download },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showProviderModal, setShowProviderModal] = useState(false);

  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const [activeJob, setActiveJob] = useState<JobRecord | null>(null);
  const [packages, setPackages] = useState<PackageUrlRecord[]>([]);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [logs, setLogs] = useState<JobLogRecord[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const fetchSystemAndJobs = useCallback(async () => {
    try {
      const [sysRes, jobsRes] = await Promise.all([
        fetch('/api/system/status'),
        fetch('/api/jobs'),
      ]);
      if (sysRes.ok) {
        setSystemStatus((await sysRes.json()) as SystemStatus);
      }
      if (jobsRes.ok) {
        const data = (await jobsRes.json()) as { jobs: JobRecord[] };
        setJobs(data.jobs);
        setActiveJobId((prev) => {
          if (prev && data.jobs.some((j) => j.id === prev)) return prev;
          return data.jobs[0]?.id ?? null;
        });
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to connect to backend.');
    }
  }, []);

  const fetchJobDetail = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        job: JobRecord;
        packages: PackageUrlRecord[];
        images: ImageRecord[];
        suppliers: SupplierRecord[];
        logs: JobLogRecord[];
      };
      setActiveJob(data.job);
      setPackages(data.packages);
      setImages(data.images);
      setSuppliers(data.suppliers);
      setLogs(data.logs);
      setJobs((prev) => prev.map((j) => (j.id === data.job.id ? data.job : j)));
    } catch {
      // Transient polling errors ignored cleanly
    }
  }, []);

  useEffect(() => {
    void fetchSystemAndJobs();
  }, [fetchSystemAndJobs]);

  useEffect(() => {
    if (!activeJobId) {
      setActiveJob(null);
      setPackages([]);
      setImages([]);
      setSuppliers([]);
      setLogs([]);
      return;
    }

    void fetchJobDetail(activeJobId);

    const es = new EventSource(`/api/jobs/${activeJobId}/stream`);
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as { type: string; job?: JobRecord };
        if (parsed.type === 'job' && parsed.job) {
          setActiveJob(parsed.job);
          setJobs((prev) => prev.map((j) => (j.id === parsed.job!.id ? parsed.job! : j)));
          void fetchJobDetail(activeJobId);
        }
      } catch {
        // Ignore malformed SSE ping
      }
    };

    return () => {
      es.close();
    };
  }, [activeJobId, fetchJobDetail]);

  const handleJobCreated = (job: JobRecord) => {
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setActiveJobId(job.id);
    setActiveJob(job);
  };

  const handlePause = async () => {
    if (!activeJobId) return;
    await fetch(`/api/jobs/${activeJobId}/pause`, { method: 'POST' });
    await fetchJobDetail(activeJobId);
  };

  const handleResume = async () => {
    if (!activeJobId) return;
    await fetch(`/api/jobs/${activeJobId}/resume`, { method: 'POST' });
    await fetchJobDetail(activeJobId);
  };

  const handleRetryFailed = async () => {
    if (!activeJobId) return;
    await fetch(`/api/jobs/${activeJobId}/retry-failed`, { method: 'POST' });
    await fetchJobDetail(activeJobId);
  };

  const handleChangeConcurrency = async (val: number) => {
    if (!activeJobId) return;
    await fetch(`/api/jobs/${activeJobId}/concurrency`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: val }),
    });
    await fetchJobDetail(activeJobId);
  };

  const handleDeleteJob = async (jobId: string) => {
    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    const remaining = jobs.filter((j) => j.id !== jobId);
    setJobs(remaining);
    if (activeJobId === jobId) {
      setActiveJobId(remaining[0]?.id ?? null);
    }
  };

  const handleReclassifyImage = async (imageId: string, decision: ImageDecision) => {
    const res = await fetch(`/api/images/${imageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    if (res.ok && activeJobId) {
      await fetchJobDetail(activeJobId);
    }
  };

  const handleUpdateSupplier = async (
    supplierId: string,
    updates: Partial<SupplierRecord>
  ) => {
    const res = await fetch(`/api/suppliers/${supplierId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok && activeJobId) {
      await fetchJobDetail(activeJobId);
    }
  };

  const handleRediscoverSupplier = async (supplierId: string) => {
    const res = await fetch(`/api/suppliers/${supplierId}/rediscover`, {
      method: 'POST',
    });
    if (!res.ok) {
      const data = await res.json();
      setErrorBanner(data.error || 'Supplier rediscovery failed.');
      return;
    }
    if (activeJobId) {
      await fetchJobDetail(activeJobId);
    }
  };

  const tabTitles: Record<NavTab, string> = {
    dashboard: 'Dashboard & Spreadsheet Upload',
    processing: 'Live Processing Queue',
    images: 'Image Classification Review',
    suppliers: 'Accommodation Suppliers',
    exports: 'Export Research Files',
  };

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar Navigation */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-slate-200 flex flex-col justify-between transition-transform lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-5 space-y-6 overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-blue-700 text-white flex items-center justify-center shrink-0">
                <Compass className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold tracking-tight text-slate-900 truncate">
                  Give Holidays
                </p>
                <p className="text-[11px] text-slate-500 truncate">Supplier Discovery</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="lg:hidden p-1 rounded text-slate-500 hover:bg-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <nav className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-blue-50 text-blue-800'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className={`w-4 h-4 ${active ? 'text-blue-700' : 'text-slate-400'}`} />
                    {item.label}
                  </span>
                  {item.id === 'images' && images.length > 0 && (
                    <span className="text-xs font-mono tabular-nums text-slate-400">
                      {images.length}
                    </span>
                  )}
                  {item.id === 'suppliers' && suppliers.length > 0 && (
                    <span className="text-xs font-mono tabular-nums text-slate-400">
                      {suppliers.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Saved Persistent Runs */}
          {jobs.length > 0 && (
            <div className="pt-4 border-t border-slate-200 space-y-2">
              <p className="px-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Saved Runs ({jobs.length})
              </p>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {jobs.map((job) => {
                  const selected = job.id === activeJobId;
                  return (
                    <div
                      key={job.id}
                      className={`group flex items-center justify-between gap-1 px-2.5 py-2 rounded-lg text-xs cursor-pointer transition-colors ${
                        selected
                          ? 'bg-slate-100 text-slate-900 font-medium'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                      onClick={() => {
                        setActiveJobId(job.id);
                        setMobileMenuOpen(false);
                      }}
                    >
                      <div className="min-w-0">
                        <p className="truncate">{job.filename}</p>
                        <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                          {job.processed_pages}/{job.total_urls} · {job.status}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteJob(job.id);
                        }}
                        title="Delete saved run"
                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-rose-600 transition-opacity"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-200">
          <button
            type="button"
            onClick={() => setShowProviderModal(true)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <span className="flex items-center gap-2 truncate">
              <Settings2 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span className="truncate">Search Provider Config</span>
            </span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Workspace Header */}
        <header className="h-14 bg-white border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded-lg text-slate-600 hover:bg-slate-100"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="font-semibold text-slate-900 whitespace-nowrap">
                {tabTitles[activeTab]}
              </span>
              {activeJob && (
                <>
                  <span className="text-slate-300 hidden sm:inline" aria-hidden="true">/</span>
                  <span className="text-slate-500 truncate hidden sm:inline font-mono text-xs">
                    {activeJob.filename}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {activeJob && (
              <button
                type="button"
                onClick={() => setActiveTab('exports')}
                className="px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
              >
                Download Exports
              </button>
            )}
          </div>
        </header>

        {/* Error Toast Banner */}
        {errorBanner && (
          <div className="mx-4 lg:mx-8 mt-4 p-3 bg-rose-50 border border-rose-200 rounded-lg flex items-center justify-between text-xs text-rose-800">
            <span>{errorBanner}</span>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="p-1 text-rose-600 hover:text-rose-900"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {systemStatus && !systemStatus.reverseImageProvider.configured && (
          <div className="mx-4 lg:mx-8 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
            <strong>Google Lens is disabled.</strong> Add BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE to the project .env file and restart the server to enable reverse-image matching. Current results use Claude web search only.
          </div>
        )}

        {/* Active View Viewport */}
        <main className="flex-1 p-4 lg:p-8 max-w-[1440px] w-full mx-auto">
          {activeTab === 'dashboard' && (
            <DashboardView
              activeJob={activeJob}
              packages={packages}
              systemStatus={systemStatus}
              onJobCreated={handleJobCreated}
              onNavigate={setActiveTab}
              onRetryFailed={handleRetryFailed}
            />
          )}
          {activeTab === 'processing' && (
            <ProcessingView
              job={activeJob}
              packages={packages}
              logs={logs}
              onPause={handlePause}
              onResume={handleResume}
              onRetryFailed={handleRetryFailed}
              onChangeConcurrency={handleChangeConcurrency}
            />
          )}
          {activeTab === 'images' && (
            <ImagesView images={images} onReclassify={handleReclassifyImage} />
          )}
          {activeTab === 'suppliers' && (
            <SuppliersView
              suppliers={suppliers}
              images={images}
              onUpdateSupplier={handleUpdateSupplier}
              onRediscoverSupplier={handleRediscoverSupplier}
            />
          )}
          {activeTab === 'exports' && (
            <ExportsView
              job={activeJob}
              suppliers={suppliers}
              images={images}
              packages={packages}
            />
          )}
        </main>
      </div>

      {/* Reverse-Image Provider Configuration Modal (read-only status, no API key inputs) */}
      {showProviderModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4"
          onClick={() => setShowProviderModal(false)}
        >
          <div
            className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Supplier & Reverse-Image Integration
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Server-side research engine configuration status
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowProviderModal(false)}
                className="p-1 rounded-lg text-slate-500 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-900">
                    Claude Visual Inspection & Claude Web Search
                  </span>
                  <span
                    className={
                      systemStatus?.claudeConfigured
                        ? 'text-emerald-700 font-medium'
                        : 'text-rose-700 font-medium'
                    }
                  >
                    {systemStatus?.claudeConfigured ? 'Configured' : 'Missing Secret'}
                  </span>
                </div>
                <p className="text-slate-600">
                  Model: <span className="font-mono">{systemStatus?.claudeModel || 'claude-sonnet-5-5'}</span>
                </p>
              </div>

              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-900">
                    Google Lens Reverse-Image Provider (Bright Data)
                  </span>
                  <span
                    className={
                      systemStatus?.reverseImageProvider.configured
                        ? 'text-emerald-700 font-medium'
                        : 'text-amber-700 font-medium'
                    }
                  >
                    {systemStatus?.reverseImageProvider.configured
                      ? 'Active'
                      : 'Optional · Not Set'}
                  </span>
                </div>
                <p className="text-slate-600 leading-relaxed">
                  {systemStatus?.reverseImageProvider.description}
                </p>
                {systemStatus?.reverseImageProvider.configured && (
                  <p className="text-slate-600 font-mono tabular-nums pt-1">
                    Enforced guardrails: {systemStatus.reverseImageProvider.maxRequestsPerRun} req/run max · {systemStatus.reverseImageProvider.rateLimitPerMin} req/min max · SQLite result caching active
                  </p>
                )}
                {!systemStatus?.reverseImageProvider.configured && (
                  <p className="text-slate-500 pt-1">
                    To enable external Google Lens visual matching, set{' '}
                    <code className="font-mono bg-white border border-slate-200 px-1 py-0.5 rounded">
                      BRIGHTDATA_API_KEY + BRIGHTDATA_SERP_ZONE
                    </code>{' '}
                    in the project .env file and restart the server.
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setShowProviderModal(false)}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
