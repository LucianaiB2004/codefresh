import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, processReleases, parseChangelog, impactSummary, createOpenClawClient, changelogUrl, LATEST_URL } from '../src/openclaw.mjs';
import { mockFetch } from './helpers.mjs';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const rel = (tag, date, pre = false, extra = {}) => ({ tag_name: tag, name: tag, published_at: date, prerelease: pre, draft: false, html_url: `https://github.com/openclaw/openclaw/releases/tag/${tag}`, body: '', ...extra });
const LIST = [
  rel('v2026.11.2', '2026-11-08T19:31:04Z'),
  rel('v2026.11.5-beta.1', '2026-11-04T04:51:56Z', true, { body: '## x\n\n### Highlights\n\n- **Knowledge Scribes:** add capture. (#1) Thanks @a.\n- plain item\n' }),
  rel('v2026.11.1', '2026-11-05T09:48:37Z'),
  rel('v2026.9.36', '2026-10-29T20:19:38Z'),
  rel('v2026.10.0-draft', '2026-10-01T00:00:00Z', false, { draft: true }),
  rel('v2026.8.1', '2026-07-01T00:00:00Z'),
];

test('日期式版本号解析与比较（不按普通 semver 硬比较）', () => {
  assert.deepEqual(parseVersion('v2026.10.10-beta.5'), { raw: 'v2026.10.10-beta.5', core: '2026.10.10', year: 2026, month: 10, patch: 10, pre: 'beta', preNum: 5 });
  assert.equal(compareVersions('v2026.10.10', 'v2026.9.36'), 1);
  assert.equal(compareVersions('v2026.10.10-beta.5', 'v2026.10.10'), -1);
  assert.equal(compareVersions('2026.11.2', 'v2026.11.2'), 0);
  assert.equal(compareVersions('1.2.3', 'v2026.1.1'), null);
});

test('最新稳定版与 beta 分开显示，草稿被排除，按发布时间排序', () => {
  const r = processReleases({ latest: LIST[0], list: LIST, now: NOW });
  assert.equal(r.latestStable.tag, 'v2026.11.2');
  assert.equal(r.latestBeta.tag, 'v2026.11.5-beta.1');
  assert.equal(r.betaIsNewer, true);
  assert.equal(r.releases.some((x) => x.draft), false);
  assert.equal(r.releases[0].tag, 'v2026.11.2');
  assert.equal(r.releases[1].tag, 'v2026.11.1');
  assert.deepEqual(r.windows[7], { stable: 2, beta: 1 });
  assert.deepEqual(r.windows[30], { stable: 3, beta: 1 });
  assert.equal(r.windowCoverage[90], true);
  assert.equal(r.latestBeta.highlights[0].title, 'Knowledge Scribes');
});

test('防御：latest 接口若返回预发布，绝不当作稳定版', () => {
  const r = processReleases({ latest: LIST[1], list: LIST, now: NOW });
  assert.equal(r.latestStable, null);
});

test('Changelog 解析：章节归类、条目、文档链接', () => {
  const md = '## 2026.11.2\n\n### v2026.11.2\n\nThis is a patch release with no new features. It fixes problems that could stop updates.\n\n#### Installation and Onboarding\n\n- Fixes global installation with Bun 1.4.4.\n  [#1](https://github.com/openclaw/openclaw/pull/1). Thanks to [@a](https://github.com/a). See the [installation guide](https://docs.openclaw.ai/install/).\n- The `openclaw setup` command was removed; use `openclaw onboard` instead.\n\n#### Messaging\n\n- Fixes chat.\n';
  const p = parseChangelog(md);
  assert.equal(p.sections.length, 2);
  assert.equal(p.sections[0].key, 'install');
  assert.equal(p.sections[0].items[0].docUrl, 'https://docs.openclaw.ai/install/');
  assert.equal(p.sections[0].items[0].text, 'Fixes global installation with Bun 1.4.4.');
  assert.match(p.intro, /patch release/);
  const imp = impactSummary(p);
  assert.equal(imp[0].key, 'install');
  assert.equal(imp[0].count, 2);
});

test('changelogUrl 只生成官方固定地址', () => {
  assert.equal(changelogUrl('v2026.11.2'), 'https://raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG/2026.11.2.md');
  assert.equal(changelogUrl('../../etc/passwd'), null);
});

test('GitHub 403 限速：有缓存时用短期缓存兜底并提示；无缓存时明确失败，不猜版本', async () => {
  let fail = false;
  let t = NOW;
  const f = mockFetch((url) => {
    if (fail) return { status: 403, json: { message: 'rate limit' }, headers: { 'x-ratelimit-remaining': '0' } };
    return { status: 200, json: url === LATEST_URL ? LIST[0] : LIST };
  });
  const c = createOpenClawClient({ fetchImpl: f, now: () => t, ttlMs: 1000 });
  const a = await c.getReleases();
  assert.equal(a.ok, true); assert.equal(a.cached, false);
  const b = await c.getReleases();
  assert.equal(b.cached, true); assert.equal(f.calls.length, 2, '缓存期内不重复请求');
  fail = true; t += 5000;
  const s = await c.getReleases();
  assert.equal(s.ok, true); assert.equal(s.stale, true); assert.equal(s.error.code, 'GitHubRateLimited');
  assert.equal(s.latestStable.tag, 'v2026.11.2');
  const c2 = createOpenClawClient({ fetchImpl: mockFetch(() => new TypeError('offline')), now: () => t });
  const n = await c2.getReleases();
  assert.equal(n.ok, false); assert.equal(n.error.code, 'NetworkError'); assert.equal(n.latestStable, undefined);
});

test('GitHub 超时 → Timeout 错误', async () => {
  const c = createOpenClawClient({ fetchImpl: mockFetch(() => Object.assign(new Error('t'), { name: 'TimeoutError' })) });
  const r = await c.getReleases();
  assert.equal(r.error.code, 'Timeout');
});
