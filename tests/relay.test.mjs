import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, parseOrigins, createRateLimiter } from '../relay/server.mjs';
import { mockFetch, okSearch, errSearch } from './helpers.mjs';

const SECRET = 'sk-relay-SECRET-should-never-echo';
const ORIGIN = 'https://lucianaib2004.github.io';
async function start(fetchImpl, env = {}) {
  const logs = [];
  const server = createRelay({ fetchImpl, env: { ...env }, log: (l) => logs.push(l) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, logs, close: () => new Promise((r) => server.close(r)) };
}
const post = (base, p, body, headers = { Origin: ORIGIN }) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('relay：默认来源白名单', () => {
  assert.deepEqual([...parseOrigins('')], ['https://lucianaib2004.github.io', 'http://127.0.0.1:4173']);
  assert.deepEqual([...parseOrigins('https://a.com/, http://b.com')], ['https://a.com', 'http://b.com']);
});

test('relay：health 与 CORS 预检只放行白名单来源', async () => {
  const s = await start(mockFetch(() => okSearch()));
  try {
    const h = await (await fetch(`${s.base}/health`)).json();
    assert.equal(h.ok, true);
    const pre = await fetch(`${s.base}/api/wsa/search`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    const bad = await fetch(`${s.base}/api/wsa/search`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    const evil = await post(s.base, '/api/wsa/search', { apiKey: SECRET, body: { Query: 'x' } }, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const noOrigin = await post(s.base, '/api/wsa/search', { apiKey: SECRET, body: { Query: 'x' } }, {});
    assert.equal(noOrigin.status, 403);
  } finally { await s.close(); }
});

test('relay：API Key 模式转发到官方域名，只保留 Query/Site/Freshness，不回显、不记录密钥', async () => {
  const up = mockFetch(() => okSearch());
  const s = await start(up);
  try {
    const res = await post(s.base, '/api/wsa/search', { apiKey: SECRET, body: { Query: 'OpenClaw', Site: 'blog.csdn.net', Freshness: 'd30', Mode: 2, Url: 'https://evil.com' } });
    const text = await res.text();
    const j = JSON.parse(text);
    assert.equal(j.ok, true); assert.equal(j.provider, 'api-key'); assert.equal(j.items.length, 1);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(up.calls[0].url, 'https://api.wsa.cloud.tencent.com/SearchPro');
    assert.equal(up.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
    assert.deepEqual(JSON.parse(up.calls[0].init.body), { Query: 'OpenClaw', Site: 'blog.csdn.net', Freshness: 'd30' });
    assert.ok(!text.includes(SECRET));
    assert.ok(s.logs.length >= 1 && s.logs.every((l) => !l.includes(SECRET) && !l.includes('OpenClaw')));
    assert.match(s.logs.at(-1), /POST \/api\/wsa\/search 200 \d+ms$/);
  } finally { await s.close(); }
});

test('relay：TC3 模式在服务端签名并转发到 wsa.tencentcloudapi.com', async () => {
  const up = mockFetch(() => okSearch());
  const s = await start(up);
  try {
    const j = await (await post(s.base, '/api/wsa/tc3', { secretId: 'AKIDtest', secretKey: SECRET, body: { Query: 'OpenClaw' } })).json();
    assert.equal(j.ok, true); assert.equal(j.provider, 'aksk');
    assert.equal(up.calls[0].url, 'https://wsa.tencentcloudapi.com/');
    const h = up.calls[0].init.headers;
    assert.match(h.Authorization, /^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/wsa\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
    assert.ok(!h.Authorization.includes(SECRET));
    assert.equal(h['X-TC-Action'], 'SearchPro'); assert.equal(h['X-TC-Version'], '2025-05-08');
  } finally { await s.close(); }
});

test('relay：上游错误透传为结构化错误；缺凭据 400；参数错误 400', async () => {
  const s = await start(mockFetch(() => errSearch('UnauthorizedOperation')));
  try {
    const j = await (await post(s.base, '/api/wsa/search', { apiKey: SECRET, body: { Query: 'x' } })).json();
    assert.equal(j.ok, false); assert.equal(j.code, 'UnauthorizedOperation'); assert.equal(j.requestId, 'req-err-1');
    const miss = await post(s.base, '/api/wsa/tc3', { secretId: 'AKID', body: { Query: 'x' } });
    assert.equal(miss.status, 400); assert.equal((await miss.json()).code, 'MissingCredentials');
    const bad = await post(s.base, '/api/wsa/search', { apiKey: SECRET, body: { Query: 'x', Freshness: 'forever' } });
    assert.equal(bad.status, 400);
    const empty = await post(s.base, '/api/wsa/search', { apiKey: SECRET, body: {} });
    assert.equal(empty.status, 400);
  } finally { await s.close(); }
});

test('relay：请求体上限 16KB、非 JSON 拒绝、未知路径 404', async () => {
  const up = mockFetch(() => okSearch());
  const s = await start(up);
  try {
    const big = await post(s.base, '/api/wsa/search', { apiKey: 'x'.repeat(17 * 1024), body: { Query: 'x' } });
    assert.equal(big.status, 413);
    const txt = await fetch(`${s.base}/api/wsa/search`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: 'hi' });
    assert.equal(txt.status, 415);
    assert.equal((await fetch(`${s.base}/api/other`)).status, 404);
    assert.equal(up.calls.length, 0);
  } finally { await s.close(); }
});

test('relay：上游超时返回 Timeout，网络错误返回 NetworkError', async () => {
  const s = await start(mockFetch((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)))), { UPSTREAM_TIMEOUT_MS: '50' });
  try {
    const j = await (await post(s.base, '/api/wsa/search', { apiKey: SECRET, body: { Query: 'x' } })).json();
    assert.equal(j.code, 'Timeout');
  } finally { await s.close(); }
  const s2 = await start(mockFetch(() => new TypeError('fetch failed')));
  try {
    const j = await (await post(s2.base, '/api/wsa/search', { apiKey: SECRET, body: { Query: 'x' } })).json();
    assert.equal(j.code, 'NetworkError');
  } finally { await s2.close(); }
});

test('relay：每 IP 限流', async () => {
  const s = await start(mockFetch(() => okSearch()), { RATE_LIMIT_PER_MIN: '3' });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(s.base, '/api/wsa/search', { apiKey: SECRET, body: { Query: 'x' } })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally { await s.close(); }
  let t = 0; const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
  assert.equal(rl.take('a').ok, true); assert.equal(rl.take('a').ok, false); assert.equal(rl.take('b').ok, true);
  t = 1000; assert.equal(rl.take('a').ok, true);
});
