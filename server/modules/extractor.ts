import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { getImagesDirForJob } from '../db/database.ts';

export interface DownloadedImageAsset {
  id: string;
  imageUrl: string;
  localPath: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  sha256: string;
}

export interface ExtractedWebpage {
  finalUrl: string;
  pageTitle: string;
  packageDescription: string;
  candidateImageUrls: string[];
  downloadedImages: DownloadedImageAsset[];
}

const EXCLUDED_URL_PATTERNS = [
  /favicon/i,
  /\.svg(\?|$)/i,
  /\.ico(\?|$)/i,
  /doubleclick/i,
  /google-analytics/i,
  /googletagmanager/i,
  /facebook\.com\/tr/i,
  /pixel/i,
  /1x1/i,
  /spacer/i,
  /blank\.(gif|png|jpg)/i,
  /spinner/i,
  /loader/i,
  /gravatar/i,
  /emoji/i,
  /twemoji/i,
  /\/icons?\//i,
  /\/sprites?\//i,
  /badge[-_]?/i,
  /trustpilot/i,
  /powered[-_]?by/i,
  /social[-_]?icon/i,
  /(facebook|twitter|instagram|linkedin|youtube|pinterest|tiktok)[-_]?(icon|logo)/i,
  /logo[-_.]?(white|dark|black|header|footer|small)?\.(png|jpg|jpeg|webp)/i,
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchWithRetry(
  url: string,
  options: { timeoutMs: number; maxAttempts: number; accept: string }
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: options.accept,
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });
      clearTimeout(timer);

      if (res.status === 429 || res.status === 503 || res.status === 502) {
        if (attempt === options.maxAttempts) {
          throw new Error(`HTTP ${res.status} (${res.statusText}) after ${attempt} attempts`);
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const delayMs =
          !Number.isNaN(retryAfter) && retryAfter > 0
            ? Math.min(15000, retryAfter * 1000)
            : Math.min(12000, 1200 * Math.pow(2, attempt - 1));
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt === options.maxAttempts) break;
      const delayMs = Math.min(8000, 900 * Math.pow(2, attempt - 1));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  const cause =
    lastError && typeof lastError === 'object' && 'cause' in lastError
      ? (lastError as { cause?: { code?: string; message?: string } }).cause
      : undefined;
  const baseMsg = lastError instanceof Error ? lastError.message : String(lastError);
  const detail = cause?.code || cause?.message ? ` (${cause.code || cause.message})` : '';
  throw new Error(`${baseMsg}${detail}`);
}

function resolveAbsoluteUrl(raw: string | undefined, baseUrl: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('javascript:')) {
    return null;
  }
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function pickBestSrcFromSrcset(srcset: string | undefined, baseUrl: string): string | null {
  if (!srcset) return null;
  const candidates = srcset
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+/);
      const url = parts[0];
      const descriptor = parts[1] ?? '';
      let score = 1;
      if (descriptor.endsWith('w')) {
        score = parseInt(descriptor.slice(0, -1), 10) || 1;
      } else if (descriptor.endsWith('x')) {
        score = Math.round((parseFloat(descriptor.slice(0, -1)) || 1) * 1000);
      }
      return { url, score };
    })
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;
  return resolveAbsoluteUrl(candidates[0].url, baseUrl);
}

function isExcludedImageCandidate(url: string, altText = '', className = ''): boolean {
  if (EXCLUDED_URL_PATTERNS.some((re) => re.test(url))) return true;
  const combinedMeta = `${altText} ${className}`.toLowerCase();
  if (/\b(icon|logo|favicon|avatar|badge|spinner|pixel)\b/.test(combinedMeta)) {
    return true;
  }
  return false;
}

