import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscoverParams, dedupeItems, processResults, isOfficialUrl } from '../src/tutorial-discover.mjs';

test('筛选参数：近期用 Freshness，CSDN 专区用 Site=blog.csdn.net', () => {
  assert.deepEqual(buildDiscoverParams('MCP'), { query: 'MCP', freshness: null, site: null });
  assert.deepEqual(buildDiscoverParams('MCP', { filter: 'recent' }), { query: 'MCP', freshness: 'd30', site: null });
  assert.deepEqual(buildDiscoverParams('MCP', { filter: 'new', csdnOnly: true }), { query: 'MCP', freshness: 'd7', site: 'blog.csdn.net' });
  assert.equal(buildDiscoverParams('MCP', { filter: 'official' }).query, 'MCP 官方文档');
  assert.throws(() => buildDiscoverParams('  '), /关键词/);
});

test('按规范化 URL 去重', () => {
  const items = dedupeItems([{ url: 'https://docs.openclaw.ai/x?utm_source=openai' }, { url: 'https://docs.openclaw.ai/x' }, { url: 'https://www.docs.openclaw.ai/x/' }, { url: 'https://a.com' }]);
  assert.equal(items.length, 2);
});

test('只有真实 CSDN 域名才标 CSDN；无日期/域名显示未知而不伪装', () => {
  const r = processResults({ items: [
    { title: 'a', url: 'https://blog.csdn.net/x', site: null, date: null },
    { title: 'b', url: 'https://zhihu.com/x', site: 'CSDN', date: '2026-10-01' },
    { title: 'c', url: 'https://docs.openclaw.ai/install', site: null, date: '2026-11-01' },
  ] }, { sort: 'date' });
  assert.equal(r.find((x) => x.title === 'a').isCsdn, true);
  assert.equal(r.find((x) => x.title === 'b').isCsdn, false);
  assert.equal(r.find((x) => x.title === 'c').isOfficial, true);
  assert.deepEqual(r.map((x) => x.title), ['c', 'b', 'a'], '无日期排最后');
});

test('官方来源识别', () => {
  assert.equal(isOfficialUrl('https://github.com/openclaw/openclaw/releases'), true);
  assert.equal(isOfficialUrl('https://github.com/someone/openclaw-fork'), false);
  assert.equal(isOfficialUrl('https://docs.openclaw.ai.evil.com/'), false);
});
