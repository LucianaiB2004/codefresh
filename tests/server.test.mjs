import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.mjs';
import { mockFetch, okSearch, errSearch } from './helpers.mjs';

const SECRET = 'sk-test-SECRET-should-never-echo';
async function start(fetchImpl, env = { CODEFRESH_QUIET: '1' }) {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = createServer({ fetchImpl, env, port });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}
const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('本地服务：health、连接测试、上游固定为官方域名、不回显密钥', async () => {
  const up = mockFetch((url) => (url.startsWith('https://api.wsa.cloud.tencent.com/') ? okSearch() : { status: 404, json: {} }));
  const s = await start(up);
  try {
    const h = await (await fetch(`${s.base}/api/health`)).json();
    assert.deepEqual(h.envCredentials, { 'api-key': false, aksk: false }, '默认不允许使用环境变量凭据');
    const res = await post(s.base, '/api/connection-test', { method: 'api-key', credentials: { apiKey: SECRET } });
    const text = await res.text();
    assert.equal(JSON.parse(text).ok, true);
    assert.ok(!text.includes(SECRET));
    assert.equal(up.calls[0].url, 'https://api.wsa.cloud.tencent.com/SearchPro');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { await s.close(); }
});

test('本地服务：AK/SK 走 wsa.tencentcloudapi.com；搜索不接受任意 URL 作为上游', async () => {
  const up = mockFetch(() => okSearch());
  const s = await start(up);
  try {
    const r = await (await post(s.base, '/api/search', { method: 'aksk', credentials: { secretId: 'AKIDx', secretKey: SECRET }, query: 'OpenClaw', site: 'blog.csdn.net', freshness: 'd30', url: 'https://evil.com' })).json();
    assert.equal(r.ok, true);
    assert.equal(up.calls.length, 1);
    assert.equal(up.calls[0].url, 'https://wsa.tencentcloudapi.com/');
    assert.deepEqual(JSON.parse(up.calls[0].init.body), { Query: 'OpenClaw', Site: 'blog.csdn.net', Freshness: 'd30' });
  } finally { await s.close(); }
});

test('本地服务：HTTP 200 + Response.Error → ok:false 并带错误码', async () => {
  const s = await start(mockFetch(() => errSearch('ResourceNotFound')));
  try {
    const r = await (await post(s.base, '/api/connection-test', { method: 'api-key', credentials: { apiKey: 'k' } })).json();
    assert.deepEqual([r.ok, r.code, r.requestId], [false, 'ResourceNotFound', 'req-err-1']);
  } finally { await s.close(); }
});

test('本地服务：拒绝跨源、非 loopback Host、超大请求体、非 JSON、未知方式', async () => {
  const s = await start(mockFetch(() => okSearch()));
  try {
    assert.equal((await post(s.base, '/api/search', { method: 'api-key', credentials: { apiKey: 'k' }, query: 'q' }, { Origin: 'https://evil.example' })).status, 403);
    const port = new URL(s.base).port;
    const http = await import('node:http');
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(status, 403, 'DNS rebinding 防护');
    assert.equal((await post(s.base, '/api/search', 'x'.repeat(20000))).status, 413);
    assert.equal((await fetch(`${s.base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await post(s.base, '/api/search', { method: 'other' })).status, 400);
    assert.equal((await post(s.base, '/api/search', { method: 'aksk' })).status, 400);
  } finally { await s.close(); }
});

test('本地服务：静态目录与 /lib 白名单（签名模块不暴露给浏览器）、路径穿越', async () => {
  const s = await start(mockFetch(() => okSearch()));
  try {
    assert.equal((await fetch(`${s.base}/`)).status, 200);
    assert.equal((await fetch(`${s.base}/lib/openclaw.mjs`)).status, 200);
    assert.equal((await fetch(`${s.base}/lib/providers/wsa-aksk.mjs`)).status, 404);
    assert.equal((await fetch(`${s.base}/%2e%2e/server/index.mjs`)).status === 200, false);
    assert.equal((await fetch(`${s.base}/../package.json`)).status === 200, false);
    const r = await fetch(`${s.base}/`);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  } finally { await s.close(); }
});

test('本地服务：环境变量凭据需显式开启才可用，且不会出现在响应中', async () => {
  const up = mockFetch(() => okSearch());
  const s = await start(up, { CODEFRESH_QUIET: '1', CODEFRESH_ALLOW_ENV_CREDENTIALS: '1', TENCENTCLOUD_WSA_APIKEY: SECRET });
  try {
    const h = await (await fetch(`${s.base}/api/health`)).json();
    assert.deepEqual(h.envCredentials, { 'api-key': true, aksk: false });
    const text = await (await post(s.base, '/api/connection-test', { method: 'api-key', credentials: { source: 'env' } })).text();
    assert.equal(JSON.parse(text).ok, true);
    assert.ok(!text.includes(SECRET));
    assert.equal(up.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  } finally { await s.close(); }
});
