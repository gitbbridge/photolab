import { Archive, Download, FileSpreadsheet, FileText } from 'lucide-react';
import type { ImageRecord, JobRecord, PackageUrlRecord, SupplierRecord } from '../types';

interface ExportsViewProps {
  job: JobRecord | null;
  suppliers: SupplierRecord[];
  images: ImageRecord[];
  packages: PackageUrlRecord[];
}

export function ExportsView({ job, suppliers, images, packages }: ExportsViewProps) {
  if (!job) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <p className="text-sm text-slate-500">
          Select or run a discovery job first to download research exports.
        </p>
      </div>
    );
  }

  const keptCount = images.filter((i) => i.effective_decision === 'KEEP').length;
  const unresolvedSuppliersCount =
    suppliers.filter(
      (s) => s.verification_status === 'UNRESOLVED' || s.verification_status === 'REJECTED'
    ).length +
    packages.filter(
      (p) =>
        p.is_duplicate_url === 0 &&
        p.status === 'error' &&
        !suppliers.some((s) => s.package_id === p.id)
    ).length;

  const cards = [
    {
      title: 'Supplier_Results.xlsx',
      subtitle: 'Excel Workbook · Verified & Proposed Accommodation Suppliers',
      count: `${suppliers.length} supplier rows`,
      columns:
        'spreadsheet_row, package_url, package_title, accommodation_name, property_type, city, country, direct_supplier_url, confidence, verification_status, evidence_urls, image_urls',
      href: `/api/jobs/${job.id}/export/suppliers.xlsx`,
      filename: 'Supplier_Results.xlsx',
      icon: FileSpreadsheet,
    },
    {
      title: 'Image_Classification.csv',
      subtitle: 'CSV Report · Every Examined Photograph & Effective Decision',
      count: `${images.length} image rows`,
      columns: 'spreadsheet_row, package_url, image_url, decision, reason, duplicate_of',
      href: `/api/jobs/${job.id}/export/images.csv`,
      filename: 'Image_Classification.csv',
      icon: FileText,
    },
    {
      title: 'Unresolved_Suppliers.csv',
      subtitle: 'CSV Queue · Packages Requiring Further Investigation',
      count: `${unresolvedSuppliersCount} unresolved rows`,
      columns: 'spreadsheet_row, package_url, package_title, relevant_image_urls, unresolved_reason',
      href: `/api/jobs/${job.id}/export/unresolved.csv`,
      filename: 'Unresolved_Suppliers.csv',
      icon: FileText,
    },
    {
      title: 'Accommodation_Images.zip',
      subtitle: 'ZIP Archive · Original-Quality Retained Accommodation Photos',
      count: `${keptCount} retained KEEP photos`,
      columns: 'Organized into row_XXXX_<package_domain>/image_01.jpg folders preserving original binary quality.',
      href: `/api/jobs/${job.id}/export/images.zip`,
      filename: `Accommodation_Images_${job.id.slice(0, 8)}.zip`,
      icon: Archive,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Export Research Files — {job.filename}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            All exports reflect your latest manual image reclassifications and supplier approvals/rejections.
          </p>
        </div>
        <div className="text-xs font-mono tabular-nums text-slate-600 flex flex-wrap items-center gap-3">
          <span>Bright Data: {job.serpapi_requests_made}/{job.serpapi_request_limit || 100} used</span>
          <span aria-hidden="true">·</span>
          <span>{Math.max(0, (job.serpapi_request_limit || 100) - job.serpapi_requests_made)} remaining</span>
          <span aria-hidden="true">·</span>
          <span>{job.unique_verified_count} unique verified</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.title}
              className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
            >
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center shrink-0">
                      <Icon className="w-4 h-4 text-blue-700" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold font-mono text-slate-900">
                        {card.title}
                      </h3>
                      <p className="text-xs text-slate-500">{card.subtitle}</p>
                    </div>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-slate-700 font-medium whitespace-nowrap">
                    {card.count}
                  </span>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg">
                  <p className="text-[11px] font-mono text-slate-600 leading-relaxed break-words">
                    {card.columns}
                  </p>
                </div>
              </div>

              <div className="flex justify-end">
                <a
                  href={card.href}
                  download={card.filename}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download {card.title}
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