function detectImageMetadata(buffer: Buffer): {
  mimeType: string | null;
  ext: string;
  width: number | null;
  height: number | null;
} {
  if (buffer.length < 16) {
    return { mimeType: null, ext: 'bin', width: null, height: null };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    const width = buffer.length >= 24 ? buffer.readUInt32BE(16) : null;
    const height = buffer.length >= 24 ? buffer.readUInt32BE(20) : null;
    return { mimeType: 'image/png', ext: 'png', width, height };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let width: number | null = null;
    let height: number | null = null;
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        height = buffer.readUInt16BE(offset + 5);
        width = buffer.readUInt16BE(offset + 7);
        break;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const segLen = buffer.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
    return { mimeType: 'image/jpeg', ext: 'jpg', width, height };
  }

  // GIF: GIF87a / GIF89a
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return { mimeType: 'image/gif', ext: 'gif', width, height };
  }

  // WebP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    let width: number | null = null;
    let height: number | null = null;
    const chunkType = buffer.subarray(12, 16).toString('ascii');
    if (chunkType === 'VP8X' && buffer.length >= 30) {
      width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    } else if (chunkType === 'VP8 ' && buffer.length >= 30) {
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    } else if (chunkType === 'VP8L' && buffer.length >= 25) {
      const b0 = buffer[21];
      const b1 = buffer[22];
      const b2 = buffer[23];
      const b3 = buffer[24];
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    }
    return { mimeType: 'image/webp', ext: 'webp', width, height };
  }

  // AVIF / HEIC ftyp
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') {
      return { mimeType: 'image/avif', ext: 'avif', width: null, height: null };
    }
  }

  return { mimeType: null, ext: 'bin', width: null, height: null };
}

function collectJsonLdImages(obj: unknown, baseUrl: string, out: Set<string>, textHints: string[]): void {
  if (!obj) return;
  if (typeof obj === 'string') {
    if (/\.(jpe?g|png|webp)(\?|$)/i.test(obj) || obj.startsWith('http')) {
      const abs = resolveAbsoluteUrl(obj, baseUrl);
      if (abs && !isExcludedImageCandidate(abs)) out.add(abs);
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectJsonLdImages(item, baseUrl, out, textHints);
    return;
  }
  if (typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.name === 'string' && rec.name.length < 200) {
      textHints.push(rec.name);
    }
    if (typeof rec.description === 'string' && rec.description.length < 1200) {
      textHints.push(rec.description);
    }
    if (rec.image) collectJsonLdImages(rec.image, baseUrl, out, textHints);
    if (rec.photo) collectJsonLdImages(rec.photo, baseUrl, out, textHints);
    if (rec.url && typeof rec.url === 'string' && /\.(jpe?g|png|webp)(\?|$)/i.test(rec.url)) {
      const abs = resolveAbsoluteUrl(rec.url, baseUrl);
      if (abs && !isExcludedImageCandidate(abs)) out.add(abs);
    }
    for (const val of Object.values(rec)) {
      if (typeof val === 'object' && val !== null) {
        collectJsonLdImages(val, baseUrl, out, textHints);
      }
    }
  }
}

