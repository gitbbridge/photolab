import { isBrightDataConfigured } from './serpapiConfig.ts';
import { addJobLog } from '../db/database.ts';
import fs from 'node:fs';
import type {
  ConfidenceLevel,
  ImageRecord,
  ReverseImageMatch,
  VerificationStatus,
} from '../../src/types.ts';
import {
  extractUsage,
  CLAUDE_MODEL,
  generateWithRetry,
  type TokenUsageDelta,
} from './claudeClient.ts';
import {
  safeSerpApiGoogleLensSearch,
  SERPAPI_HARD_RUN_LIMIT,
  SERPAPI_RATE_LIMIT_PER_MIN,
} from './serpapiGuard.ts';

export interface ReverseImageProviderStatus {
  name: string;
  configured: boolean;
  envVar: string;
  description: string;
  maxRequestsPerRun: number;
  rateLimitPerMin: number;
}

export function getReverseImageProviderStatus(): ReverseImageProviderStatus {
  const serpKey = isBrightDataConfigured();
  return {
    name: serpKey ? 'Bright Data Google Lens + Claude Web Search' : 'Claude Vision + Live Web Search',
    configured: Boolean(serpKey),
    envVar: 'BRIGHTDATA_API_KEY + BRIGHTDATA_SERP_ZONE',
    description: serpKey
      ? `Google Lens visual reverse-image matching is active (hard cap: ${SERPAPI_HARD_RUN_LIMIT} requests/run, ${SERPAPI_RATE_LIMIT_PER_MIN} req/min, persistent cache enabled).`
      : 'External reverse-image matching (Google Lens via Bright Data) is optional and currently unconfigured (Bright Data API key or SERP zone not set). Supplier discovery uses Claude Vision + live web search grounding.',
    maxRequestsPerRun: SERPAPI_HARD_RUN_LIMIT,
    rateLimitPerMin: SERPAPI_RATE_LIMIT_PER_MIN,
  };
}

// Known OTAs, metasearch engines, social sites, and charity auction package resellers
const NON_DIRECT_DOMAINS = [
  'booking.com',
  'expedia.com',
  'hotels.com',
  'agoda.com',
  'tripadvisor.com',
  'airbnb.com',
  'vrbo.com',
  'homeaway.com',
  'kayak.com',
  'priceline.com',
  'orbitz.com',
  'travelocity.com',
  'trivago.com',
  'hotwire.com',
  'skyscanner.com',
  'google.com',
  'wikipedia.org',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'pinterest.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'giveholidays.com',
  'charitybuzz.com',
  'winspireme.com',
  'amfund.org',
  'luxgive.com',
  'biddingforgood.com',
  '32auctions.com',
  'givergy.com',
  'handbid.com',
  'onecause.com',
  'qtego.net',
  'greatergiving.com',
  'auctria.com',
  'givesmart.com',
  'event.gives',
];

