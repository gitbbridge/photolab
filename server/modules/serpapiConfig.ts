export function getSerpApiKey(): string | undefined {
  // SERP_API_KEY is retained for existing Bright Data configurations.
  return process.env.BRIGHTDATA_API_KEY?.trim() || process.env.SERP_API_KEY?.trim() || process.env.SERPAPI_API_KEY?.trim() || undefined;
}
export function getBrightDataZone(): string | undefined {
  return process.env.BRIGHTDATA_SERP_ZONE?.trim() || process.env.BRIGHTDATA_ZONE?.trim() || undefined;
}
export function isBrightDataConfigured(): boolean {
  return Boolean(getSerpApiKey() && getBrightDataZone());
}
export function buildBrightDataLensRequest(imageUrl: string, zone: string) {
  const image = new URL(imageUrl);
  if (!['http:', 'https:'].includes(image.protocol)) throw new Error('Lens requires an HTTP image URL.');
  const url = new URL('https://lens.google.com/uploadbyurl');
  url.searchParams.set('url', image.href);
  url.searchParams.set('brd_json', '1');
  url.searchParams.set('brd_lens', 'visual_matches');
  url.searchParams.set('hl', 'en');
  return { zone, url: url.href, format: 'raw' };
}
