import { useMemo, useState } from 'react';
import { ExternalLink, Image as ImageIcon, Search, X } from 'lucide-react';
import type { ImageDecision, ImageRecord } from '../types';
import { DecisionLabel } from './StatusLabel';

interface ImagesViewProps {
  images: ImageRecord[];
  onReclassify: (imageId: string, decision: ImageDecision) => Promise<void>;
}

const DECISIONS: Array<{ key: 'ALL' | ImageDecision; label: string }> = [
  { key: 'ALL', label: 'All Photos' },
  { key: 'KEEP', label: 'Keep' },
  { key: 'SET_ASIDE', label: 'Set Aside' },
  { key: 'DUPLICATE', label: 'Duplicate' },
  { key: 'NEEDS_REVIEW', label: 'Needs Review' },
];

export function ImagesView({ images, onReclassify }: ImagesViewProps) {
  const [filter, setFilter] = useState<'ALL' | ImageDecision>('ALL');
  const [query, setQuery] = useState('');
  const [selectedImage, setSelectedImage] = useState<ImageRecord | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [brokenIds, setBrokenIds] = useState<Set<string>>(new Set());

  const counts = useMemo(() => {
    const map: Record<string, number> = {
      ALL: images.length,
      KEEP: 0,
      SET_ASIDE: 0,
      DUPLICATE: 0,
      NEEDS_REVIEW: 0,
    };
    for (const img of images) {
      map[img.effective_decision] = (map[img.effective_decision] || 0) + 1;
    }
    return map;
  }, [images]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return images.filter((img) => {
      if (filter !== 'ALL' && img.effective_decision !== filter) return false;
      if (!q) return true;
      return (
        img.package_url.toLowerCase().includes(q) ||
        img.image_url.toLowerCase().includes(q) ||
        img.reason.toLowerCase().includes(q) ||
        String(img.spreadsheet_row).includes(q)
      );
    });
  }, [images, filter, query]);

  const handleDecision = async (imageId: string, decision: ImageDecision) => {
    setUpdatingId(imageId);
    try {
      await onReclassify(imageId, decision);
      if (selectedImage?.id === imageId) {
        setSelectedImage((prev) =>
          prev
            ? {
                ...prev,
                manual_decision: decision,
                effective_decision: decision,
              }
            : null
        );
      }
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Filter & Search Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {DECISIONS.map((tab) => (
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
            placeholder="Filter by row, URL, or reason..."
            className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Gallery Grid */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <ImageIcon className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-slate-800">No images match this filter</p>
          <p className="text-xs text-slate-500 mt-1">
            Images extracted from package listings will appear here as Claude classifies them.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((img) => {
            const isBroken = brokenIds.has(img.id);
            return (
              <article
                key={img.id}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col"
              >
                <button
                  type="button"
                  onClick={() => setSelectedImage(img)}
                  className="relative aspect-[4/3] w-full bg-slate-100 overflow-hidden group text-left"
                >
                  {!isBroken ? (
                    <img
                      src={`/api/images/${img.id}/file`}
                      alt={`Row ${img.spreadsheet_row} photograph`}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setBrokenIds((prev) => new Set(prev).add(img.id))
                      }
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-200"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center p-4 text-slate-400 bg-slate-50">
                      <ImageIcon className="w-7 h-7 mb-1.5" />
                      <span className="text-xs text-center truncate max-w-full">
                        Preview unavailable
                      </span>
                    </div>
                  )}
                </button>

                <div className="p-3.5 flex-1 flex flex-col justify-between gap-3">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-slate-500 font-mono tabular-nums truncate">
                        <span>Row #{img.spreadsheet_row}</span>
                        {img.width && img.height && (
                          <>
                            <span className="mx-1.5" aria-hidden="true">·</span>
                            <span>{img.width}×{img.height}</span>
                          </>
                        )}
                      </div>
                      <DecisionLabel decision={img.effective_decision} />
                    </div>
                    <p className="text-xs text-slate-700 mt-2 line-clamp-2" title={img.reason}>
                      {img.reason}
                    </p>
                  </div>

                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-1">
                    {(['KEEP', 'SET_ASIDE', 'DUPLICATE', 'NEEDS_REVIEW'] as ImageDecision[]).map(
                      (choice) => {
                        const shortLabel =
                          choice === 'KEEP'
                            ? 'Keep'
                            : choice === 'SET_ASIDE'
                              ? 'Aside'
                              : choice === 'DUPLICATE'
                                ? 'Dup'
                                : 'Review';
                        const active = img.effective_decision === choice;
                        return (
                          <button
                            key={choice}
                            type="button"
                            disabled={updatingId === img.id}
                            onClick={() => void handleDecision(img.id, choice)}
                            className={`flex-1 py-1 text-[11px] font-medium rounded border transition-colors ${
                              active
                                ? 'bg-slate-900 text-white border-slate-900'
                                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            {shortLabel}
                          </button>
                        );
                      }
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Full Image Review Modal */}
      {selectedImage && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4"
          onClick={() => setSelectedImage(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="md:w-3/5 bg-slate-950 flex items-center justify-center min-h-[280px] max-h-[65vh] md:max-h-[90vh]">
              <img
                src={`/api/images/${selectedImage.id}/file`}
                alt={`Row ${selectedImage.spreadsheet_row} full preview`}
                referrerPolicy="no-referrer"
                className="max-w-full max-h-full object-contain"
              />
            </div>

            <div className="md:w-2/5 p-5 flex flex-col justify-between overflow-y-auto space-y-4">
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-mono text-slate-500">
                      Spreadsheet Row #{selectedImage.spreadsheet_row}
                    </p>
                    <h3 className="text-base font-semibold text-slate-900 mt-0.5">
                      Photograph Inspection
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedImage(null)}
                    className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
                    aria-label="Close modal"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <DecisionLabel decision={selectedImage.effective_decision} />
                  {selectedImage.manual_decision && (
                    <span className="text-xs text-slate-500">
                      (Manually overridden from {selectedImage.decision})
                    </span>
                  )}
                </div>

                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Classification Reason</p>
                  <p className="text-sm text-slate-800">{selectedImage.reason}</p>
                </div>

                {selectedImage.visual_summary && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">Visual Summary</p>
                    <p className="text-xs text-slate-700 leading-relaxed">
                      {selectedImage.visual_summary}
                    </p>
                  </div>
                )}

                {selectedImage.duplicate_of && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-slate-500">Duplicate Of</p>
                    <a
                      href={selectedImage.duplicate_of}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-mono text-blue-700 hover:underline break-all"
                    >
                      {selectedImage.duplicate_of}
                    </a>
                  </div>
                )}

                <div className="space-y-1.5 pt-2 border-t border-slate-100 text-xs">
                  <a
                    href={selectedImage.image_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-blue-700 hover:underline font-medium"
                  >
                    Open Original Image URL
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <br />
                  <a
                    href={selectedImage.package_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900 hover:underline"
                  >
                    Open Source Package Webpage
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-200 space-y-2">
                <p className="text-xs font-medium text-slate-700">Manual Override</p>
                <div className="grid grid-cols-2 gap-2">
                  {(['KEEP', 'SET_ASIDE', 'DUPLICATE', 'NEEDS_REVIEW'] as ImageDecision[]).map(
                    (choice) => (
                      <button
                        key={choice}
                        type="button"
                        disabled={updatingId === selectedImage.id}
                        onClick={() => void handleDecision(selectedImage.id, choice)}
                        className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                          selectedImage.effective_decision === choice
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {choice === 'KEEP'
                          ? 'Mark Keep'
                          : choice === 'SET_ASIDE'
                            ? 'Mark Set Aside'
                            : choice === 'DUPLICATE'
                              ? 'Mark Duplicate'
                              : 'Needs Review'}
                      </button>
                    )
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
