import { getSerpApiKey, getBrightDataZone, buildBrightDataLensRequest } from './serpapiConfig.ts';
import { parseGoogleLensMatches, resolveGoogleLensRedirect } from './lensResults.ts';
import type { ReverseImageMatch } from '../../src/types.ts';
import {
  addJobLog,
  getJob,
  getRecentSerpApiTimestamps,
  getSerpApiCache,
  incrementJobSerpApiCacheHits,
  incrementJobSerpApiRequests,
  recordSerpApiRequestLog,
  saveSerpApiCache,
} from '../db/database.ts';

export const SERPAPI_HARD_RUN_LIMIT = 100;
export const SERPAPI_RATE_LIMIT_PER_MIN = 10;

// In-process async mutex to serialize all Bright Data quota & rate-limit checks across concurrent workers
let gateTail: Promise<void> = Promise.resolve();

function withSerpApiGate<T>(fn: () => Promise<T>): Promise<T> {
  const run = gateTail.then(fn, fn);
  gateTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function normalizeSerpApiCacheKey(engine: string, imageUrl: string): string {
  try {
    const u = new URL(imageUrl.trim());
    // Strip common tracking query params while preserving meaningful image dimensions/tokens
    const cleanParams = new URLSearchParams();
    for (const [k, v] of u.searchParams.entries()) {
      if (!/^(utm_|fbclid|gclid|_ga)/i.test(k)) {
        cleanParams.set(k, v);
      }
    }
    const qs = cleanParams.toString();
    return `${engine}:${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${u.pathname}${qs ? `?${qs}` : ''}`;
  } catch {
    return `${engine}:${imageUrl.trim()}`;
  }
}

export interface SerpApiSearchResult {
  matches: ReverseImageMatch[];
  discoveredUrls: string[];
  fromCache: boolean;
  blockedByLimit: boolean;
  error?: string;
}

export async function safeSerpApiGoogleLensSearch(
  jobId: string,
  imageUrl: string,
  options: { allowPaused?: boolean } = {}
): Promise<SerpApiSearchResult> {
  const apiKey = getSerpApiKey();
  const zone = getBrightDataZone();
  if (!apiKey || !zone) {
    return {
      matches: [],
      discoveredUrls: [],
      fromCache: false,
      blockedByLimit: false,
    };
  }

  const cacheKey = normalizeSerpApiCacheKey(`brightdata_lens_v1:${zone}`, imageUrl);

  return withSerpApiGate(async () => {
    // 1. Check persistent SQLite cache first (eliminates duplicate searches & reuses discovered URLs)
    const cached = getSerpApiCache(cacheKey);
    if (cached) {
      incrementJobSerpApiCacheHits(jobId);
      return {
        matches: cached.matches,
        discoveredUrls: cached.discoveredUrls,
        fromCache: true,
        blockedByLimit: false,
      };
    }

    // 2. Enforce mandatory hard limit of 100 Bright Data requests per research run
    const job = getJob(jobId);
    if (!job) {
      return {
        matches: [],
        discoveredUrls: [],
        fromCache: false,
        blockedByLimit: true,
        error: 'Job not found.',
      };
    }

    const limit = Math.min(SERPAPI_HARD_RUN_LIMIT, job.serpapi_request_limit || SERPAPI_HARD_RUN_LIMIT);
    if (job.serpapi_requests_made >= limit) {
      addJobLog(
        jobId,
        'warn',
        `Bright Data request budget exhausted (${job.serpapi_requests_made}/${limit}). Skipping external reverse-image search.`
      );
      return {
        matches: [],
        discoveredUrls: [],
        fromCache: false,
        blockedByLimit: true,
        error: `Hard limit of ${limit} Bright Data requests reached for this run.`,
      };
    }

    // 3. Enforce 10 requests per minute sliding window rate limit (persisted in SQLite)
    while (true) {
      const currentJob = getJob(jobId);
      if (!currentJob || (currentJob.status === 'paused' && !options.allowPaused)) {
        return {
          matches: [],
          discoveredUrls: [],
          fromCache: false,
          blockedByLimit: true,
          error: 'Job paused before executing Bright Data request.',
        };
      }

      const recentTimestamps = getRecentSerpApiTimestamps(60_000);
      if (recentTimestamps.length < SERPAPI_RATE_LIMIT_PER_MIN) {
        break;
      }

      const oldestMs = recentTimestamps[0];
      const waitMs = Math.max(250, oldestMs + 60_000 - Date.now() + 200);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 10_000)));
    }

    // 4. Atomically count the request BEFORE issuing it (counts failures & retries too!)
    const updatedCount = incrementJobSerpApiRequests(jobId);
    const remaining = Math.max(0, limit - updatedCount);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let httpStatus = 0;

    try {
      const res = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBrightDataLensRequest(imageUrl, zone)),
        signal: controller.signal,
      });
      clearTimeout(timer);
      httpStatus = res.status;

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        recordSerpApiRequestLog(jobId, cacheKey, httpStatus);
        addJobLog(
          jobId,
          'warn',
          `Bright Data request #${updatedCount}/${limit} returned HTTP ${httpStatus} (${remaining} remaining): ${errText.slice(0, 120)}`
        );
        return {
          matches: [],
          discoveredUrls: [],
          fromCache: false,
          blockedByLimit: false,
          error: `Bright Data HTTP ${httpStatus}`,
        };
      }

      const data = (await res.json()) as {
        error?: string;
        images?: unknown[];
        exact_matches?: unknown[];
        visual_matches?: Array<{
          title?: string;
          link?: string;
          source?: string;
          thumbnail?: string;
        }>;
      };

      recordSerpApiRequestLog(jobId, cacheKey, httpStatus);

      if (data.error) {
        addJobLog(
          jobId,
          'warn',
          `Bright Data request #${updatedCount}/${limit} error (${remaining} remaining): ${data.error}`
        );
        return {
          matches: [],
          discoveredUrls: [],
          fromCache: false,
          blockedByLimit: false,
          error: data.error,
        };
      }

      const matches = parseGoogleLensMatches(data);
      // Resolve in small batches; no additional Bright Data searches are issued.
      for (let start = 0; start < matches.length; start += 4) {
        await Promise.all(matches.slice(start, start + 4).map(async match => {
          match.link = await resolveGoogleLensRedirect(match.link);
        }));
      }

      const discoveredUrls = Array.from(new Set(matches.map((m) => m.link)));

      // Persist successful response in SQLite cache so duplicates never re-charge Bright Data
      saveSerpApiCache({
        cacheKey,
        engine: 'brightdata_google_lens',
        queryUrl: imageUrl,
        matches,
        discoveredUrls,
        httpStatus,
      });

      addJobLog(
        jobId,
        'info',
        `Bright Data request #${updatedCount}/${limit} completed (${matches.length} visual matches, ${remaining} allowance remaining).`
      );

      return {
        matches,
        discoveredUrls,
        fromCache: false,
        blockedByLimit: false,
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      recordSerpApiRequestLog(jobId, cacheKey, httpStatus);
      addJobLog(
        jobId,
        'warn',
        `Bright Data request #${updatedCount}/${limit} failed (${remaining} remaining): ${msg}`
      );
      return {
        matches: [],
        discoveredUrls: [],
        fromCache: false,
        blockedByLimit: false,
        error: msg,
      };
    }
  });
}
