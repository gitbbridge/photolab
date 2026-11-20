import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import type { ImageDecision, JobMode, VerificationStatus } from './src/types.ts';
import {
  addJobLog,
  createJobRecord,
  deleteJob,
  getImageById,
  getImagesForJob,
  getJob,
  getJobLogs,
  getPackageUrlsForJob,
  getSupplierById,
  getSuppliersForJob,
  insertPackageUrls,
  listJobs,
  recoverInterruptedJobsOnBoot,
  setJobConcurrency,
  updateImageManualDecision,
  updateSupplierReview,
} from './server/db/database.ts';
import {
  buildImageClassificationCsv,
  buildSupplierResultsXlsx,
  buildUnresolvedSuppliersCsv,
  streamAccommodationImagesZip,
} from './server/modules/exporter.ts';
import { CLAUDE_MODEL, isClaudeConfigured } from './server/modules/claudeClient.ts';
import {
  jobEvents,
  pauseJob,
  rediscoverSupplierForPackage,
  retryFailedPackagesForJob,
  startOrResumeJob,
} from './server/modules/jobRunner.ts';
import {
  consumePendingUpload,
  normalizeWebsiteUrl,
  parseSpreadsheetBuffer,
} from './server/modules/spreadsheet.ts';
import { getReverseImageProviderStatus } from './server/modules/supplierDiscovery.ts';

const PORT = Number(process.env.PORT || 3000);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Promise Rejection:', reason);
});

