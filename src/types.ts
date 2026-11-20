export type JobMode = 'test_10' | 'custom' | 'all';

export type JobStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

export type PackageStatus =
  | 'pending'
  | 'extracting'
  | 'classifying'
  | 'discovering'
  | 'completed'
  | 'error'
  | 'skipped';

export type ImageDecision = 'KEEP' | 'SET_ASIDE' | 'DUPLICATE' | 'NEEDS_REVIEW';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type VerificationStatus =
  | 'VERIFIED'
  | 'PROPOSED'
  | 'APPROVED'
  | 'REJECTED'
  | 'UNRESOLVED';

export interface JobRecord {
  id: string;
  filename: string;
  mode: JobMode;
  url_limit: number | null;
  concurrency: number;
  status: JobStatus;
  total_rows_scanned: number;
  total_urls: number;
  unique_urls: number;
  duplicate_urls_count: number;
  empty_rows_count: number;
  processed_pages: number;
  images_discovered: number;
  images_classified: number;
  images_kept: number;
  suppliers_discovered: number;
  unresolved_count: number;
  error_count: number;
  prompt_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  serpapi_request_limit: number;
  serpapi_requests_made: number;
  serpapi_cache_hits: number;
  unique_verified_count: number;
  current_url: string | null;
  reverse_image_provider: string;
  created_at: string;
  updated_at: string;
}

export interface PackageUrlRecord {
  id: string;
  job_id: string;
  spreadsheet_row: number;
  package_url: string;
  normalized_url: string;
  is_duplicate_url: number;
  duplicate_of_row: number | null;
  status: PackageStatus;
  page_title: string | null;
  package_description: string | null;
  error_message: string | null;
  attempts: number;
  updated_at: string;
}

export interface ImageRecord {
  id: string;
  job_id: string;
  package_id: string;
  spreadsheet_row: number;
  package_url: string;
  image_url: string;
  local_path: string | null;
  mime_type: string | null;
  file_size: number;
  width: number | null;
  height: number | null;
  sha256: string | null;
  decision: ImageDecision;
  manual_decision: ImageDecision | null;
  effective_decision: ImageDecision;
  reason: string;
  duplicate_of: string | null;
  visual_summary: string | null;
  created_at: string;
}

export interface ReverseImageMatch {
  title: string;
  link: string;
  source: string;
  thumbnail?: string;
}

export interface SupplierRecord {
  id: string;
  job_id: string;
  package_id: string;
  spreadsheet_row: number;
  package_url: string;
  package_title: string | null;
  accommodation_name: string | null;
  property_type: string | null;
  city: string | null;
  country: string | null;
  direct_supplier_url: string | null;
  confidence: ConfidenceLevel;
  verification_status: VerificationStatus;
  evidence_urls: string[];
  image_urls: string[];
  unresolved_reason: string | null;
  notes: string | null;
  reverse_image_matches: ReverseImageMatch[];
  updated_at: string;
}

export interface JobLogRecord {
  id: number;
  job_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  package_url: string | null;
  created_at: string;
}

export interface SpreadsheetPreviewResult {
  uploadToken: string;
  filename: string;
  columnHeader: string;
  columnLetter: string;
  totalRowsScanned: number;
  emptyRowsIgnored: number;
  invalidRowsIgnored: number;
  duplicateUrlsDetected: number;
  uniqueValidUrls: number;
  totalValidEntries: number;
  previewRows: Array<{
    spreadsheetRow: number;
    url: string;
    isDuplicate: boolean;
    duplicateOfRow: number | null;
  }>;
  warnings: string[];
}

export interface SystemStatus {
  claudeConfigured: boolean;
  claudeModel: string;
  reverseImageProvider: {
    name: string;
    configured: boolean;
    envVar: string;
    description: string;
    maxRequestsPerRun: number;
    rateLimitPerMin: number;
  };
}
