import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWithRetry, CLAUDE_MODEL } from '../server/modules/claudeClient.ts';
let replies: any[] = [];
let requests: any[] = [];
globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(String(init?.body)));
  const reply = replies.shift();
  assert.ok(reply, 'Unexpected API request');
  return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: CLAUDE_MODEL,
    usage: { input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
    stop_reason: 'end_turn', ...reply }), { headers: { 'content-type': 'application/json' } });
};
test('Claude adapter handles credentials, images, structured results, web sources and failures', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(generateWithRetry({ model: CLAUDE_MODEL, input: 'test' }), /ANTHROPIC_API_KEY/);
  process.env.ANTHROPIC_API_KEY = 'test-only-no-real-requests';
  replies = [{ content: [{ type: 'text', text: JSON.stringify({ decision: 'KEEP' }) }] }];
  const result = await generateWithRetry({ model: CLAUDE_MODEL, input: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }, { text: 'Classify' }] }, config: { schema: { type: 'object', properties: { decision: { type: 'string' } } } } });
  assert.equal(JSON.parse(result.text).decision, 'KEEP');
  assert.equal(requests[0].messages[0].content[0].source.media_type, 'image/png');
  assert.equal(requests[0].tool_choice, undefined);
  assert.equal(requests[0].tools, undefined);
  assert.equal(requests[0].output_config.format.type, 'json_schema');
  assert.equal(requests[0].output_config.format.schema.additionalProperties, false);
  const source = { type: 'web_search_tool_result', tool_use_id: 'search_1', content: [{ type: 'web_search_result', url: 'https://hotel.example', title: 'Hotel', encrypted_content: 'test' }] };
  replies = [{ stop_reason: 'pause_turn', content: [source] }, { content: [{ type: 'text', text: 'Verified research', citations: [{ type: 'web_search_result_location', url: 'https://hotel.example' }] }] }];
  const research = await generateWithRetry({ model: CLAUDE_MODEL, input: 'Research', config: { webSearch: true } });
  assert.deepEqual(research.sourceUrls, ['https://hotel.example']);
  assert.equal(research.usage.promptTokens, 200);
  assert.ok(Math.abs(research.usage.estimatedCostUsd - 0.0208) < 0.000001);
  assert.equal(requests.at(-1).messages[1].role, 'assistant');
  assert.equal(requests.at(-1).tools[0].name, 'web_search');
  replies = [{ content: [{ type: 'web_search_tool_result', tool_use_id: 'search_2', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }] }];
  await assert.rejects(generateWithRetry({ model: CLAUDE_MODEL, input: 'Research', config: { webSearch: true } }), /web search failed: unavailable/);
  replies = [{ content: [{ type: 'text', text: 'Unsupported guess' }] }];
  await assert.rejects(generateWithRetry({ model: CLAUDE_MODEL, input: 'Research', config: { webSearch: true } }), /no web-search sources/);
  replies = [{ stop_reason: 'max_tokens', content: [] }];
  await assert.rejects(generateWithRetry({ model: CLAUDE_MODEL, input: 'Research' }), /response incomplete/);
  replies = [{ content: [{ type: 'text', text: 'not JSON' }] }];
  await assert.rejects(generateWithRetry({ model: CLAUDE_MODEL, input: 'Classify', config: { schema: { type: 'object' } } }), /valid structured JSON/);
  assert.equal(replies.length, 0);
});
