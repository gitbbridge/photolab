import fs from 'node:fs';
import type { ImageDecision } from '../../src/types.ts';
import type { DownloadedImageAsset } from './extractor.ts';
import {
  extractUsage,
  CLAUDE_MODEL,
  generateWithRetry,
  type TokenUsageDelta,
} from './claudeClient.ts';

export interface ClassificationOutput {
  decision: ImageDecision;
  reason: string;
  duplicateOf: string | null;
  visualSummary: string;
  usage: TokenUsageDelta;
}

const SUPPORTED_CLAUDE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export async function classifyImageWithClaude(
  asset: DownloadedImageAsset,
  packageTitle: string,
  priorKeptVisuals: Array<{ imageUrl: string; visualSummary: string }>,
  seenSha256Map: Map<string, string>
): Promise<ClassificationOutput> {
  // 1. Exact binary duplicate check via SHA-256
  const existingUrl = seenSha256Map.get(asset.sha256);
  if (existingUrl) {
    return {
      decision: 'DUPLICATE',
      reason: 'Exact binary duplicate (matching SHA-256 hash) of an earlier downloaded image.',
      duplicateOf: existingUrl,
      visualSummary: 'Exact binary copy of prior image.',
      usage: { promptTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  }
  seenSha256Map.set(asset.sha256, asset.imageUrl);

  if (!SUPPORTED_CLAUDE_MIME_TYPES.has(asset.mimeType)) {
    return {
      decision: 'NEEDS_REVIEW',
      reason: `Unsupported image MIME type (${asset.mimeType}) for automated vision classification; flagged for human review.`,
      duplicateOf: null,
      visualSummary: 'Unsupported raster format.',
      usage: { promptTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  }

  const imageBytes = fs.readFileSync(asset.localPath);
  const base64Data = imageBytes.toString('base64');

  const priorContext =
    priorKeptVisuals.length > 0
      ? `\nEarlier retained accommodation photos from this same listing:\n${priorKeptVisuals
          .slice(0, 8)
          .map((p, idx) => `${idx + 1}. [${p.imageUrl}] -> ${p.visualSummary}`)
          .join('\n')}`
      : '';

  const prompt = `Visually inspect this photograph extracted from a charity travel-package webpage titled: "${packageTitle}".
Do NOT rely on filenames or alt text—judge strictly from the visual contents of the image.

Classify into exactly ONE category:
- KEEP: Accommodation interiors (hotel rooms, suites, villas, bedrooms, living rooms, bathrooms, lobbies), identifiable property exteriors (hotel building, resort facade, villa exterior, lodge), or accommodation amenities (property pool, patio, balcony, courtyard, terrace, private deck, spa pavilion). Note: A hotel appearing incidentally in a distant city skyline does NOT qualify as KEEP.
- SET_ASIDE: Unrelated destination imagery, generic city skylines, tourist attractions, beaches/mountains with no identifiable accommodation structure, plated food/drinks without property architecture, portraits/people, maps, or promotional text banners/collages.
- DUPLICATE: Visually equivalent or cropped/resized copy of one of the earlier retained images from this listing.
- NEEDS_REVIEW: Ambiguous, heavily obscured, watermarked, or uncertain whether it belongs to a specific accommodation property.
${priorContext}

Provide:
1. decision: KEEP | SET_ASIDE | DUPLICATE | NEEDS_REVIEW
2. reason: 1 concise sentence explaining the visual evidence.
3. duplicate_of_url: If DUPLICATE, exact URL from the earlier retained list above, else empty string.
4. visual_summary: Concrete description of architectural features, room decor, signage, pool/patio details, or scenery visible in the image (for property identification).`;

  const response = await generateWithRetry({
    model: CLAUDE_MODEL,
    input: {
      parts: [
        {
          inlineData: {
            mimeType: asset.mimeType,
            data: base64Data,
          },
        },
        { text: prompt },
      ],
    },
    config: {
            schema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            description: 'One of KEEP, SET_ASIDE, DUPLICATE, NEEDS_REVIEW',
          },
          reason: {
            type: 'string',
            description: 'Concise visual justification for the classification.',
          },
          duplicate_of_url: {
            type: 'string',
            description: 'Exact URL of the earlier retained image if DUPLICATE, otherwise empty string.',
          },
          visual_summary: {
            type: 'string',
            description: 'Detailed visual description of room, facade, signage, or scenery.',
          },
        },
        required: ['decision', 'reason', 'visual_summary'],
      },
    },
  });

  const usage = extractUsage(response);
  const rawText = (response.text ?? '{}').trim();

  let parsed: {
    decision?: string;
    reason?: string;
    duplicate_of_url?: string;
    visual_summary?: string;
  } = {};

  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      decision: 'NEEDS_REVIEW',
      reason: 'Model output could not be parsed cleanly; flagged for manual review.',
      duplicateOf: null,
      visualSummary: rawText.slice(0, 200),
      usage,
    };
  }

  const allowed: ImageDecision[] = ['KEEP', 'SET_ASIDE', 'DUPLICATE', 'NEEDS_REVIEW'];
  const normalizedDecision = String(parsed.decision || '').toUpperCase().replace(/\s+/g, '_');
  const decision: ImageDecision = allowed.includes(normalizedDecision as ImageDecision)
    ? (normalizedDecision as ImageDecision)
    : 'NEEDS_REVIEW';

  return {
    decision,
    reason: (parsed.reason || 'Classified via Claude visual inspection.').trim(),
    duplicateOf:
      decision === 'DUPLICATE' && parsed.duplicate_of_url?.trim()
        ? parsed.duplicate_of_url.trim()
        : null,
    visualSummary: (parsed.visual_summary || '').trim(),
    usage,
  };
}