export async function extractWebpageAndImages(
  packageUrl: string,
  jobId: string
): Promise<ExtractedWebpage> {
  const res = await fetchWithRetry(packageUrl, {
    timeoutMs: 18000,
    maxAttempts: 3,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });

  const finalUrl = res.url || packageUrl;
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    throw new Error(`Unsupported content type "${contentType || 'unknown'}" at ${finalUrl}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Extract page title
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
  const h1Title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const docTitle = $('title').first().text().replace(/\s+/g, ' ').trim();
  const pageTitle = ogTitle || docTitle || h1Title || finalUrl;

  // Extract package description & JSON-LD context
  const metaDesc = $('meta[name="description"]').attr('content')?.trim() || '';
  const ogDesc = $('meta[property="og:description"]').attr('content')?.trim() || '';

  const candidateSet = new Set<string>();
  const jsonLdHints: string[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      collectJsonLdImages(parsed, finalUrl, candidateSet, jsonLdHints);
    } catch {
      // Ignore malformed JSON-LD
    }
  });

  // Collect OG / Twitter images
  $('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]').each(
    (_, el) => {
      const abs = resolveAbsoluteUrl($(el).attr('content'), finalUrl);
      if (abs && !isExcludedImageCandidate(abs)) candidateSet.add(abs);
    }
  );

  // Collect <img> tags including lazy-loaded attributes and srcset
  $('img').each((_, el) => {
    const $img = $(el);
    const widthAttr = parseInt($img.attr('width') || '', 10);
    const heightAttr = parseInt($img.attr('height') || '', 10);
    if ((!Number.isNaN(widthAttr) && widthAttr < 80) || (!Number.isNaN(heightAttr) && heightAttr < 80)) {
      return;
    }

    const alt = $img.attr('alt') || '';
    const cls = $img.attr('class') || '';

    const bestSrcset =
      pickBestSrcFromSrcset($img.attr('data-srcset'), finalUrl) ||
      pickBestSrcFromSrcset($img.attr('srcset'), finalUrl);

    const directCandidates = [
      bestSrcset,
      resolveAbsoluteUrl($img.attr('data-large_image'), finalUrl),
      resolveAbsoluteUrl($img.attr('data-full-src'), finalUrl),
      resolveAbsoluteUrl($img.attr('data-original'), finalUrl),
      resolveAbsoluteUrl($img.attr('data-lazy-src'), finalUrl),
      resolveAbsoluteUrl($img.attr('data-src'), finalUrl),
      resolveAbsoluteUrl($img.attr('data-url'), finalUrl),
      resolveAbsoluteUrl($img.attr('src'), finalUrl),
    ];

    for (const c of directCandidates) {
      if (c && !isExcludedImageCandidate(c, alt, cls)) {
        candidateSet.add(c);
        break; // Keep the highest-priority source for this <img> element
      }
    }
  });

  // Collect <picture> sources
  $('picture source').each((_, el) => {
    const best =
      pickBestSrcFromSrcset($(el).attr('data-srcset'), finalUrl) ||
      pickBestSrcFromSrcset($(el).attr('srcset'), finalUrl);
    if (best && !isExcludedImageCandidate(best)) {
      candidateSet.add(best);
    }
  });

  // Collect gallery anchor links pointing directly to photos
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && /\.(jpe?g|png|webp)(\?.*)?$/i.test(href)) {
      const abs = resolveAbsoluteUrl(href, finalUrl);
      if (abs && !isExcludedImageCandidate(abs)) {
        candidateSet.add(abs);
      }
    }
  });

  // Collect CSS inline background images
  $('[style*="background-image"]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const match = style.match(/background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i);
    if (match?.[1]) {
      const abs = resolveAbsoluteUrl(match[1], finalUrl);
      if (abs && !isExcludedImageCandidate(abs)) {
        candidateSet.add(abs);
      }
    }
  });

  // Clean body text excerpt for accommodation context
  $('script, style, noscript, nav, footer, header').remove();
  const bodySnippet = $('main, article, .package-description, .description, body')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2200);

  const packageDescription = [ogDesc || metaDesc, ...jsonLdHints, bodySnippet]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 3000);

  // Download up to 24 candidate images concurrently (batches of 4)
  const candidateImageUrls = Array.from(candidateSet).slice(0, 24);
  const downloadedImages: DownloadedImageAsset[] = [];
  const imagesDir = getImagesDirForJob(jobId);

  const batchSize = 4;
  for (let i = 0; i < candidateImageUrls.length; i += batchSize) {
    const slice = candidateImageUrls.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      slice.map(async (imageUrl): Promise<DownloadedImageAsset | null> => {
        const imgRes = await fetchWithRetry(imageUrl, {
          timeoutMs: 12000,
          maxAttempts: 2,
          accept: 'image/avif,image/webp,image/apng,image/jpeg,image/png,image/*,*/*;q=0.8',
        });

        const arrayBuf = await imgRes.arrayBuffer();
        const buf = Buffer.from(arrayBuf);

        // Skip tiny images (< 12 KB) which are almost always icons, spacers, or thumbnails
        if (buf.length < 12 * 1024) {
          return null;
        }
        // Skip absurdly huge files (> 15 MB)
        if (buf.length > 15 * 1024 * 1024) {
          return null;
        }

        const meta = detectImageMetadata(buf);
        const headerMime = imgRes.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        const mimeType = meta.mimeType || (headerMime?.startsWith('image/') ? headerMime : null);

        if (!mimeType || mimeType === 'image/svg+xml' || mimeType === 'image/x-icon') {
          return null;
        }

        // Skip small dimensions if known (< 180px on either side)
        if (
          (meta.width !== null && meta.width < 180) ||
          (meta.height !== null && meta.height < 180)
        ) {
          return null;
        }

        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        const id = crypto.randomUUID();
        const localPath = path.join(imagesDir, `${id}.${meta.ext}`);
        fs.writeFileSync(localPath, buf);

        return {
          id,
          imageUrl,
          localPath,
          mimeType,
          fileSize: buf.length,
          width: meta.width,
          height: meta.height,
          sha256,
        };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        downloadedImages.push(r.value);
      }
    }
  }

  return {
    finalUrl,
    pageTitle,
    packageDescription,
    candidateImageUrls,
    downloadedImages,
  };
}
