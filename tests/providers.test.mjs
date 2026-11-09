import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchProResponse, normalizeDate, isCsdnUrl, normalizeUrl } from '../src/providers/wsa-response.mjs';
import { buildSearchBody } from '../src/providers/request.mjs';
import { tc3Sign, buildAkSkRequest, AKSK_HOST } from '../src/providers/wsa-aksk.mjs';
import { buildApiKeyRequest, API_KEY_ENDPOINT } from '../src/providers/wsa-api-key.mjs';
import { runSearch, testConnection } from '../src/providers/index.mjs';
import { mockFetch, okSearch, errSearch } from './helpers.mjs';

test('HTTP 200 但 Response.Error 存在 → 判定失败并显示服务商错误', () => {
  const r = parseSearchProResponse({ Response: { RequestId: 'r1', Error: { Code: 'UnauthorizedOperation', Message: 'x' } } }, { httpStatus: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UnauthorizedOperation');
  assert.equal(r.requestId, 'r1');
});

test('Pages 是 JSON 字符串数组：坏条目安全跳过，好条目保留', () => {
  const pages = [
    JSON.stringify({ title: 'A', url: 'https://a.com/x', date: '2026/10/06 00:00:00', passage: 'p' }),
    '{bad json',
    JSON.stringify({ title: 'no url' }),
    JSON.stringify({ title: 'js', url: 'javascript:alert(1)' }),
    JSON.stringify({ title: 'B', url: 'https://blog.csdn.net/u/article/details/1', date: '', site: 'CSDN博客' }),
  ];
  const r = parseSearchProResponse({ Response: { RequestId: 'r', Pages: pages, Version: 'lite' } });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  assert.equal(r.skipped, 3);
  assert.equal(r.items[0].date, '2026-10-06');
  assert.equal(r.items[1].date, null, '空日期不编造');
  assert.equal(r.items[0].score, null, '极速版无 score → null，不补假分数');
  assert.equal(r.items[1].isCsdn, true);
});

test('缺少 Response / Pages 时不崩溃', () => {
  assert.equal(parseSearchProResponse(null, { httpStatus: 502 }).error.code, 'HTTP502');
  assert.equal(parseSearchProResponse({ Response: { RequestId: 'x' } }).ok, false);
});

test('CSDN 只按真实域名判断，site 字段不可信', () => {
  assert.equal(isCsdnUrl('https://blog.csdn.net/a'), true);
  assert.equal(isCsdnUrl('https://csdn.net'), true);
  assert.equal(isCsdnUrl('https://notcsdn.net/a'), false);
  assert.equal(isCsdnUrl('https://csdn.net.evil.com/a'), false);
  const r = parseSearchProResponse({ Response: { Pages: [JSON.stringify({ title: 't', url: 'https://zhihu.com/a', site: 'CSDN' })] } });
  assert.equal(r.items[0].isCsdn, false);
});

test('日期与 URL 归一化', () => {
  assert.equal(normalizeDate('2026-1-5'), '2026-01-05');
  assert.equal(normalizeDate('昨天'), null);
  assert.equal(normalizeUrl('https://www.A.com/x/?utm_source=openai#h'), normalizeUrl('http://a.com/x'));
});

test('请求体只含 Query + 合法的 Site / Freshness', () => {
  assert.deepEqual(buildSearchBody({ query: '  OpenClaw  ' }), { Query: 'OpenClaw' });
  assert.deepEqual(buildSearchBody({ query: 'x', site: 'blog.csdn.net', freshness: 'd30' }), { Query: 'x', Site: 'blog.csdn.net', Freshness: 'd30' });
  assert.throws(() => buildSearchBody({ query: '   ' }), /不能为空/);
  assert.throws(() => buildSearchBody({ query: 'x', freshness: 'd31' }));
  assert.throws(() => buildSearchBody({ query: 'x', site: 'https://evil.com/path' }));
  assert.equal(buildSearchBody({ query: 'x'.repeat(500) }).Query.length, 120);
});

test('TC3 签名与腾讯云官方样例的中间值一致（payload 哈希、规范请求哈希）', () => {
  const r = tc3Sign({
    secretId: 'AKIDEXAMPLE', secretKey: 'EXAMPLEKEY', service: 'cvm', host: 'cvm.tencentcloudapi.com', action: 'DescribeInstances',
    payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}', timestamp: 1551113065,
  });
  assert.equal(r.hashedPayload, '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064');
  assert.equal(r.hashedCanonicalRequest, '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84');
  assert.match(r.authorization, /^TC3-HMAC-SHA256 Credential=AKIDEXAMPLE\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
});

test('AK/SK 请求：固定官方域名、Action/Version/Timestamp 头齐全、日期用 UTC', () => {
  const now = () => Date.UTC(2026, 10, 9, 16, 30) ; // 北京时间 11-10 00:30 → UTC 仍是 11-09
  const { url, init } = buildAkSkRequest({ secretId: 'AKIDX', secretKey: 'K' }, { Query: 'q' }, { now });
  assert.equal(url, `https://${AKSK_HOST}/`);
  assert.equal(init.headers['X-TC-Action'], 'SearchPro');
  assert.equal(init.headers['X-TC-Version'], '2025-05-08');
  assert.match(init.headers.Authorization, /Credential=AKIDX\/2026-11-09\/wsa\/tc3_request/);
  assert.equal(init.headers['X-TC-Region'], undefined, 'SearchPro 不需要 Region');
  assert.equal(init.redirect, 'error');
  assert.throws(() => buildAkSkRequest({ secretId: 'AKIDX', secretKey: '' }, { Query: 'q' }), /同时填写/);
});

test('API Key 请求：Bearer 头，固定官方 URL', () => {
  const { url, init } = buildApiKeyRequest('k123', { Query: 'q' });
  assert.equal(url, API_KEY_ENDPOINT);
  assert.equal(init.headers.Authorization, 'Bearer k123');
  assert.throws(() => buildApiKeyRequest('', {}));
  assert.throws(() => buildApiKeyRequest('a\r\nX-Evil: 1', {}));
});

test('runSearch：认证失败不重试（只调用 1 次）', async () => {
  const f = mockFetch(() => errSearch('UnauthorizedOperation'));
  const r = await runSearch('api-key', { apiKey: 'bad' }, { query: 'q' }, { fetchImpl: f, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UnauthorizedOperation');
  assert.equal(f.calls.length, 1);
});

test('runSearch：限流最多退避重试 1 次', async () => {
  const f = mockFetch(() => errSearch('RequestLimitExceeded'));
  const r = await runSearch('api-key', { apiKey: 'k' }, { query: 'q' }, { fetchImpl: f, sleep: async () => {} });
  assert.equal(r.error.code, 'RequestLimitExceeded');
  assert.equal(f.calls.length, 2);
  const f2 = mockFetch((u, i, n) => (n === 1 ? errSearch('RequestLimitExceeded') : okSearch()));
  const r2 = await runSearch('api-key', { apiKey: 'k' }, { query: 'q' }, { fetchImpl: f2, sleep: async () => {} });
  assert.equal(r2.ok, true);
});

test('runSearch：网络错误 / 超时 / 缺凭据 给出可修复错误', async () => {
  const net = await runSearch('aksk', { secretId: 'AKID', secretKey: 'k' }, { query: 'q' }, { fetchImpl: mockFetch(() => new TypeError('fetch failed')) });
  assert.equal(net.error.code, 'NetworkError');
  const to = await runSearch('aksk', { secretId: 'AKID', secretKey: 'k' }, { query: 'q' }, { fetchImpl: mockFetch(() => Object.assign(new Error('t'), { name: 'TimeoutError' })) });
  assert.equal(to.error.code, 'Timeout');
  const miss = await runSearch('api-key', {}, { query: 'q' }, { fetchImpl: mockFetch(() => okSearch()) });
  assert.equal(miss.error.code, 'MissingCredentials');
  const bad = await runSearch('nope', {}, { query: 'q' });
  assert.equal(bad.error.code, 'InvalidMethod');
});

test('testConnection：只有真实成功（含 Pages + RequestId）才返回已连接；Mock 失败绝不显示成功', async () => {
  const ok = await testConnection('api-key', { apiKey: 'k' }, { fetchImpl: mockFetch(() => okSearch()) });
  assert.deepEqual([ok.ok, ok.message, ok.requestId], [true, '已连接（服务 API Key）', 'req-ok-1']);
  const okB = await testConnection('aksk', { secretId: 'AKID', secretKey: 'k' }, { fetchImpl: mockFetch(() => okSearch()) });
  assert.equal(okB.message, '已连接（腾讯云标准方式）');
  const fail = await testConnection('aksk', { secretId: 'AKID', secretKey: 'k' }, { fetchImpl: mockFetch(() => errSearch('AuthFailure.SignatureFailure')) });
  assert.equal(fail.ok, false);
  assert.equal(fail.code, 'AuthFailure.SignatureFailure');
  const http500 = await testConnection('api-key', { apiKey: 'k' }, { fetchImpl: mockFetch(() => ({ status: 500, text: 'oops' })) });
  assert.equal(http500.ok, false);
});
