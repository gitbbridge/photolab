import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PackageUrlRecord } from '../../src/types.ts';
import {
  addJobLog,
  addJobTokenUsage,
  deleteImagesForPackage,
  getImagesForPackage,
  getJob,
  getPackageUrlById,
  getPendingPackageUrls,
  insertImageRecord,
  recomputeJobStats,
  resetErroredPackages,
  setJobCurrentUrl,
  updateJobStatus,
  updatePackageStatus,
  upsertSupplierRecord,
} from '../db/database.ts';
import { classifyImageWithClaude } from './classifier.ts';
import { extractWebpageAndImages } from './extractor.ts';
import { isClaudeConfigured } from './claudeClient.ts';
import { discoverAccommodationSupplier } from './supplierDiscovery.ts';

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(50);

const activeJobs = new Map<string, { paused: boolean }>();

export function emitJobUpdate(jobId: string): void {
  const job = getJob(jobId);
  if (job) {
    jobEvents.emit(`job:${jobId}`, { type: 'job', job });
  }
}

export function isJobRunning(jobId: string): boolean {
  return activeJobs.has(jobId);
}

export function pauseJob(jobId: string): void {
  const control = activeJobs.get(jobId);
  if (control) {
    control.paused = true;
  }
  updateJobStatus(jobId, 'paused', null);
  addJobLog(jobId, 'warn', 'Processing paused by user. Checkpoints saved.');
  emitJobUpdate(jobId);
}

