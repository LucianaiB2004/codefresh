import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTutorialInput, checkTutorial, buildCheckQuery, DEMO_REPORT } from '../src/tutorial-check.mjs';
import { processReleases } from '../src/openclaw.mjs';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const rel = (tag, date, pre = false) => ({ tag_name: tag, published_at: date, prerelease: pre, draft: false, html_url: `https://github.com/openclaw/openclaw/releases/tag/${tag}`, body: '' });
const LIST = [rel('v2026.11.2', '2026-11-08T19:31:04Z'), rel('v2026.11.5-beta.1', '2026-11-04T04:51:56Z', true), rel('v2026.11.1', '2026-11-05T09:48:37Z'), rel('v2026.10.10', '2026-11-03T03:22:35Z'), rel('v2026.10.5', '2026-10-18T21:47:25Z')];
const OC = { ok: true, ...processReleases({ latest: LIST[0], list: LIST, now: NOW }) };
const CL = {
  ok: true, sourceUrl: 'https://github.com/openclaw/openclaw/blob/main/CHANGELOG/2026.11.2.md',
  sections: [{ title: 'Installation and Onboarding', key: 'install', level: 'high', items: [{ text: 'The setup-wizard command was removed; use onboard instead.', docUrl: 'https://docs.openclaw.ai/install/', prUrl: null }, { text: 'Fixes global installation with Bun.', docUrl: null, prUrl: null }] }],
  impact: [{ key: 'install', title: 'Installation and Onboarding', count: 2, example: 'Fixes global installation with Bun.', docUrl: 'https://docs.openclaw.ai/install/' }],
};

test('输入校验：空输入、非法链接、过短内容', () => {
  assert.throws(() => parseTutorialInput('   '), /请粘贴/);
  assert.throws(() => parseTutorialInput('ftp://x.com/a'), /http/i);
  assert.equal(parseTutorialInput('https://blog.csdn.net/a/article/details/1').kind, 'url');
  assert.equal(parseTutorialInput('npm install -g openclaw').kind, 'text');
});

test('提取工具、日期式版本、命令、日期', () => {
  const p = parseTutorialInput('OpenClaw 教程 v2026.10.5 发布于 2026年10月20日\n$ npm install -g openclaw@2026.10.5\n`openclaw onboard --install-daemon`');
  assert.equal(p.tool.name, 'OpenClaw');
  assert.deepEqual(p.versions, ['2026.10.5']);
  assert.ok(p.commands.includes('npm install -g openclaw@2026.10.5'));
  assert.ok(p.commands.includes('openclaw onboard --install-daemon'));
  assert.deepEqual(p.dates, ['2026-10-20']);
  assert.equal(buildCheckQuery(p), 'OpenClaw 最新版本 官方文档 安装');
});

test('旧教程无版本号、无命令 → 证据不足，不宣称过期', () => {
  const r = checkTutorial({ parsed: parseTutorialInput('OpenClaw 很好用，推荐大家学习'), openclaw: OC, changelog: CL, now: NOW });
  assert.equal(r.status, 'insufficient');
  assert.equal(r.isDemo, false);
});

test('无版本号但有安装命令 → 建议复核', () => {
  const r = checkTutorial({ parsed: parseTutorialInput('OpenClaw 安装\nnpm install -g openclaw'), openclaw: OC, changelog: CL, now: NOW });
  assert.equal(r.status, 'needs-review');
});

test('版本与最新稳定版一致 → 仍可参考', () => {
  const r = checkTutorial({ parsed: parseTutorialInput('OpenClaw v2026.11.2 安装'), openclaw: OC, changelog: CL, now: NOW });
  assert.equal(r.status, 'fresh');
  assert.equal(r.latestStable.tag, 'v2026.11.2');
});

