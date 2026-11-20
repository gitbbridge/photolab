import { ZipArchive } from 'archiver';
import type { Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  getImagesForJob,
  getPackageUrlsForJob,
  getSuppliersForJob,
} from '../db/database.ts';

function csvEscape(val: unknown): string {
  const str = val === null || val === undefined ? '' : String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

export function buildSupplierResultsXlsx(jobId: string): Buffer {
  const suppliers = getSuppliersForJob(jobId);
  const packages = getPackageUrlsForJob(jobId);
  const pkgMap = new Map(packages.map((p) => [p.id, p]));

  const headers = [
    'spreadsheet_row',
    'package_url',
    'package_title',
    'accommodation_name',
    'property_type',
    'city',
    'country',
    'direct_supplier_url',
    'confidence',
    'verification_status',
    'evidence_urls',
    'image_urls',
  ];

  const rows = suppliers.map((s) => {
    const pkg = pkgMap.get(s.package_id);
    return {
      spreadsheet_row: s.spreadsheet_row,
      package_url: s.package_url,
      package_title: s.package_title || pkg?.page_title || '',
      accommodation_name: s.accommodation_name || '',
      property_type: s.property_type || '',
      city: s.city || '',
      country: s.country || '',
      direct_supplier_url: s.direct_supplier_url || '',
      confidence: s.confidence,
      verification_status: s.verification_status,
      evidence_urls: s.evidence_urls.join(' | '),
      image_urls: s.image_urls.join(' | '),
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  worksheet['!cols'] = [
    { wch: 15 },
    { wch: 45 },
    { wch: 36 },
    { wch: 30 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 42 },
    { wch: 12 },
    { wch: 18 },
    { wch: 55 },
    { wch: 55 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Supplier_Results');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function buildImageClassificationCsv(jobId: string): string {
  const images = getImagesForJob(jobId);
  const headers = [
    'spreadsheet_row',
    'package_url',
    'image_url',
    'decision',
    'reason',
    'duplicate_of',
  ];

  const rows = images.map((img) => [
    img.spreadsheet_row,
    img.package_url,
    img.image_url,
    img.effective_decision,
    img.reason,
    img.duplicate_of || '',
  ]);

  return toCsv(headers, rows);
}

export function buildUnresolvedSuppliersCsv(jobId: string): string {
  const suppliers = getSuppliersForJob(jobId);
  const packages = getPackageUrlsForJob(jobId);
  const pkgMap = new Map(packages.map((p) => [p.id, p]));
  const images = getImagesForJob(jobId);

  const keptByPkg = new Map<string, string[]>();
  for (const img of images) {
    if (img.effective_decision === 'KEEP' || img.effective_decision === 'NEEDS_REVIEW') {
      const list = keptByPkg.get(img.package_id) ?? [];
      list.push(img.image_url);
      keptByPkg.set(img.package_id, list);
    }
  }

  const headers = [
    'spreadsheet_row',
    'package_url',
    'package_title',
    'relevant_image_urls',
    'unresolved_reason',
  ];

  const rows: Array<Array<unknown>> = [];

  for (const s of suppliers) {
    if (s.verification_status === 'UNRESOLVED' || s.verification_status === 'REJECTED') {
      const relImages =
        s.image_urls.length > 0 ? s.image_urls : keptByPkg.get(s.package_id) ?? [];
      rows.push([
        s.spreadsheet_row,
        s.package_url,
        s.package_title || pkgMap.get(s.package_id)?.page_title || '',
        relImages.join(' | '),
        s.unresolved_reason ||
          (s.verification_status === 'REJECTED'
            ? 'Supplier match rejected during user review.'
            : 'Supplier could not be verified.'),
      ]);
    }
  }

  // Also include errored packages that never reached supplier creation
  const supplierPkgIds = new Set(suppliers.map((s) => s.package_id));
  for (const pkg of packages) {
    if (pkg.is_duplicate_url === 0 && pkg.status === 'error' && !supplierPkgIds.has(pkg.id)) {
      rows.push([
        pkg.spreadsheet_row,
        pkg.package_url,
        pkg.page_title || '',
        (keptByPkg.get(pkg.id) ?? []).join(' | '),
        pkg.error_message || 'Webpage extraction failed.',
      ]);
    }
  }

  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  return toCsv(headers, rows);
}

function makeSafePackageFolder(spreadsheetRow: number, packageUrl: string): string {
  const paddedRow = String(spreadsheetRow).padStart(4, '0');
  try {
    const u = new URL(packageUrl);
    const slug = `${u.hostname}${u.pathname}`
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    return `row_${paddedRow}_${slug || 'package'}`;
  } catch {
    return `row_${paddedRow}_package`;
  }
}

export async function streamAccommodationImagesZip(jobId: string, res: Response): Promise<void> {
  const images = getImagesForJob(jobId, 'KEEP');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="Accommodation_Images_${jobId.slice(0, 8)}.zip"`
  );

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (err: Error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  });

  archive.pipe(res);

  const counterPerFolder = new Map<string, number>();

  for (const img of images) {
    if (!img.local_path || !fs.existsSync(img.local_path)) continue;
    const folder = makeSafePackageFolder(img.spreadsheet_row, img.package_url);
    const idx = (counterPerFolder.get(folder) ?? 0) + 1;
    counterPerFolder.set(folder, idx);

    const ext = path.extname(img.local_path) || '.jpg';
    const filename = `image_${String(idx).padStart(2, '0')}${ext}`;
    archive.file(img.local_path, { name: `${folder}/${filename}` });
  }

  await archive.finalize();
}