async function processSinglePackage(
  jobId: string,
  pkg: PackageUrlRecord,
  control: { paused: boolean }
): Promise<void> {
  if (control.paused) return;

  setJobCurrentUrl(jobId, pkg.package_url);
  emitJobUpdate(jobId);

  try {
    // Stage 1: Webpage & Image Extraction
    updatePackageStatus(pkg.id, 'extracting', { incrementAttempts: true, errorMessage: null });
    addJobLog(jobId, 'info', `Visiting row ${pkg.spreadsheet_row}: ${pkg.package_url}`, pkg.package_url);
    emitJobUpdate(jobId);

    const extracted = await extractWebpageAndImages(pkg.package_url, jobId);

    if (control.paused) {
      updatePackageStatus(pkg.id, 'pending');
      return;
    }

    // Clear any partial images from a prior interrupted attempt on this exact package
    deleteImagesForPackage(pkg.id);

    // Stage 2: Claude Visual Classification
    updatePackageStatus(pkg.id, 'classifying', {
      pageTitle: extracted.pageTitle,
      packageDescription: extracted.packageDescription,
    });
    addJobLog(
      jobId,
      'info',
      `Extracted ${extracted.downloadedImages.length} candidate photos (${extracted.candidateImageUrls.length} found) from "${extracted.pageTitle.slice(0, 60)}"`,
      pkg.package_url
    );
    emitJobUpdate(jobId);

    const seenSha256Map = new Map<string, string>();
    const priorKeptVisuals: Array<{ imageUrl: string; visualSummary: string }> = [];

    for (const asset of extracted.downloadedImages) {
      if (control.paused) {
        updatePackageStatus(pkg.id, 'pending');
        return;
      }

      const result = await classifyImageWithClaude(
        asset,
        extracted.pageTitle,
        priorKeptVisuals,
        seenSha256Map
      );

      if (result.usage.promptTokens > 0 || result.usage.outputTokens > 0) {
        addJobTokenUsage(
          jobId,
          result.usage.promptTokens,
          result.usage.outputTokens,
          result.usage.estimatedCostUsd
        );
      }

      insertImageRecord({
        id: asset.id,
        jobId,
        packageId: pkg.id,
        spreadsheetRow: pkg.spreadsheet_row,
        packageUrl: pkg.package_url,
        imageUrl: asset.imageUrl,
        localPath: asset.localPath,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
        width: asset.width,
        height: asset.height,
        sha256: asset.sha256,
        decision: result.decision,
        reason: result.reason,
        duplicateOf: result.duplicateOf,
        visualSummary: result.visualSummary,
      });

      if (result.decision === 'KEEP') {
        priorKeptVisuals.push({
          imageUrl: asset.imageUrl,
          visualSummary: result.visualSummary,
        });
      }

      recomputeJobStats(jobId);
      emitJobUpdate(jobId);
    }

    if (control.paused) {
      updatePackageStatus(pkg.id, 'pending');
      return;
    }

    // Stage 3: Supplier Discovery
    updatePackageStatus(pkg.id, 'discovering');
    emitJobUpdate(jobId);

    const allPkgImages = getImagesForPackage(pkg.id);
    const keptImages = allPkgImages.filter((i) => i.effective_decision === 'KEEP');

    const supplier = await discoverAccommodationSupplier({
      jobId,
      packageUrl: pkg.package_url,
      pageTitle: extracted.pageTitle,
      packageDescription: extracted.packageDescription,
      keptImages,
    });

    if (supplier.usage.promptTokens > 0 || supplier.usage.outputTokens > 0) {
      addJobTokenUsage(
        jobId,
        supplier.usage.promptTokens,
        supplier.usage.outputTokens,
        supplier.usage.estimatedCostUsd
      );
    }

    upsertSupplierRecord({
      id: crypto.randomUUID(),
      jobId,
      packageId: pkg.id,
      spreadsheetRow: pkg.spreadsheet_row,
      packageUrl: pkg.package_url,
      packageTitle: extracted.pageTitle,
      accommodationName: supplier.accommodationName,
      propertyType: supplier.propertyType,
      city: supplier.city,
      country: supplier.country,
      directSupplierUrl: supplier.directSupplierUrl,
      confidence: supplier.confidence,
      verificationStatus: supplier.verificationStatus,
      evidenceUrls: supplier.evidenceUrls,
      imageUrls: supplier.imageUrls,
      unresolvedReason: supplier.unresolvedReason,
      notes: supplier.notes,
      reverseImageMatches: supplier.reverseImageMatches,
    });

    updatePackageStatus(pkg.id, 'completed', { errorMessage: null });
    recomputeJobStats(jobId);

    addJobLog(
      jobId,
      supplier.verificationStatus === 'UNRESOLVED' ? 'warn' : 'info',
      supplier.accommodationName
        ? `Row ${pkg.spreadsheet_row}: Identified "${supplier.accommodationName}" (${supplier.verificationStatus})${
            supplier.directSupplierUrl ? ` -> ${supplier.directSupplierUrl}` : ''
          }`
        : `Row ${pkg.spreadsheet_row}: Marked UNRESOLVED (${supplier.unresolvedReason || 'No supplier verified'})`,
      pkg.package_url
    );
    emitJobUpdate(jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updatePackageStatus(pkg.id, 'error', { errorMessage: message });
    recomputeJobStats(jobId);
    addJobLog(jobId, 'error', `Row ${pkg.spreadsheet_row} failed: ${message}`, pkg.package_url);
    emitJobUpdate(jobId);
  }
}

export async function startOrResumeJob(jobId: string): Promise<void> {
  if (activeJobs.has(jobId)) return;

  if (!isClaudeConfigured()) {
    updateJobStatus(jobId, 'failed', null);
    addJobLog(
      jobId,
      'error',
      'ANTHROPIC_API_KEY is not configured in the project .env file. Unable to classify images or run supplier discovery.'
    );
    emitJobUpdate(jobId);
    return;
  }

  const job = getJob(jobId);
  if (!job) return;

  const control = { paused: false };
  activeJobs.set(jobId, control);
  updateJobStatus(jobId, 'running', null);
  addJobLog(jobId, 'info', `Starting batch worker (concurrency: ${job.concurrency}).`);
  emitJobUpdate(jobId);

  try {
    const queue = getPendingPackageUrls(jobId);
    let cursor = 0;

    const worker = async () => {
      while (!control.paused) {
        const idx = cursor++;
        if (idx >= queue.length) break;
        const pkg = queue[idx];
        await processSinglePackage(jobId, pkg, control);
      }
    };

    const currentJob = getJob(jobId);
    const workerCount = Math.max(1, Math.min(8, currentJob?.concurrency ?? 3));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const finalStats = recomputeJobStats(jobId);
    if (control.paused) {
      updateJobStatus(jobId, 'paused', null);
    } else {
      updateJobStatus(jobId, 'completed', null);
      const made = finalStats?.serpapi_requests_made ?? 0;
      const limit = finalStats?.serpapi_request_limit ?? 100;
      const remaining = Math.max(0, limit - made);
      const cacheHits = finalStats?.serpapi_cache_hits ?? 0;
      const uniqueVerified = finalStats?.unique_verified_count ?? 0;
      addJobLog(
        jobId,
        'info',
        `Run completed. Bright Data requests made: ${made}/${limit} (${remaining} remaining, ${cacheHits} cache hits) · Unique verified properties discovered: ${uniqueVerified}.`
      );
    }
    emitJobUpdate(jobId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateJobStatus(jobId, 'failed', null);
    addJobLog(jobId, 'error', `Job runner encountered fatal error: ${msg}`);
    emitJobUpdate(jobId);
  } finally {
    activeJobs.delete(jobId);
  }
}

export async function retryFailedPackagesForJob(jobId: string): Promise<number> {
  const count = resetErroredPackages(jobId);
  if (count > 0) {
    recomputeJobStats(jobId);
    addJobLog(jobId, 'info', `Queued ${count} errored package(s) for retry.`);
    emitJobUpdate(jobId);
    void startOrResumeJob(jobId);
  }
  return count;
}

export async function rediscoverSupplierForPackage(packageId: string) {
  const pkg = getPackageUrlById(packageId);
  if (!pkg) throw new Error('Package not found.');

  const allPkgImages = getImagesForPackage(pkg.id);
  const keptImages = allPkgImages.filter((i) => i.effective_decision === 'KEEP');

  const supplier = await discoverAccommodationSupplier({
    jobId: pkg.job_id,
    packageUrl: pkg.package_url,
    pageTitle: pkg.page_title,
    packageDescription: pkg.package_description,
    keptImages,
    manualRetry: true,
  });

  if (supplier.usage.promptTokens > 0 || supplier.usage.outputTokens > 0) {
    addJobTokenUsage(
      pkg.job_id,
      supplier.usage.promptTokens,
      supplier.usage.outputTokens,
      supplier.usage.estimatedCostUsd
    );
  }

  const saved = upsertSupplierRecord({
    id: crypto.randomUUID(),
    jobId: pkg.job_id,
    packageId: pkg.id,
    spreadsheetRow: pkg.spreadsheet_row,
    packageUrl: pkg.package_url,
    packageTitle: pkg.page_title,
    accommodationName: supplier.accommodationName,
    propertyType: supplier.propertyType,
    city: supplier.city,
    country: supplier.country,
    directSupplierUrl: supplier.directSupplierUrl,
    confidence: supplier.confidence,
    verificationStatus: supplier.verificationStatus,
    evidenceUrls: supplier.evidenceUrls,
    imageUrls: supplier.imageUrls,
    unresolvedReason: supplier.unresolvedReason,
    notes: supplier.notes,
    reverseImageMatches: supplier.reverseImageMatches,
  });

  recomputeJobStats(pkg.job_id);
  addJobLog(
    pkg.job_id,
    'info',
    `Re-ran supplier discovery for row ${pkg.spreadsheet_row}: ${
      saved.accommodation_name || 'UNRESOLVED'
    }`,
    pkg.package_url
  );
  emitJobUpdate(pkg.job_id);
  return saved;
}