async function startServer() {
  recoverInterruptedJobsOnBoot();

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // System capabilities status (never exposes actual key values)
  app.get('/api/system/status', (_req, res) => {
    res.json({
      claudeConfigured: isClaudeConfigured(),
      claudeModel: CLAUDE_MODEL,
      reverseImageProvider: getReverseImageProviderStatus(),
    });
  });

  // Download a blank Column-L CSV template matching gather_giveholidays.csv layout
  app.get('/api/spreadsheet/template', (_req, res) => {
    const header =
      'col_a,col_b,col_c,col_d,col_e,col_f,col_g,col_h,col_i,col_j,col_k,url\r\n';
    const sampleComment =
      ',,,,,,,,,,,\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="gather_giveholidays_template.csv"'
    );
    res.send(header + sampleComment);
  });

  // Parse and preview uploaded .xlsx or .csv file
  app.post('/api/spreadsheet/preview', upload.single('file'), (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No spreadsheet file provided.' });
        return;
      }
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
        res.status(400).json({
          error: 'Unsupported file format. Please upload an .xlsx or .csv file.',
        });
        return;
      }

      const parsed = parseSpreadsheetBuffer(req.file.buffer, req.file.originalname);
      res.json(parsed.preview);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse spreadsheet.';
      res.status(400).json({ error: message });
    }
  });

  // List all jobs
  app.get('/api/jobs', (_req, res) => {
    res.json({ jobs: listJobs() });
  });

  // Create and start a new job (from uploaded spreadsheet token or direct URLs)
  app.post('/api/jobs', (req, res) => {
    try {
      const {
        uploadToken,
        directUrls,
        filename,
        mode = 'test_10',
        customLimit,
        concurrency = 3,
      } = req.body as {
        uploadToken?: string;
        directUrls?: string[];
        filename?: string;
        mode?: JobMode;
        customLimit?: number;
        concurrency?: number;
      };

      const reverseProvider = getReverseImageProviderStatus().name;
      const jobId = crypto.randomUUID();

      let parsedRows: Array<{
        spreadsheetRow: number;
        url: string;
        normalizedUrl: string;
        isDuplicate: boolean;
        duplicateOfRow: number | null;
      }> = [];
      let totalRowsScanned = 0;
      let duplicateUrlsCount = 0;
      let emptyRowsCount = 0;
      let uniqueUrls = 0;
      let sourceName = filename || 'gather_giveholidays.csv';

      if (uploadToken) {
        const pending = consumePendingUpload(uploadToken);
        if (!pending) {
          res.status(400).json({
            error: 'Spreadsheet session expired or not found. Please re-upload the file.',
          });
          return;
        }
        sourceName = pending.preview.filename;
        totalRowsScanned = pending.preview.totalRowsScanned;
        duplicateUrlsCount = pending.preview.duplicateUrlsDetected;
        emptyRowsCount = pending.preview.emptyRowsIgnored;
        uniqueUrls = pending.preview.uniqueValidUrls;
        parsedRows = pending.rows;
      } else if (Array.isArray(directUrls) && directUrls.length > 0) {
        const seen = new Map<string, number>();
        directUrls.forEach((raw, idx) => {
          const rowNum = idx + 2;
          const trimmed = String(raw || '').trim();
          if (!trimmed) {
            emptyRowsCount++;
            return;
          }
          const normalized = normalizeWebsiteUrl(trimmed);
          if (!normalized) return;
          const exactUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
          const prev = seen.get(normalized);
          if (prev !== undefined) {
            duplicateUrlsCount++;
            parsedRows.push({
              spreadsheetRow: rowNum,
              url: exactUrl,
              normalizedUrl: normalized,
              isDuplicate: true,
              duplicateOfRow: prev,
            });
          } else {
            seen.set(normalized, rowNum);
            uniqueUrls++;
            parsedRows.push({
              spreadsheetRow: rowNum,
              url: exactUrl,
              normalizedUrl: normalized,
              isDuplicate: false,
              duplicateOfRow: null,
            });
          }
        });
        totalRowsScanned = directUrls.length;
        sourceName = filename || 'manual_url_batch.csv';
      } else {
        res.status(400).json({ error: 'Provide either a parsed spreadsheet uploadToken or URLs.' });
        return;
      }

      if (parsedRows.length === 0) {
        res.status(400).json({ error: 'No valid package URLs to process.' });
        return;
      }

      // Filter to unique URLs when applying test_10 / custom limit
      let urlLimit: number | null = null;
      if (mode === 'test_10') {
        urlLimit = 10;
      } else if (mode === 'custom' && customLimit && customLimit > 0) {
        urlLimit = Math.floor(customLimit);
      }

      const uniqueQueue = parsedRows.filter((r) => !r.isDuplicate);
      const selectedUnique = urlLimit ? uniqueQueue.slice(0, urlLimit) : uniqueQueue;
      const selectedRowNumbers = new Set(selectedUnique.map((r) => r.spreadsheetRow));

      // Keep duplicates in DB marked as 'skipped' for audit visibility if within range or all
      const rowsToInsert = parsedRows
        .filter((r) => !r.isDuplicate ? selectedRowNumbers.has(r.spreadsheetRow) : !urlLimit)
        .map((r) => ({
          id: crypto.randomUUID(),
          jobId,
          spreadsheetRow: r.spreadsheetRow,
          packageUrl: r.url,
          normalizedUrl: r.normalizedUrl,
          isDuplicate: r.isDuplicate,
          duplicateOfRow: r.duplicateOfRow,
          status: r.isDuplicate ? ('skipped' as const) : ('pending' as const),
        }));

      const job = createJobRecord({
        id: jobId,
        filename: sourceName,
        mode,
        urlLimit,
        concurrency: Math.max(1, Math.min(8, Number(concurrency) || 3)),
        totalRowsScanned,
        totalUrls: selectedUnique.length,
        uniqueUrls: selectedUnique.length,
        duplicateUrlsCount: urlLimit ? 0 : duplicateUrlsCount,
        emptyRowsCount,
        reverseImageProvider: reverseProvider,
      });

      insertPackageUrls(rowsToInsert);
      addJobLog(
        jobId,
        'info',
        `Job created from "${sourceName}" (${mode === 'test_10' ? '10-URL Test Mode' : mode}): ${selectedUnique.length} unique URL(s) queued.`
      );

      // Launch background processor asynchronously
      void startOrResumeJob(jobId);

      res.status(201).json({ job: getJob(jobId) ?? job });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create job.';
      res.status(500).json({ error: message });
    }
  });

  // Get full job details
  app.get('/api/jobs/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    const packages = getPackageUrlsForJob(job.id);
    const images = getImagesForJob(job.id);
    const suppliers = getSuppliersForJob(job.id);
    const logs = getJobLogs(job.id, 100);
    res.json({ job, packages, images, suppliers, logs });
  });

  // SSE stream for live processing updates
  app.get('/api/jobs/:jobId/stream', (req, res) => {
    const jobId = req.params.jobId;
    const job = getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'job', job })}\n\n`);

    const onUpdate = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    jobEvents.on(`job:${jobId}`, onUpdate);

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      jobEvents.off(`job:${jobId}`, onUpdate);
    });
  });

  // Job control endpoints
  app.post('/api/jobs/:jobId/pause', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    pauseJob(job.id);
    res.json({ job: getJob(job.id) });
  });

  app.post('/api/jobs/:jobId/resume', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    void startOrResumeJob(job.id);
    res.json({ job: getJob(job.id) });
  });

  app.post('/api/jobs/:jobId/retry-failed', async (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    const retried = await retryFailedPackagesForJob(job.id);
    res.json({ retried, job: getJob(job.id) });
  });

  app.patch('/api/jobs/:jobId/concurrency', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    const concurrency = Number(req.body?.concurrency);
    if (Number.isNaN(concurrency) || concurrency < 1 || concurrency > 8) {
      res.status(400).json({ error: 'Concurrency must be between 1 and 8.' });
      return;
    }
    setJobConcurrency(job.id, concurrency);
    res.json({ job: getJob(job.id) });
  });

  app.delete('/api/jobs/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    pauseJob(job.id);
    deleteJob(job.id);
    res.json({ ok: true });
  });

  // Serve cached original image files safely for fast gallery rendering
  app.get('/api/images/:imageId/file', (req, res) => {
    const img = getImageById(req.params.imageId);
    if (!img || !img.local_path || !fs.existsSync(img.local_path)) {
      res.status(404).send('Image not found');
      return;
    }
    if (img.mime_type) {
      res.setHeader('Content-Type', img.mime_type);
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.resolve(img.local_path));
  });

  // Manual image classification override
  app.patch('/api/images/:imageId', (req, res) => {
    const { decision, reason } = req.body as {
      decision?: ImageDecision;
      reason?: string;
    };
    const allowed: ImageDecision[] = ['KEEP', 'SET_ASIDE', 'DUPLICATE', 'NEEDS_REVIEW'];
    if (!decision || !allowed.includes(decision)) {
      res.status(400).json({ error: 'Invalid classification decision.' });
      return;
    }
    const updated = updateImageManualDecision(req.params.imageId, decision, reason);
    if (!updated) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }
    res.json({ image: updated, job: getJob(updated.job_id) });
  });

  // User review / edit / approve / reject supplier match
  app.patch('/api/suppliers/:supplierId', (req, res) => {
    const existing = getSupplierById(req.params.supplierId);
    if (!existing) {
      res.status(404).json({ error: 'Supplier record not found.' });
      return;
    }

    const {
      accommodation_name,
      property_type,
      city,
      country,
      direct_supplier_url,
      verification_status,
      notes,
      unresolved_reason,
    } = req.body as {
      accommodation_name?: string | null;
      property_type?: string | null;
      city?: string | null;
      country?: string | null;
      direct_supplier_url?: string | null;
      verification_status?: VerificationStatus;
      notes?: string | null;
      unresolved_reason?: string | null;
    };

    const updated = updateSupplierReview(existing.id, {
      accommodation_name,
      property_type,
      city,
      country,
      direct_supplier_url,
      verification_status,
      notes,
      unresolved_reason,
    });

    res.json({ supplier: updated, job: getJob(existing.job_id) });
  });

  // Re-run supplier discovery for a single package (e.g. after manually updating image selections)
  app.post('/api/suppliers/:supplierId/rediscover', async (req, res) => {
    const existing = getSupplierById(req.params.supplierId);
    if (!existing) {
      res.status(404).json({ error: 'Supplier record not found.' });
      return;
    }
    try {
      const updated = await rediscoverSupplierForPackage(existing.package_id);
      res.json({ supplier: updated, job: getJob(existing.job_id) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Rediscovery failed.';
      res.status(500).json({ error: msg });
    }
  });

  // One-click Exports
  app.get('/api/jobs/:jobId/export/suppliers.xlsx', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    const buf = buildSupplierResultsXlsx(job.id);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="Supplier_Results.xlsx"');
    res.send(buf);
  });

  app.get('/api/jobs/:jobId/export/images.csv', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    const csv = buildImageClassificationCsv(job.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Image_Classification.csv"');
    res.send(csv);
  });

  app.get('/api/jobs/:jobId/export/unresolved.csv', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    const csv = buildUnresolvedSuppliersCsv(job.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Unresolved_Suppliers.csv"');
    res.send(csv);
  });

  app.get('/api/jobs/:jobId/export/images.zip', async (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    await streamAccommodationImagesZip(job.id, res);
  });

  // Clean JSON error handler for Multer / API errors so the browser never receives HTML or dropped sockets
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (!req.path.startsWith('/api/')) {
        next(err);
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal server error.';
      if (!res.headersSent) {
        res.status(400).json({ error: message });
      }
    }
  );

  // Mount Vite middleware in dev, or serve dist/ in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Give Holidays Supplier Discovery listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