function extractDomain(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function isThirdPartyOrResellerUrl(urlStr: string, packageUrl?: string): boolean {
  const host = extractDomain(urlStr);
  if (!host) return true;

  if (packageUrl) {
    const pkgHost = extractDomain(packageUrl);
    if (pkgHost && (host === pkgHost || host.endsWith(`.${pkgHost}`))) {
      return true;
    }
  }

  return NON_DIRECT_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

// Direct unguarded Bright Data queries removed; all calls go through safeSerpApiGoogleLensSearch in serpapiGuard.ts

export interface SupplierDiscoveryOutput {
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
  usage: TokenUsageDelta;
}

export async function discoverAccommodationSupplier(params: {
  jobId: string;
  packageUrl: string;
  pageTitle: string | null;
  packageDescription: string | null;
  keptImages: ImageRecord[];
  manualRetry?: boolean;
}): Promise<SupplierDiscoveryOutput> {
  const { jobId, packageUrl, pageTitle, packageDescription, keptImages } = params;

  const totalUsage: TokenUsageDelta = {
    promptTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };

  if (keptImages.length === 0) {
    return {
      accommodationName: null,
      propertyType: null,
      city: null,
      country: null,
      directSupplierUrl: null,
      confidence: 'NONE',
      verificationStatus: 'UNRESOLVED',
      evidenceUrls: [],
      imageUrls: [],
      unresolvedReason: 'No qualifying accommodation photographs were retained for this package.',
      notes: null,
      reverseImageMatches: [],
      usage: totalUsage,
    };
  }

  if (!isBrightDataConfigured()) {
    addJobLog(jobId, 'warn', 'Google Lens skipped: Bright Data API key or SERP zone is not configured. Supplier discovery will use Claude web search only.', packageUrl);
  }

  // Guarded Bright Data Google Lens lookup on the primary retained accommodation image (max 1 per package, cached + rate-limited + 100/run capped)
  const reverseImageMatches: ReverseImageMatch[] = [];
  if (isBrightDataConfigured() && keptImages.length > 0) {
    const primaryImg = keptImages[0];
    const guardedResult = await safeSerpApiGoogleLensSearch(jobId, primaryImg.image_url, { allowPaused: params.manualRetry });
    for (const m of guardedResult.matches) {
      if (!reverseImageMatches.some((existing) => existing.link === m.link)) {
        reverseImageMatches.push(m);
      }
    }
  }

  // Prepare up to 4 retained images as visual evidence for Claude
  const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  const usedImageUrls: string[] = [];

  for (const img of keptImages.slice(0, 4)) {
    if (
      img.local_path &&
      fs.existsSync(img.local_path) &&
      img.mime_type &&
      ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(img.mime_type)
    ) {
      const buf = fs.readFileSync(img.local_path);
      imageParts.push({
        inlineData: {
          mimeType: img.mime_type,
          data: buf.toString('base64'),
        },
      });
      usedImageUrls.push(img.image_url);
    }
  }

  const allKeptUrls = keptImages.map((i) => i.image_url);

  const reverseContext =
    reverseImageMatches.length > 0
      ? `\nReverse-Image Search Matches:\n${reverseImageMatches
          .map((m, i) => `${i + 1}. "${m.title}" (${m.source}) -> ${m.link}`)
          .join('\n')}`
      : isBrightDataConfigured()
        ? '\nGoogle Lens returned no usable matches for the searched image, or the request was skipped/failed. Check the activity log. Use visual clues and live web search; do not claim Lens verification.'
        : '\nGoogle Lens is not configured. Use visual clues and live web search; do not claim Lens verification.';

  const visualSummaries = keptImages
    .slice(0, 6)
    .map((img, i) => `Photo ${i + 1}: ${img.visual_summary || img.reason}`)
    .join('\n');

  // Step 1: Grounded Research with Claude Web Search + Visual Evidence
  const researchPrompt = `You are a travel accommodation researcher verifying the EXACT real-world hotel, resort, villa, lodge, or vacation rental featured in a charity auction package listing.

Package URL: ${packageUrl}
Page Title: ${pageTitle || '(unknown)'}
Package Description: ${(packageDescription || '').slice(0, 1800)}
Visual Summaries of Accommodation Photos:
${visualSummaries}
${reverseContext}

CRITICAL RULES:
1. Examine the photographs, visible architectural/decor details, signage, destination clues, and package text.
2. Use web search to identify the actual accommodation property and find its OFFICIAL DIRECT WEBSITE URL (e.g., the hotel, resort, or property management company's own website).
3. Distinguish direct property websites from Online Travel Agencies (Booking.com, Expedia, Hotels.com, TripAdvisor, Airbnb, Vrbo, Kayak) and charity auction resellers (Give Holidays, Charitybuzz, Winspire, AmFund, LuxGive, etc.). Do NOT report an OTA or auction site as the direct supplier website.
4. NEVER invent, guess, or fabricate a property name or website URL. If the package offers a choice across locations in a verifiable resort group, preserve the supported brand/operator name and official group website as a PROPOSED supplier; explain that the exact property/location remains unconfirmed. Do not discard a supported supplier just because multiple locations are offered. VERIFIED requires evidence for the exact property.
5. Reverse-image matches on Vrbo, Expedia or other third-party sites are useful evidence for identifying a property. Retain those evidence URLs and research the property's official website separately; never present a third-party page as the direct supplier URL. If neither a property nor its operator can be supported by evidence, report UNRESOLVED.

Summarize your verified findings clearly, including:
- Exact Accommodation Name (or UNKNOWN)
- Property Type (Hotel, Resort, Boutique Hotel, Villa, Vacation Rental, Lodge, Condo, etc.)
- City & Country
- Official Direct Supplier Website URL (must be verified via search, NOT an OTA or auction page)
- Reasoning & evidence linking the photographs/package to that supplier.`;

  const searchResponse = await generateWithRetry({
    model: CLAUDE_MODEL,
    input: {
      parts: [...imageParts, { text: researchPrompt }],
    },
    config: {
      webSearch: true,
    },
  });

  const usage1 = extractUsage(searchResponse);
  totalUsage.promptTokens += usage1.promptTokens;
  totalUsage.outputTokens += usage1.outputTokens;
  totalUsage.estimatedCostUsd += usage1.estimatedCostUsd;

  const researchNotes = (searchResponse.text ?? '').trim();

  // Extract grounding URLs from Claude web-search results
  const groundingChunks = searchResponse.sourceUrls;
  const groundedUrls = new Set<string>();
  for (const chunk of groundingChunks) {
    const uri = chunk;
    if (uri && /^https?:\/\//i.test(uri)) {
      groundedUrls.add(uri);
    }
  }
  for (const m of reverseImageMatches) {
    if (m.link) groundedUrls.add(m.link);
  }

  // Step 2: Structured extraction with strict schema validation
  const extractionPrompt = `Convert the following grounded research report into structured JSON.
Package URL: ${packageUrl}
Available grounded URLs discovered during search:
${Array.from(groundedUrls).join('\n') || '(none)'}

Research report:
${researchNotes}

Rules:
- direct_supplier_url MUST be the official direct website of the accommodation property (not Booking.com, Expedia, TripAdvisor, Airbnb, Vrbo, Give Holidays, or other auction resellers). If no verified direct supplier URL was found, set direct_supplier_url to empty string "".
- For a choice-of-resorts package with a supported brand/operator, preserve accommodation_name as the brand/operator and its verified official group URL as direct_supplier_url, use PROPOSED, and explain the unconfirmed location in unresolved_reason. Never invent a city.
- If neither the accommodation nor its brand/operator can be reliably identified, set accommodation_name to empty string "" and verification_status to "UNRESOLVED".
- confidence must be one of: HIGH, MEDIUM, LOW, NONE.
- verification_status must be one of: VERIFIED (direct official URL and property verified), PROPOSED (likely property identified but direct website needs manual confirmation), UNRESOLVED (cannot verify property or direct supplier).
- evidence_urls should include the most relevant supporting URLs from the grounded URLs list above (never invent URLs).`;

  const structResponse = await generateWithRetry({
    model: CLAUDE_MODEL,
    input: extractionPrompt,
    config: {
            schema: {
        type: 'object',
        properties: {
          accommodation_name: { type: 'string' },
          property_type: { type: 'string' },
          city: { type: 'string' },
          country: { type: 'string' },
          direct_supplier_url: { type: 'string' },
          confidence: { type: 'string' },
          verification_status: { type: 'string' },
          evidence_urls: {
            type: 'array',
            items: { type: 'string' },
          },
          unresolved_reason: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['confidence', 'verification_status'],
      },
    },
  });

  const usage2 = extractUsage(structResponse);
  totalUsage.promptTokens += usage2.promptTokens;
  totalUsage.outputTokens += usage2.outputTokens;
  totalUsage.estimatedCostUsd += usage2.estimatedCostUsd;

  let parsed: {
    accommodation_name?: string;
    property_type?: string;
    city?: string;
    country?: string;
    direct_supplier_url?: string;
    confidence?: string;
    verification_status?: string;
    evidence_urls?: string[];
    unresolved_reason?: string;
    notes?: string;
  } = {};

  try {
    parsed = JSON.parse((structResponse.text ?? '{}').trim());
  } catch {
    return {
      accommodationName: null,
      propertyType: null,
      city: null,
      country: null,
      directSupplierUrl: null,
      confidence: 'NONE',
      verificationStatus: 'UNRESOLVED',
      evidenceUrls: Array.from(groundedUrls),
      imageUrls: allKeptUrls,
      unresolvedReason: 'Failed to parse structured supplier verification output.',
      notes: researchNotes.slice(0, 1000),
      reverseImageMatches,
      usage: totalUsage,
    };
  }

  let directUrl = parsed.direct_supplier_url?.trim() || null;
  if (directUrl) {
    try {
      const u = new URL(directUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        directUrl = null;
      }
    } catch {
      directUrl = null;
    }
  }

  let accommodationName = parsed.accommodation_name?.trim() || null;
  if (accommodationName && /^(unknown|n\/a|none|unresolved)$/i.test(accommodationName)) {
    accommodationName = null;
  }

  let unresolvedReason = parsed.unresolved_reason?.trim() || null;
  const rawConf = String(parsed.confidence || 'NONE').toUpperCase();
  let confidence: ConfidenceLevel = ['HIGH', 'MEDIUM', 'LOW', 'NONE'].includes(rawConf)
    ? (rawConf as ConfidenceLevel)
    : 'NONE';

  const rawStatus = String(parsed.verification_status || 'UNRESOLVED').toUpperCase();
  let verificationStatus: VerificationStatus = ['VERIFIED', 'PROPOSED', 'UNRESOLVED'].includes(
    rawStatus
  )
    ? (rawStatus as VerificationStatus)
    : 'UNRESOLVED';

  // Server-side guardrail: reject third-party OTAs or auction sites as direct supplier URLs
  if (directUrl && isThirdPartyOrResellerUrl(directUrl, packageUrl)) {
    groundedUrls.add(directUrl);
    directUrl = null;
    if (accommodationName) {
      verificationStatus = 'PROPOSED';
      if (confidence === 'HIGH') confidence = 'MEDIUM';
      unresolvedReason =
        unresolvedReason ||
        'Identified property name, but found URL was a third-party OTA or reseller rather than the direct official website.';
    } else {
      verificationStatus = 'UNRESOLVED';
      confidence = 'NONE';
      unresolvedReason =
        'Only third-party OTA or charity reseller URLs were found; direct accommodation supplier could not be verified.';
    }
  }

  if (!accommodationName) {
    verificationStatus = 'UNRESOLVED';
    confidence = 'NONE';
    directUrl = null;
    unresolvedReason =
      unresolvedReason ||
      'Insufficient visual or web search evidence to confidently identify the specific accommodation property.';
  } else if (!directUrl && verificationStatus === 'VERIFIED') {
    verificationStatus = 'PROPOSED';
    unresolvedReason =
      unresolvedReason || 'Property identified, but direct supplier website URL requires confirmation.';
  }

  const combinedEvidence = Array.from(
    new Set([...(parsed.evidence_urls ?? []), ...Array.from(groundedUrls)])
  ).filter((u) => /^https?:\/\//i.test(u));

  return {
    accommodationName,
    propertyType: parsed.property_type?.trim() || null,
    city: parsed.city?.trim() || null,
    country: parsed.country?.trim() || null,
    directSupplierUrl: directUrl,
    confidence,
    verificationStatus,
    evidenceUrls: combinedEvidence,
    imageUrls: allKeptUrls,
    unresolvedReason,
    notes: parsed.notes?.trim() || researchNotes.slice(0, 1200) || null,
    reverseImageMatches,
    usage: totalUsage,
  };
}
