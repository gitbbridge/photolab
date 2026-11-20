import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ConfidenceLevel,
  ImageDecision,
  ImageRecord,
  JobLogRecord,
  JobMode,
  JobRecord,
  JobStatus,
  PackageStatus,
  PackageUrlRecord,
  ReverseImageMatch,
  SupplierRecord,
  VerificationStatus,
} from '../../src/types.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DB_PATH = path.join(DATA_DIR, 'giveholidays.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrency between reads and writes
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mode TEXT NOT NULL,
    url_limit INTEGER,
    concurrency INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'pending',
    total_rows_scanned INTEGER NOT NULL DEFAULT 0,
    total_urls INTEGER NOT NULL DEFAULT 0,
    unique_urls INTEGER NOT NULL DEFAULT 0,
    duplicate_urls_count INTEGER NOT NULL DEFAULT 0,
    empty_rows_count INTEGER NOT NULL DEFAULT 0,
    processed_pages INTEGER NOT NULL DEFAULT 0,
    images_discovered INTEGER NOT NULL DEFAULT 0,
    images_classified INTEGER NOT NULL DEFAULT 0,
    images_kept INTEGER NOT NULL DEFAULT 0,
    suppliers_discovered INTEGER NOT NULL DEFAULT 0,
    unresolved_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    serpapi_request_limit INTEGER NOT NULL DEFAULT 100,
    serpapi_requests_made INTEGER NOT NULL DEFAULT 0,
    serpapi_cache_hits INTEGER NOT NULL DEFAULT 0,
    unique_verified_count INTEGER NOT NULL DEFAULT 0,
    current_url TEXT,
    reverse_image_provider TEXT NOT NULL DEFAULT 'Claude Vision + Web Search',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS package_urls (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    spreadsheet_row INTEGER NOT NULL,
    package_url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    is_duplicate_url INTEGER NOT NULL DEFAULT 0,
    duplicate_of_row INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    page_title TEXT,
    package_description TEXT,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_package_urls_job ON package_urls(job_id, spreadsheet_row);

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    package_id TEXT NOT NULL,
    spreadsheet_row INTEGER NOT NULL,
    package_url TEXT NOT NULL,
    image_url TEXT NOT NULL,
    local_path TEXT,
    mime_type TEXT,
    file_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    sha256 TEXT,
    decision TEXT NOT NULL,
    manual_decision TEXT,
    reason TEXT NOT NULL,
    duplicate_of TEXT,
    visual_summary TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (package_id) REFERENCES package_urls(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_images_job ON images(job_id, decision);
  CREATE INDEX IF NOT EXISTS idx_images_pkg ON images(package_id);

  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    package_id TEXT NOT NULL UNIQUE,
    spreadsheet_row INTEGER NOT NULL,
    package_url TEXT NOT NULL,
    package_title TEXT,
    accommodation_name TEXT,
    property_type TEXT,
    city TEXT,
    country TEXT,
    direct_supplier_url TEXT,
    confidence TEXT NOT NULL DEFAULT 'NONE',
    verification_status TEXT NOT NULL DEFAULT 'UNRESOLVED',
    evidence_urls TEXT NOT NULL DEFAULT '[]',
    image_urls TEXT NOT NULL DEFAULT '[]',
    unresolved_reason TEXT,
    notes TEXT,
    reverse_image_matches TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (package_id) REFERENCES package_urls(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_suppliers_job ON suppliers(job_id, verification_status);

  CREATE TABLE IF NOT EXISTS job_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    package_url TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id DESC);

  CREATE TABLE IF NOT EXISTS serpapi_cache (
    cache_key TEXT PRIMARY KEY,
    engine TEXT NOT NULL,
    query_url TEXT NOT NULL,
    response_json TEXT NOT NULL,
    discovered_urls TEXT NOT NULL DEFAULT '[]',
    http_status INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS serpapi_request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_serpapi_req_time ON serpapi_request_log(created_at_ms DESC);
`);

// Safe migrations if an earlier database file already exists on disk
for (const alterSql of [
  'ALTER TABLE jobs ADD COLUMN serpapi_request_limit INTEGER NOT NULL DEFAULT 100;',
  'ALTER TABLE jobs ADD COLUMN serpapi_requests_made INTEGER NOT NULL DEFAULT 0;',
  'ALTER TABLE jobs ADD COLUMN serpapi_cache_hits INTEGER NOT NULL DEFAULT 0;',
  'ALTER TABLE jobs ADD COLUMN unique_verified_count INTEGER NOT NULL DEFAULT 0;',
]) {
  try {
    db.exec(alterSql);
  } catch {
    // Column already exists
  }
}

export function getImagesDirForJob(jobId: string): string {
  const dir = path.join(IMAGES_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createJobRecord(params: {
  id: string;
  filename: string;
  mode: JobMode;
  urlLimit: number | null;
  concurrency: number;
  totalRowsScanned: number;
  totalUrls: number;
  uniqueUrls: number;
  duplicateUrlsCount: number;
  emptyRowsCount: number;
  reverseImageProvider: string;
}): JobRecord {
  const now = nowIso();
  db.prepare(`
    INSERT INTO jobs (
      id, filename, mode, url_limit, concurrency, status,
      total_rows_scanned, total_urls, unique_urls, duplicate_urls_count, empty_rows_count,
      reverse_image_provider, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.filename,
    params.mode,
    params.urlLimit,
    params.concurrency,
    params.totalRowsScanned,
    params.totalUrls,
    params.uniqueUrls,
    params.duplicateUrlsCount,
    params.emptyRowsCount,
    params.reverseImageProvider,
    now,
    now
  );
  return getJob(params.id)!;
}

export function insertPackageUrls(
  rows: Array<{
    id: string;
    jobId: string;
    spreadsheetRow: number;
    packageUrl: string;
    normalizedUrl: string;
    isDuplicate: boolean;
    duplicateOfRow: number | null;
    status: PackageStatus;
  }>
): void {
  const now = nowIso();
  const stmt = db.prepare(`
    INSERT INTO package_urls (
      id, job_id, spreadsheet_row, package_url, normalized_url,
      is_duplicate_url, duplicate_of_row, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.id,
        r.jobId,
        r.spreadsheetRow,
        r.packageUrl,
        r.normalizedUrl,
        r.isDuplicate ? 1 : 0,
        r.duplicateOfRow,
        r.status,
        now
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listJobs(): JobRecord[] {
  return db
    .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50')
    .all() as unknown as JobRecord[];
}

export function getJob(jobId: string): JobRecord | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  return (row as unknown as JobRecord) || null;
}

export function updateJobStatus(jobId: string, status: JobStatus, currentUrl: string | null = null): void {
  db.prepare('UPDATE jobs SET status = ?, current_url = ?, updated_at = ? WHERE id = ?').run(
    status,
    currentUrl,
    nowIso(),
    jobId
  );
}

export function setJobCurrentUrl(jobId: string, currentUrl: string | null): void {
  db.prepare('UPDATE jobs SET current_url = ?, updated_at = ? WHERE id = ?').run(
    currentUrl,
    nowIso(),
    jobId
  );
}

export function setJobConcurrency(jobId: string, concurrency: number): void {
  db.prepare('UPDATE jobs SET concurrency = ?, updated_at = ? WHERE id = ?').run(
    Math.max(1, Math.min(8, concurrency)),
    nowIso(),
    jobId
  );
}

export function addJobTokenUsage(
  jobId: string,
  promptTokens: number,
  outputTokens: number,
  estimatedCostUsd: number
): void {
  db.prepare(`
    UPDATE jobs
    SET prompt_tokens = prompt_tokens + ?,
        output_tokens = output_tokens + ?,
        estimated_cost_usd = estimated_cost_usd + ?,
        updated_at = ?
    WHERE id = ?
  `).run(promptTokens, outputTokens, estimatedCostUsd, nowIso(), jobId);
}

export function recomputeJobStats(jobId: string): JobRecord | null {
  const pkgStats = db
    .prepare(`
      SELECT
        SUM(CASE WHEN status IN ('completed', 'error') AND is_duplicate_url = 0 THEN 1 ELSE 0 END) AS processed_pages,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
      FROM package_urls
      WHERE job_id = ?
    `)
    .get(jobId) as { processed_pages: number | null; error_count: number | null };

  const imgStats = db
    .prepare(`
      SELECT
        COUNT(*) AS images_discovered,
        SUM(CASE WHEN decision IS NOT NULL THEN 1 ELSE 0 END) AS images_classified,
        SUM(CASE WHEN COALESCE(manual_decision, decision) = 'KEEP' THEN 1 ELSE 0 END) AS images_kept
      FROM images
      WHERE job_id = ?
    `)
    .get(jobId) as {
    images_discovered: number | null;
    images_classified: number | null;
    images_kept: number | null;
  };

  const supStats = db
    .prepare(`
      SELECT
        SUM(CASE WHEN verification_status IN ('VERIFIED', 'PROPOSED', 'APPROVED') THEN 1 ELSE 0 END) AS suppliers_discovered,
        SUM(CASE WHEN verification_status IN ('UNRESOLVED', 'REJECTED') THEN 1 ELSE 0 END) AS unresolved_count,
        COUNT(DISTINCT CASE
          WHEN verification_status IN ('VERIFIED', 'APPROVED')
          THEN COALESCE(NULLIF(LOWER(TRIM(direct_supplier_url)), ''), LOWER(TRIM(accommodation_name)))
          ELSE NULL
        END) AS unique_verified_count
      FROM suppliers
      WHERE job_id = ?
    `)
    .get(jobId) as {
    suppliers_discovered: number | null;
    unresolved_count: number | null;
    unique_verified_count: number | null;
  };

  db.prepare(`
    UPDATE jobs SET
      processed_pages = ?,
      error_count = ?,
      images_discovered = ?,
      images_classified = ?,
      images_kept = ?,
      suppliers_discovered = ?,
      unresolved_count = ?,
      unique_verified_count = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    pkgStats?.processed_pages ?? 0,
    pkgStats?.error_count ?? 0,
    imgStats?.images_discovered ?? 0,
    imgStats?.images_classified ?? 0,
    imgStats?.images_kept ?? 0,
    supStats?.suppliers_discovered ?? 0,
    supStats?.unresolved_count ?? 0,
    supStats?.unique_verified_count ?? 0,
    nowIso(),
    jobId
  );

  return getJob(jobId);
}

export function getPackageUrlsForJob(jobId: string): PackageUrlRecord[] {
  return db
    .prepare('SELECT * FROM package_urls WHERE job_id = ? ORDER BY spreadsheet_row ASC')
    .all(jobId) as unknown as PackageUrlRecord[];
}

export function getPendingPackageUrls(jobId: string): PackageUrlRecord[] {
  return db
    .prepare(`
      SELECT * FROM package_urls
      WHERE job_id = ? AND is_duplicate_url = 0 AND status IN ('pending', 'extracting', 'classifying', 'discovering')
      ORDER BY spreadsheet_row ASC
    `)
    .all(jobId) as unknown as PackageUrlRecord[];
}

export function getPackageUrlById(packageId: string): PackageUrlRecord | null {
  const row = db.prepare('SELECT * FROM package_urls WHERE id = ?').get(packageId);
  return (row as unknown as PackageUrlRecord) || null;
}

export function updatePackageStatus(
  packageId: string,
  status: PackageStatus,
  fields?: {
    pageTitle?: string | null;
    packageDescription?: string | null;
    errorMessage?: string | null;
    incrementAttempts?: boolean;
  }
): void {
  const current = getPackageUrlById(packageId);
  if (!current) return;
  const attempts = fields?.incrementAttempts ? current.attempts + 1 : current.attempts;
  db.prepare(`
    UPDATE package_urls
    SET status = ?,
        page_title = COALESCE(?, page_title),
        package_description = COALESCE(?, package_description),
        error_message = ?,
        attempts = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    status,
    fields?.pageTitle ?? null,
    fields?.packageDescription ?? null,
    fields?.errorMessage !== undefined ? fields.errorMessage : current.error_message,
    attempts,
    nowIso(),
    packageId
  );
}

export function resetErroredPackages(jobId: string): number {
  const res = db
    .prepare(`
      UPDATE package_urls
      SET status = 'pending', error_message = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'error'
    `)
    .run(nowIso(), jobId);
  return Number(res.changes ?? 0);
}

export function insertImageRecord(img: {
  id: string;
  jobId: string;
  packageId: string;
  spreadsheetRow: number;
  packageUrl: string;
  imageUrl: string;
  localPath: string | null;
  mimeType: string | null;
  fileSize: number;
  width: number | null;
  height: number | null;
  sha256: string | null;
  decision: ImageDecision;
  reason: string;
  duplicateOf: string | null;
  visualSummary: string | null;
}): void {
  db.prepare(`
    INSERT INTO images (
      id, job_id, package_id, spreadsheet_row, package_url, image_url,
      local_path, mime_type, file_size, width, height, sha256,
      decision, reason, duplicate_of, visual_summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    img.id,
    img.jobId,
    img.packageId,
    img.spreadsheetRow,
    img.packageUrl,
    img.imageUrl,
    img.localPath,
    img.mimeType,
    img.fileSize,
    img.width,
    img.height,
    img.sha256,
    img.decision,
    img.reason,
    img.duplicateOf,
    img.visualSummary,
    nowIso()
  );
}

function hydrateImageRow(raw: Record<string, unknown>): ImageRecord {
  const decision = raw.decision as ImageDecision;
  const manualDecision = (raw.manual_decision as ImageDecision | null) ?? null;
  return {
    id: String(raw.id),
    job_id: String(raw.job_id),
    package_id: String(raw.package_id),
    spreadsheet_row: Number(raw.spreadsheet_row),
    package_url: String(raw.package_url),
    image_url: String(raw.image_url),
    local_path: (raw.local_path as string | null) ?? null,
    mime_type: (raw.mime_type as string | null) ?? null,
    file_size: Number(raw.file_size ?? 0),
    width: raw.width !== null ? Number(raw.width) : null,
    height: raw.height !== null ? Number(raw.height) : null,
    sha256: (raw.sha256 as string | null) ?? null,
    decision,
    manual_decision: manualDecision,
    effective_decision: manualDecision ?? decision,
    reason: String(raw.reason),
    duplicate_of: (raw.duplicate_of as string | null) ?? null,
    visual_summary: (raw.visual_summary as string | null) ?? null,
    created_at: String(raw.created_at),
  };
}

export function getImagesForJob(jobId: string, filterDecision?: string): ImageRecord[] {
  let rows: Record<string, unknown>[];
  if (filterDecision && filterDecision !== 'ALL') {
    rows = db
      .prepare(`
        SELECT * FROM images
        WHERE job_id = ? AND COALESCE(manual_decision, decision) = ?
        ORDER BY spreadsheet_row ASC, created_at ASC
      `)
      .all(jobId, filterDecision) as Record<string, unknown>[];
  } else {
    rows = db
      .prepare('SELECT * FROM images WHERE job_id = ? ORDER BY spreadsheet_row ASC, created_at ASC')
      .all(jobId) as Record<string, unknown>[];
  }
  return rows.map(hydrateImageRow);
}

export function getImagesForPackage(packageId: string): ImageRecord[] {
  const rows = db
    .prepare('SELECT * FROM images WHERE package_id = ? ORDER BY created_at ASC')
    .all(packageId) as Record<string, unknown>[];
  return rows.map(hydrateImageRow);
}

export function getImageById(imageId: string): ImageRecord | null {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(imageId) as
    | Record<string, unknown>
    | undefined;
  return row ? hydrateImageRow(row) : null;
}

export function updateImageManualDecision(
  imageId: string,
  manualDecision: ImageDecision | null,
  reason?: string
): ImageRecord | null {
  if (reason !== undefined) {
    db.prepare('UPDATE images SET manual_decision = ?, reason = ? WHERE id = ?').run(
      manualDecision,
      reason,
      imageId
    );
  } else {
    db.prepare('UPDATE images SET manual_decision = ? WHERE id = ?').run(manualDecision, imageId);
  }
  const img = getImageById(imageId);
  if (img) {
    recomputeJobStats(img.job_id);
  }
  return img;
}

export function deleteImagesForPackage(packageId: string): void {
  db.prepare('DELETE FROM images WHERE package_id = ?').run(packageId);
}

export function upsertSupplierRecord(sup: {
  id: string;
  jobId: string;
  packageId: string;
  spreadsheetRow: number;
  packageUrl: string;
  packageTitle: string | null;
  accommodationName: string | null;
  propertyType: string | null;
  city: string | null;
  country: string | null;
  directSupplierUrl: string | null;
  confidence: ConfidenceLevel;
  verificationStatus: VerificationStatus;
  evidenceUrls: string[];
  imageUrls: string[];
  unresolvedReason: string | null;
  notes: string | null;
  reverseImageMatches: ReverseImageMatch[];
}): SupplierRecord {
  const now = nowIso();
  db.prepare(`
    INSERT INTO suppliers (
      id, job_id, package_id, spreadsheet_row, package_url, package_title,
      accommodation_name, property_type, city, country, direct_supplier_url,
      confidence, verification_status, evidence_urls, image_urls,
      unresolved_reason, notes, reverse_image_matches, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_id) DO UPDATE SET
      package_title = excluded.package_title,
      accommodation_name = excluded.accommodation_name,
      property_type = excluded.property_type,
      city = excluded.city,
      country = excluded.country,
      direct_supplier_url = excluded.direct_supplier_url,
      confidence = excluded.confidence,
      verification_status = excluded.verification_status,
      evidence_urls = excluded.evidence_urls,
      image_urls = excluded.image_urls,
      unresolved_reason = excluded.unresolved_reason,
      notes = excluded.notes,
      reverse_image_matches = excluded.reverse_image_matches,
      updated_at = excluded.updated_at
  `).run(
    sup.id,
    sup.jobId,
    sup.packageId,
    sup.spreadsheetRow,
    sup.packageUrl,
    sup.packageTitle,
    sup.accommodationName,
    sup.propertyType,
    sup.city,
    sup.country,
    sup.directSupplierUrl,
    sup.confidence,
    sup.verificationStatus,
    JSON.stringify(sup.evidenceUrls),
    JSON.stringify(sup.imageUrls),
    sup.unresolvedReason,
    sup.notes,
    JSON.stringify(sup.reverseImageMatches),
    now
  );
  return getSupplierByPackageId(sup.packageId)!;
}

function hydrateSupplierRow(raw: Record<string, unknown>): SupplierRecord {
  const parseJsonArray = <T>(val: unknown): T[] => {
    if (typeof val !== 'string') return [];
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  };
  return {
    id: String(raw.id),
    job_id: String(raw.job_id),
    package_id: String(raw.package_id),
    spreadsheet_row: Number(raw.spreadsheet_row),
    package_url: String(raw.package_url),
    package_title: (raw.package_title as string | null) ?? null,
    accommodation_name: (raw.accommodation_name as string | null) ?? null,
    property_type: (raw.property_type as string | null) ?? null,
    city: (raw.city as string | null) ?? null,
    country: (raw.country as string | null) ?? null,
    direct_supplier_url: (raw.direct_supplier_url as string | null) ?? null,
    confidence: (raw.confidence as ConfidenceLevel) ?? 'NONE',
    verification_status: (raw.verification_status as VerificationStatus) ?? 'UNRESOLVED',
    evidence_urls: parseJsonArray<string>(raw.evidence_urls),
    image_urls: parseJsonArray<string>(raw.image_urls),
    unresolved_reason: (raw.unresolved_reason as string | null) ?? null,
    notes: (raw.notes as string | null) ?? null,
    reverse_image_matches: parseJsonArray<ReverseImageMatch>(raw.reverse_image_matches),
    updated_at: String(raw.updated_at),
  };
}

export function getSuppliersForJob(jobId: string): SupplierRecord[] {
  const rows = db
    .prepare('SELECT * FROM suppliers WHERE job_id = ? ORDER BY spreadsheet_row ASC')
    .all(jobId) as Record<string, unknown>[];
  return rows.map(hydrateSupplierRow);
}

export function getSupplierById(supplierId: string): SupplierRecord | null {
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId) as
    | Record<string, unknown>
    | undefined;
  return row ? hydrateSupplierRow(row) : null;
}

export function getSupplierByPackageId(packageId: string): SupplierRecord | null {
  const row = db.prepare('SELECT * FROM suppliers WHERE package_id = ?').get(packageId) as
    | Record<string, unknown>
    | undefined;
  return row ? hydrateSupplierRow(row) : null;
}

export function updateSupplierReview(
  supplierId: string,
  updates: {
    accommodation_name?: string | null;
    property_type?: string | null;
    city?: string | null;
    country?: string | null;
    direct_supplier_url?: string | null;
    verification_status?: VerificationStatus;
    notes?: string | null;
    unresolved_reason?: string | null;
  }
): SupplierRecord | null {
  const existing = getSupplierById(supplierId);
  if (!existing) return null;

  db.prepare(`
    UPDATE suppliers SET
      accommodation_name = ?,
      property_type = ?,
      city = ?,
      country = ?,
      direct_supplier_url = ?,
      verification_status = ?,
      notes = ?,
      unresolved_reason = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    updates.accommodation_name !== undefined
      ? updates.accommodation_name
      : existing.accommodation_name,
    updates.property_type !== undefined ? updates.property_type : existing.property_type,
    updates.city !== undefined ? updates.city : existing.city,
    updates.country !== undefined ? updates.country : existing.country,
    updates.direct_supplier_url !== undefined
      ? updates.direct_supplier_url
      : existing.direct_supplier_url,
    updates.verification_status !== undefined
      ? updates.verification_status
      : existing.verification_status,
    updates.notes !== undefined ? updates.notes : existing.notes,
    updates.unresolved_reason !== undefined
      ? updates.unresolved_reason
      : existing.unresolved_reason,
    nowIso(),
    supplierId
  );

  recomputeJobStats(existing.job_id);
  return getSupplierById(supplierId);
}

export function addJobLog(
  jobId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  packageUrl: string | null = null
): void {
  db.prepare(
    'INSERT INTO job_logs (job_id, level, message, package_url, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(jobId, level, message, packageUrl, nowIso());
}

export function getJobLogs(jobId: string, limit = 80): JobLogRecord[] {
  return db
    .prepare('SELECT * FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?')
    .all(jobId, limit) as unknown as JobLogRecord[];
}

export function deleteJob(jobId: string): void {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  const dir = path.join(IMAGES_DIR, jobId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function recoverInterruptedJobsOnBoot(): void {
  // Any job left in 'running' state after a server restart is transitioned cleanly to 'paused'
  // and any in-flight package_urls are reset to 'pending' so the user can resume cleanly without losing completed checkpoints.
  const interrupted = db
    .prepare("SELECT id FROM jobs WHERE status = 'running'")
    .all() as Array<{ id: string }>;

  for (const job of interrupted) {
    db.prepare(`
      UPDATE package_urls
      SET status = 'pending', updated_at = ?
      WHERE job_id = ? AND status IN ('extracting', 'classifying', 'discovering')
    `).run(nowIso(), job.id);
    db.prepare("UPDATE jobs SET status = 'paused', current_url = NULL, updated_at = ? WHERE id = ?").run(
      nowIso(),
      job.id
    );
    addJobLog(
      job.id,
      'warn',
      'Server restarted while job was running. Progress saved; ready to resume from checkpoint.'
    );
    recomputeJobStats(job.id);
  }
}

export function getSerpApiCache(cacheKey: string): {
  matches: ReverseImageMatch[];
  discoveredUrls: string[];
} | null {
  const row = db
    .prepare('SELECT response_json, discovered_urls FROM serpapi_cache WHERE cache_key = ?')
    .get(cacheKey) as { response_json: string; discovered_urls: string } | undefined;
  if (!row) return null;
  try {
    return {
      matches: JSON.parse(row.response_json) as ReverseImageMatch[],
      discoveredUrls: JSON.parse(row.discovered_urls) as string[],
    };
  } catch {
    return null;
  }
}

export function saveSerpApiCache(params: {
  cacheKey: string;
  engine: string;
  queryUrl: string;
  matches: ReverseImageMatch[];
  discoveredUrls: string[];
  httpStatus: number;
}): void {
  db.prepare(`
    INSERT INTO serpapi_cache (cache_key, engine, query_url, response_json, discovered_urls, http_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      response_json = excluded.response_json,
      discovered_urls = excluded.discovered_urls,
      http_status = excluded.http_status,
      created_at = excluded.created_at
  `).run(
    params.cacheKey,
    params.engine,
    params.queryUrl,
    JSON.stringify(params.matches),
    JSON.stringify(params.discoveredUrls),
    params.httpStatus,
    nowIso()
  );
}

export function incrementJobSerpApiRequests(jobId: string): number {
  db.prepare(`
    UPDATE jobs
    SET serpapi_requests_made = serpapi_requests_made + 1,
        updated_at = ?
    WHERE id = ?
  `).run(nowIso(), jobId);
  const row = db
    .prepare('SELECT serpapi_requests_made FROM jobs WHERE id = ?')
    .get(jobId) as { serpapi_requests_made: number } | undefined;
  return row?.serpapi_requests_made ?? 0;
}

export function incrementJobSerpApiCacheHits(jobId: string): void {
  db.prepare(`
    UPDATE jobs
    SET serpapi_cache_hits = serpapi_cache_hits + 1,
        updated_at = ?
    WHERE id = ?
  `).run(nowIso(), jobId);
}

export function recordSerpApiRequestLog(
  jobId: string,
  cacheKey: string,
  statusCode: number
): void {
  db.prepare(
    'INSERT INTO serpapi_request_log (job_id, cache_key, status_code, created_at_ms) VALUES (?, ?, ?, ?)'
  ).run(jobId, cacheKey, statusCode, Date.now());
}

export function getRecentSerpApiTimestamps(windowMs = 60_000): number[] {
  const cutoff = Date.now() - windowMs;
  const rows = db
    .prepare(
      'SELECT created_at_ms FROM serpapi_request_log WHERE created_at_ms > ? ORDER BY created_at_ms ASC'
    )
    .all(cutoff) as Array<{ created_at_ms: number }>;
  return rows.map((r) => r.created_at_ms);
}

