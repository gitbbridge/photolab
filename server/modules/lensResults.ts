import type { ReverseImageMatch } from '../../src/types.ts';

// Lens can return exact image matches as well as visually similar pages.
export function parseGoogleLensMatches(data: {
  images?: unknown[];
  exact_matches?: unknown[];
  visual_matches?: unknown[];
}): ReverseImageMatch[] {
  const matches = new Map<string, ReverseImageMatch>();
  for (const value of [...(data.exact_matches ?? []), ...(data.visual_matches ?? []), ...(data.images ?? [])]) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.link !== 'string') continue;
    try {
      const url = new URL(entry.link);
      if (!['http:', 'https:'].includes(url.protocol) || matches.has(url.href)) continue;
      const host = url.hostname.replace(/^www\./, '');
      matches.set(url.href, {
        title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : host,
        link: url.href,
        source: typeof entry.source === 'string' ? entry.source : host,
        thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : undefined,
      });
    } catch { /* Invalid result URL, not usable as evidence. */ }
    if (matches.size >= 30) break;
  }
  return [...matches.values()];
}

// Bright Data may return Google /goto links. Resolve Google's redirect without
// fetching the destination property site; preserve the original if unavailable.
export async function resolveGoogleLensRedirect(link: string): Promise<string> {
  let current = link;
  for (let hop = 0; hop < 3; hop++) {
    const url = new URL(current);
    if (!['lens.google.com', 'www.google.com', 'google.com'].includes(url.hostname) || !['/goto', '/url'].includes(url.pathname)) return current;
    const target = url.searchParams.get('q') || url.searchParams.get('url');
    if (target && /^https?:\/\//i.test(target)) return target;
    try {
      const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) return link;
      const next = new URL(location, current);
      if (!['http:', 'https:'].includes(next.protocol)) return link;
      current = next.href;
    } catch { return link; }
  }
  return link;
}
