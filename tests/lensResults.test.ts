import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleLensMatches } from '../server/modules/lensResults.ts';

test('preserves exact and third-party Lens evidence, deduplicates and rejects invalid URLs', () => {
 const matches = parseGoogleLensMatches({
  exact_matches: [{ title: 'Mayan Palace', link: 'https://vrbo.com/property/123' }, { link: 'https://vidanta.com/resorts' }],
  visual_matches: [{ title: 'Duplicate', link: 'https://vrbo.com/property/123' }, { title: 'Resort', link: 'https://expedia.com/hotel' }, { link: 'javascript:alert(1)' }, null, { title: 'No URL' }],
 });
 assert.deepEqual(matches.map(m => m.link), ['https://vrbo.com/property/123', 'https://vidanta.com/resorts', 'https://expedia.com/hotel']);
 assert.equal(matches[1].title, 'vidanta.com');
 assert.deepEqual(parseGoogleLensMatches({}), []);
});


test('accepts both SerpAPI environment variable spellings', async () => {
 const { getSerpApiKey } = await import('../server/modules/serpapiConfig.ts');
 const canonical = process.env.SERPAPI_API_KEY;
 const alternate = process.env.SERP_API_KEY;
 try {
  delete process.env.SERPAPI_API_KEY;
  process.env.SERP_API_KEY = ' alternate-test-key ';
  assert.equal(getSerpApiKey(), 'alternate-test-key');
  process.env.SERPAPI_API_KEY = ' canonical-test-key ';
  assert.equal(getSerpApiKey(), 'alternate-test-key');
  process.env.SERPAPI_API_KEY = '  ';
  assert.equal(getSerpApiKey(), 'alternate-test-key');
 } finally {
  if (canonical === undefined) delete process.env.SERPAPI_API_KEY; else process.env.SERPAPI_API_KEY = canonical;
  if (alternate === undefined) delete process.env.SERP_API_KEY; else process.env.SERP_API_KEY = alternate;
 }
});


test('Bright Data Lens request sends the image inside a parsed Lens URL and supports images results', async () => {
 const { buildBrightDataLensRequest } = await import('../server/modules/serpapiConfig.ts');
 const request = buildBrightDataLensRequest('https://example.com/photo.jpg?a=1&b=2', 'serp_api1');
 assert.equal(request.zone, 'serp_api1');
 assert.equal(request.format, 'raw');
 const url = new URL(request.url);
 assert.equal(url.hostname, 'lens.google.com');
 assert.equal(url.searchParams.get('url'), 'https://example.com/photo.jpg?a=1&b=2');
 assert.equal(url.searchParams.get('brd_json'), '1');
 assert.equal(url.searchParams.get('brd_lens'), 'visual_matches');
 assert.throws(() => buildBrightDataLensRequest('file:///private', 'test'), /HTTP image/);
 const matches = parseGoogleLensMatches({images:[{title:'Mayan Palace',link:'https://vrbo.com/resort',source:'Vrbo'}]});
 assert.equal(matches[0].link, 'https://vrbo.com/resort');
});

test('resolves only Google redirect links without fetching destination sites', async () => {
 const { resolveGoogleLensRedirect } = await import('../server/modules/lensResults.ts');
 const originalFetch = globalThis.fetch;
 const seen: string[] = [];
 globalThis.fetch = async (url, init) => {
  seen.push(String(url));
  assert.equal(init?.redirect, 'manual');
  return new Response(null, {status:302, headers:{location:'https://vrbo.com/resort'}});
 };
 try {
  assert.equal(await resolveGoogleLensRedirect('https://lens.google.com/goto?url=encrypted'), 'https://vrbo.com/resort');
  assert.equal(await resolveGoogleLensRedirect('https://hotel.example/'), 'https://hotel.example/');
  assert.equal(seen.length, 1);
 } finally { globalThis.fetch = originalFetch; }
});
