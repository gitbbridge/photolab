import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import type { SpreadsheetPreviewResult } from '../../src/types.ts';

export interface ParsedSpreadsheetRow {
  spreadsheetRow: number;
  url: string;
  normalizedUrl: string;
  isDuplicate: boolean;
  duplicateOfRow: number | null;
}

export interface ParsedSpreadsheetFull {
  preview: SpreadsheetPreviewResult;
  rows: ParsedSpreadsheetRow[];
}

// Temporary in-memory cache of parsed uploads ready to launch (TTL 60 minutes)
const pendingUploads = new Map<string, { parsed: ParsedSpreadsheetFull; expiresAt: number }>();

const COLUMN_L_INDEX = 11; // 0-based index for Column L

export function normalizeWebsiteUrl(raw: string): string | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;

  // Ignore obvious non-URL strings like "N/A", "none", "-", etc.
  if (/^(n\/a|na|none|null|undefined|-+)$/i.test(trimmed)) {
    return null;
  }

  // If missing scheme but looks like a domain (e.g. www.example.com/pkg)
  if (!/^https?:\/\//i.test(trimmed)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) {
      trimmed = `https://${trimmed}`;
    } else {
      return null;
    }
  }

  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || !u.hostname.includes('.')) return null;

    // Canonical normalization for duplicate detection
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = u.pathname.replace(/\/+$/, '') || '';
    const search = u.search;
    return `${u.protocol.toLowerCase()}//${host}${pathname}${search}`;
  } catch {
    return null;
  }
}

export function parseSpreadsheetBuffer(
  buffer: Buffer,
  filename: string
): ParsedSpreadsheetFull {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('The uploaded spreadsheet contains no worksheets.');
  }

  const sheet = workbook.Sheets[firstSheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: true,
  });

  if (matrix.length < 2) {
    throw new Error(
      'Spreadsheet must contain a header row and at least one package URL row starting at row 2.'
    );
  }

  const headerRow = matrix[0] ?? [];
  const colLHeader = String(headerRow[COLUMN_L_INDEX] ?? '').trim();
  const warnings: string[] = [];

  let targetColumnIndex = COLUMN_L_INDEX;
  let targetColumnLetter = 'L';
  let targetColumnHeader = colLHeader || 'url';

  // Verify column L; if column L is completely absent (fewer than 12 columns), check if a 'url' header exists elsewhere
  const hasColumnLData = matrix
    .slice(1)
    .some((row) => String(row[COLUMN_L_INDEX] ?? '').trim().length > 0);

  if (!hasColumnLData) {
    const fallbackIdx = headerRow.findIndex(
      (cell) => String(cell ?? '').trim().toLowerCase() === 'url'
    );
    if (fallbackIdx !== -1) {
      targetColumnIndex = fallbackIdx;
      targetColumnLetter = XLSX.utils.encode_col(fallbackIdx);
      targetColumnHeader = String(headerRow[fallbackIdx]).trim();
      warnings.push(
        `Column L had no URL values; automatically mapped to "${targetColumnHeader}" in column ${targetColumnLetter}.`
      );
    } else {
      throw new Error(
        'Column L ("url") is empty or missing. Ensure package URLs are placed in column L starting at row 2.'
      );
    }
  } else if (colLHeader && colLHeader.toLowerCase() !== 'url') {
    warnings.push(
      `Column L header is "${colLHeader}" (expected "url"); reading URLs from column L starting at row 2.`
    );
  }

  const seenNormalized = new Map<string, number>(); // normalized -> first spreadsheetRow
  const parsedRows: ParsedSpreadsheetRow[] = [];

  let emptyRowsIgnored = 0;
  let invalidRowsIgnored = 0;
  let duplicateUrlsDetected = 0;
  let uniqueValidUrls = 0;

  for (let i = 1; i < matrix.length; i++) {
    const spreadsheetRow = i + 1; // 1-based row number matching Excel/CSV row
    const row = matrix[i] ?? [];
    const rawCell = String(row[targetColumnIndex] ?? '').trim();

    if (!rawCell) {
      emptyRowsIgnored++;
      continue;
    }

    const normalized = normalizeWebsiteUrl(rawCell);
    if (!normalized) {
      invalidRowsIgnored++;
      continue;
    }

    const exactUrl = /^https?:\/\//i.test(rawCell) ? rawCell : `https://${rawCell}`;
    const existingRow = seenNormalized.get(normalized);
    if (existingRow !== undefined) {
      duplicateUrlsDetected++;
      parsedRows.push({
        spreadsheetRow,
        url: exactUrl,
        normalizedUrl: normalized,
        isDuplicate: true,
        duplicateOfRow: existingRow,
      });
    } else {
      seenNormalized.set(normalized, spreadsheetRow);
      uniqueValidUrls++;
      parsedRows.push({
        spreadsheetRow,
        url: exactUrl,
        normalizedUrl: normalized,
        isDuplicate: false,
        duplicateOfRow: null,
      });
    }
  }

  if (parsedRows.length === 0) {
    throw new Error(
      `No valid http(s) URLs were found in column ${targetColumnLetter} starting at row 2.`
    );
  }

  const uploadToken = crypto.randomUUID();
  const preview: SpreadsheetPreviewResult = {
    uploadToken,
    filename,
    columnHeader: targetColumnHeader,
    columnLetter: targetColumnLetter,
    totalRowsScanned: matrix.length - 1,
    emptyRowsIgnored,
    invalidRowsIgnored,
    duplicateUrlsDetected,
    uniqueValidUrls,
    totalValidEntries: parsedRows.length,
    previewRows: parsedRows.slice(0, 50).map((r) => ({
      spreadsheetRow: r.spreadsheetRow,
      url: r.url,
      isDuplicate: r.isDuplicate,
      duplicateOfRow: r.duplicateOfRow,
    })),
    warnings,
  };

  const full: ParsedSpreadsheetFull = { preview, rows: parsedRows };
  cleanupExpiredUploads();
  pendingUploads.set(uploadToken, {
    parsed: full,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  return full;
}

export function consumePendingUpload(uploadToken: string): ParsedSpreadsheetFull | null {
  cleanupExpiredUploads();
  const entry = pendingUploads.get(uploadToken);
  if (!entry) return null;
  return entry.parsed;
}

function cleanupExpiredUploads(): void {
  const now = Date.now();
  for (const [k, v] of pendingUploads.entries()) {
    if (v.expiresAt < now) {
      pendingUploads.delete(k);
    }
  }
}