test('版本较旧本身不足以宣称过期 → 建议复核，并给出官方来源', () => {
  const r = checkTutorial({ parsed: parseTutorialInput('OpenClaw v2026.10.5 安装\nnpm install -g openclaw@2026.10.5'), openclaw: OC, changelog: CL, now: NOW });
  assert.equal(r.status, 'needs-review');
  assert.match(r.reasons[0], /已发布 3 个稳定版/);
  assert.ok(r.findings.every((f) => /^https:\/\//.test(f.sourceUrl)), '每条结论都有可点击来源');
  assert.ok(r.recommendedLinks.some((l) => l.url === 'https://docs.openclaw.ai/install'));
});

test('教程命令在官方 Changelog 中被明确移除 → 有明确过期证据', () => {
  const r = checkTutorial({ parsed: parseTutorialInput('OpenClaw v2026.10.5\nopenclaw setup-wizard'), openclaw: OC, changelog: CL, now: NOW });
  assert.equal(r.status, 'outdated');
  assert.ok(r.findings.some((f) => f.severity === 'high' && f.sourceUrl === 'https://docs.openclaw.ai/install/'));
});

test('beta 版本不被当作推荐版本', () => {
  const r = checkTutorial({ parsed: parseTutorialInput('OpenClaw v2026.11.5-beta.1'), openclaw: OC, changelog: CL, now: NOW });
  assert.equal(r.status, 'needs-review');
  assert.equal(r.latestStable.tag, 'v2026.11.2');
});

test('GitHub 不可用时：不猜版本', () => {
  const r = checkTutorial({ parsed: parseTutorialInput('OpenClaw v2026.10.5'), openclaw: { ok: false }, now: NOW });
  assert.equal(r.latestStable, null);
  assert.equal(r.status, 'insufficient');
  assert.ok(r.limitations.some((l) => /无法从 GitHub/.test(l)));
});

test('链接模式：从搜索索引定位原文标题/日期，并说明不抓取全文', () => {
  const url = 'https://blog.csdn.net/u/article/details/123';
  const search = { ok: true, provider: 'api-key', requestId: 'r', items: [
    { title: 'OpenClaw v2026.10.5 安装教程', url, site: 'CSDN博客', domain: 'blog.csdn.net', date: '2026-10-20', summary: 'npm install' },
    { title: 'OpenClaw docs', url: 'https://docs.openclaw.ai/start/getting-started', site: 'docs', domain: 'docs.openclaw.ai', date: null, summary: null },
    { title: '另一篇', url: 'https://zhihu.com/p/1', site: '知乎', domain: 'zhihu.com', date: null, summary: null },
  ] };
  const p = parseTutorialInput(url);
  assert.equal(buildCheckQuery(p), url);
  const r = checkTutorial({ parsed: p, openclaw: OC, changelog: CL, search, now: NOW });
  assert.equal(r.tutorialMeta.title, 'OpenClaw v2026.10.5 安装教程');
  assert.equal(r.tutorialVersion, '2026.10.5');
  assert.ok(r.limitations.some((l) => /不抓取网页全文/.test(l)));
  assert.ok(r.recommendedLinks.some((l) => l.kind === 'official-search'));
  assert.equal(r.relatedTutorials.length, 1);
  assert.equal(r.relatedTutorials[0].isCsdn, false);
  assert.equal(r.evidence.count, 3);
});

test('非 OpenClaw 工具永远不会给出「明确过期」', () => {
  const r = checkTutorial({ parsed: parseTutorialInput('MCP 教程 2024-01-01\nnpx @modelcontextprotocol/inspector'), openclaw: OC, search: null, now: NOW });
  assert.notEqual(r.status, 'outdated');
  assert.ok(r.limitations.some((l) => /只对 OpenClaw/.test(l)));
});

test('示例报告明确标记 isDemo，38% 只出现在示例中', () => {
  assert.equal(DEMO_REPORT.isDemo, true);
  assert.equal(DEMO_REPORT.freshnessScoreDemo, 38);
  const r = checkTutorial({ parsed: parseTutorialInput('OpenClaw v2026.10.5'), openclaw: OC, changelog: CL, now: NOW });
  assert.equal('freshnessScoreDemo' in r, false);
});
