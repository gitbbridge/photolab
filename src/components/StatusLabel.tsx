import type {
  ConfidenceLevel,
  ImageDecision,
  PackageStatus,
  VerificationStatus,
} from '../types';

export function DecisionLabel({ decision }: { decision: ImageDecision }) {
  const styles: Record<ImageDecision, string> = {
    KEEP: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    SET_ASIDE: 'text-slate-700 bg-slate-100 border-slate-200',
    DUPLICATE: 'text-slate-600 bg-slate-50 border-slate-200',
    NEEDS_REVIEW: 'text-amber-700 bg-amber-50 border-amber-200',
  };
  const labels: Record<ImageDecision, string> = {
    KEEP: 'Keep',
    SET_ASIDE: 'Set Aside',
    DUPLICATE: 'Duplicate',
    NEEDS_REVIEW: 'Needs Review',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border rounded ${styles[decision]}`}
    >
      {labels[decision]}
    </span>
  );
}

export function VerificationLabel({ status }: { status: VerificationStatus }) {
  const styles: Record<VerificationStatus, string> = {
    VERIFIED: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    APPROVED: 'text-emerald-800 bg-emerald-100 border-emerald-300',
    PROPOSED: 'text-amber-700 bg-amber-50 border-amber-200',
    UNRESOLVED: 'text-rose-700 bg-rose-50 border-rose-200',
    REJECTED: 'text-rose-800 bg-rose-100 border-rose-300',
  };
  const labels: Record<VerificationStatus, string> = {
    VERIFIED: 'Verified',
    APPROVED: 'Approved',
    PROPOSED: 'Proposed',
    UNRESOLVED: 'Unresolved',
    REJECTED: 'Rejected',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border rounded ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

export function ConfidenceText({ confidence }: { confidence: ConfidenceLevel }) {
  const colors: Record<ConfidenceLevel, string> = {
    HIGH: 'text-emerald-700',
    MEDIUM: 'text-amber-700',
    LOW: 'text-slate-600',
    NONE: 'text-slate-400',
  };
  return <span className={`text-xs font-mono font-medium ${colors[confidence]}`}>{confidence}</span>;
}

export function PackageStatusLabel({ status }: { status: PackageStatus }) {
  const styles: Record<PackageStatus, string> = {
    pending: 'text-slate-600',
    extracting: 'text-blue-700',
    classifying: 'text-blue-700',
    discovering: 'text-indigo-700',
    completed: 'text-emerald-700',
    error: 'text-rose-700',
    skipped: 'text-slate-400',
  };
  const labels: Record<PackageStatus, string> = {
    pending: 'Pending',
    extracting: 'Inspecting Webpage',
    classifying: 'Classifying Photos',
    discovering: 'Discovering Supplier',
    completed: 'Completed',
    error: 'Error',
    skipped: 'Skipped (Duplicate URL)',
  };
  return <span className={`text-xs font-medium ${styles[status]}`}>{labels[status]}</span>;
}
