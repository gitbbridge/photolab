import { useMemo, useState } from 'react';
import {
  Building2,
  Check,
  ExternalLink,
  RefreshCw,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import type { ImageRecord, SupplierRecord, VerificationStatus } from '../types';
import { ConfidenceText, VerificationLabel } from './StatusLabel';

interface SuppliersViewProps {
  suppliers: SupplierRecord[];
  images: ImageRecord[];
  onUpdateSupplier: (
    supplierId: string,
    updates: Partial<SupplierRecord>
  ) => Promise<void>;
  onRediscoverSupplier: (supplierId: string) => Promise<void>;
}

const STATUS_TABS: Array<{ key: 'ALL' | VerificationStatus; label: string }> = [
  { key: 'ALL', label: 'All Properties' },
  { key: 'VERIFIED', label: 'Verified' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'PROPOSED', label: 'Proposed' },
  { key: 'UNRESOLVED', label: 'Unresolved' },
  { key: 'REJECTED', label: 'Rejected' },
];

export function SuppliersView({
  suppliers,
  images,
  onUpdateSupplier,
  onRediscoverSupplier,
}: SuppliersViewProps) {
  const [filter, setFilter] = useState<'ALL' | VerificationStatus>('ALL');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SupplierRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [rediscovering, setRediscovering] = useState(false);

  // Editable form fields when drawer is open
  const [editForm, setEditForm] = useState<{
    accommodation_name: string;
    property_type: string;
    city: string;
    country: string;
    direct_supplier_url: string;
    notes: string;
  }>({
    accommodation_name: '',
    property_type: '',
    city: '',
    country: '',
    direct_supplier_url: '',
    notes: '',
  });

  const openReviewDrawer = (sup: SupplierRecord) => {
    setSelected(sup);
    setEditForm({
      accommodation_name: sup.accommodation_name || '',
      property_type: sup.property_type || '',
      city: sup.city || '',
      country: sup.country || '',
      direct_supplier_url: sup.direct_supplier_url || '',
      notes: sup.notes || '',
    });
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = {
      ALL: suppliers.length,
      VERIFIED: 0,
      APPROVED: 0,
      PROPOSED: 0,
      UNRESOLVED: 0,
      REJECTED: 0,
    };
    for (const s of suppliers) {
      map[s.verification_status] = (map[s.verification_status] || 0) + 1;
    }
    return map;
  }, [suppliers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return suppliers.filter((s) => {
      if (filter !== 'ALL' && s.verification_status !== filter) return false;
      if (!q) return true;
      return (
        (s.accommodation_name || '').toLowerCase().includes(q) ||
        (s.city || '').toLowerCase().includes(q) ||
        (s.country || '').toLowerCase().includes(q) ||
        (s.direct_supplier_url || '').toLowerCase().includes(q) ||
        s.package_url.toLowerCase().includes(q) ||
        (s.package_title || '').toLowerCase().includes(q) ||
        String(s.spreadsheet_row).includes(q)
      );
    });
  }, [suppliers, filter, query]);

  const selectedImages = useMemo(() => {
    if (!selected) return [];
    return images.filter(
      (img) =>
        img.package_id === selected.package_id &&
        (img.effective_decision === 'KEEP' || img.effective_decision === 'NEEDS_REVIEW')
    );
  }, [images, selected]);

  const handleSaveStatus = async (status?: VerificationStatus) => {
    if (!selected) return;
    setSaving(true);
    try {
      const payload: Partial<SupplierRecord> = {
        accommodation_name: editForm.accommodation_name.trim() || null,
        property_type: editForm.property_type.trim() || null,
        city: editForm.city.trim() || null,
        country: editForm.country.trim() || null,
        direct_supplier_url: editForm.direct_supplier_url.trim() || null,
        notes: editForm.notes.trim() || null,
      };
      if (status) {
        payload.verification_status = status;
        if (status === 'REJECTED') {
          payload.unresolved_reason = 'Supplier match rejected during user review.';
        } else if (status === 'APPROVED') {
          payload.unresolved_reason = null;
        }
      }
      await onUpdateSupplier(selected.id, payload);
      setSelected((prev) =>
        prev
          ? {
              ...prev,
              ...payload,
              verification_status: status ?? prev.verification_status,
            }
          : null
      );
    } finally {
      setSaving(false);
    }
  };

  const handleRediscover = async () => {
    if (!selected) return;
    setRediscovering(true);
    try {
      await onRediscoverSupplier(selected.id);
      setSelected(null);
    } finally {
      setRediscovering(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Filter & Search Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
                filter === tab.key
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label} ({counts[tab.key] ?? 0})
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search supplier, location, or URL..."
            className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Suppliers Data Table */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <Building2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-slate-800">No supplier records match this view</p>
          <p className="text-xs text-slate-500 mt-1">
            Verified accommodation suppliers and unresolved packages will appear here as pages complete.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="py-3 px-4 font-medium w-16">Row</th>
                  <th className="py-3 px-4 font-medium">Package Listing</th>
                  <th className="py-3 px-4 font-medium">Accommodation Supplier</th>
                  <th className="py-3 px-4 font-medium">Location</th>
                  <th className="py-3 px-4 font-medium">Direct Supplier Website</th>
                  <th className="py-3 px-4 font-medium w-24">Confidence</th>
                  <th className="py-3 px-4 font-medium w-28">Status</th>
                  <th className="py-3 px-4 font-medium w-24 text-right">Review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => openReviewDrawer(s)}
                    className="hover:bg-slate-50/80 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500 align-top">
                      #{s.spreadsheet_row}
                    </td>
                    <td className="py-3 px-4 align-top max-w-[260px]">
                      <p className="font-medium text-slate-900 truncate">
                        {s.package_title || 'Untitled Package'}
                      </p>
                      <a
                        href={s.package_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-[11px] text-slate-500 hover:text-blue-700 hover:underline truncate block mt-0.5"
                      >
                        {s.package_url}
                      </a>
                    </td>
                    <td className="py-3 px-4 align-top">
                      <p className="font-semibold text-slate-900">
                        {s.accommodation_name || 'Unidentified'}
                      </p>
                      {s.property_type && (
                        <p className="text-slate-500 mt-0.5">{s.property_type}</p>
                      )}
                    </td>
                    <td className="py-3 px-4 align-top text-slate-700 whitespace-nowrap">
                      {[s.city, s.country].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td className="py-3 px-4 align-top max-w-[240px]">
                      {s.direct_supplier_url ? (
                        <a
                          href={s.direct_supplier_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="font-mono text-blue-700 hover:underline inline-flex items-center gap-1 break-all"
                        >
                          {s.direct_supplier_url}
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </a>
                      ) : (
                        <span className="text-slate-400">
                          {s.unresolved_reason ? 'No verified direct URL' : '—'}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 align-top">
                      <ConfidenceText confidence={s.confidence} />
                    </td>
                    <td className="py-3 px-4 align-top">
                      <VerificationLabel status={s.verification_status} />
                    </td>
                    <td className="py-3 px-4 align-top text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openReviewDrawer(s);
                        }}
                        className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50"
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Supplier Verification Drawer */}
      {selected && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/50 flex justify-end"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-white w-full max-w-2xl h-full overflow-y-auto border-l border-slate-200 p-6 space-y-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
              <div>
                <div className="flex items-center gap-2 text-xs text-slate-500 font-mono">
                  <span>Row #{selected.spreadsheet_row}</span>
                  <span aria-hidden="true">·</span>
                  <VerificationLabel status={selected.verification_status} />
                  <span aria-hidden="true">·</span>
                  <ConfidenceText confidence={selected.confidence} />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 mt-1">
                  {selected.package_title || 'Supplier Verification Review'}
                </h3>
                <a
                  href={selected.package_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono text-blue-700 hover:underline inline-flex items-center gap-1 mt-1 break-all"
                >
                  {selected.package_url}
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Retained Accommodation Photographs */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                  Photographic Evidence ({selectedImages.length})
                </h4>
                <button
                  type="button"
                  disabled={rediscovering}
                  onClick={() => void handleRediscover()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${rediscovering ? 'animate-spin' : ''}`} />
                  {rediscovering ? 'Searching...' : 'Re-run Discovery'}
                </button>
              </div>
              {selectedImages.length === 0 ? (
                <p className="text-xs text-slate-500 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  No accommodation photographs currently marked KEEP or NEEDS REVIEW for this package.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {selectedImages.map((img) => (
                    <a
                      key={img.id}
                      href={img.image_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open original image in new tab"
                      className="group relative aspect-[4/3] bg-slate-100 rounded-lg overflow-hidden border border-slate-200"
                    >
                      <img
                        src={`/api/images/${img.id}/file`}
                        alt={img.reason}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                      />
                    </a>
                  ))}
                </div>
              )}
            </div>

            {/* Editable Supplier Fields */}
            <div className="space-y-3 pt-2 border-t border-slate-200">
              <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Supplier Identification
              </h4>

              {selected.unresolved_reason && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
                  {selected.unresolved_reason}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Accommodation Name
                  </label>
                  <input
                    type="text"
                    value={editForm.accommodation_name}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, accommodation_name: e.target.value }))
                    }
                    placeholder="e.g., Four Seasons Resort Bali"
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Property Type
                  </label>
                  <input
                    type="text"
                    value={editForm.property_type}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, property_type: e.target.value }))
                    }
                    placeholder="Resort, Boutique Hotel, Villa..."
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">City</label>
                  <input
                    type="text"
                    value={editForm.city}
                    onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))}
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Country</label>
                  <input
                    type="text"
                    value={editForm.country}
                    onChange={(e) => setEditForm((f) => ({ ...f, country: e.target.value }))}
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Direct Supplier Website URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={editForm.direct_supplier_url}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, direct_supplier_url: e.target.value }))
                    }
                    placeholder="https://www.property-website.com"
                    className="flex-1 px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg"
                  />
                  {editForm.direct_supplier_url && (
                    <a
                      href={editForm.direct_supplier_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100"
                    >
                      Visit
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Research Notes
                </label>
                <textarea
                  rows={3}
                  value={editForm.notes}
                  onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg"
                />
              </div>
            </div>

            {/* Supporting Grounded Evidence URLs */}
            <div className="space-y-2 pt-2 border-t border-slate-200">
              <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Supporting Evidence URLs ({selected.evidence_urls.length})
              </h4>
              {selected.evidence_urls.length === 0 ? (
                <p className="text-xs text-slate-400">No grounded web URLs recorded.</p>
              ) : (
                <ul className="space-y-1.5">
                  {selected.evidence_urls.map((url, idx) => (
                    <li key={idx}>
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-mono text-blue-700 hover:underline inline-flex items-center gap-1 break-all"
                      >
                        {url}
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Review Action Bar */}
            <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveStatus('APPROVED')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                  Approve Match
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveStatus('REJECTED')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 disabled:opacity-50"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Reject Match
                </button>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSaveStatus()}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Edits'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
