// 教程保质期核验：保守判定，每条结论都带可点击来源；证据不足不武断宣称过期。
import { safeUrl, normalizeUrl } from './providers/wsa-response.mjs';
import { parseVersion, compareVersions, DOCS_INSTALL, RELEASES_PAGE } from './openclaw.mjs';
import { processResults } from './tutorial-discover.mjs';

export const MAX_INPUT = 6000;
export const STATUS_LABEL = {
  fresh: '仍可参考',
  'needs-review': '建议复核',
  outdated: '有明确过期证据',
  insufficient: '证据不足',
};

const TOOLS = [
  { key: 'openclaw', name: 'OpenClaw', re: /open\s?claw/i, tracked: true },
  { key: 'mcp', name: 'MCP', re: /\bmcp\b|model\s+context\s+protocol/i },
  { key: 'qwen-agent', name: 'Qwen Agent', re: /qwen[\s-]?agent/i },
  { key: 'dify', name: 'Dify', re: /\bdify\b/i },
  { key: 'langchain', name: 'LangChain', re: /langchain/i },
  { key: 'ollama', name: 'Ollama', re: /ollama/i },
  { key: 'claude-code', name: 'Claude Code', re: /claude\s?code/i },
];

// 命令区分大小写：避免把正文里的「OpenClaw」误识别为 openclaw 命令
const CMD_RE = /^(?:\$|>|#|PS>)?\s*((?:sudo\s+)?(?:npm|npx|pnpm|yarn|bun|curl|wget|pip3?|uv|docker|brew|git|iwr|irm|powershell)\s+\S[^\n]{0,160}|openclaw\s+[a-z][\w-]*[^\n]{0,140})$/;

export function parseTutorialInput(raw) {
  const text = typeof raw === 'string' ? raw.replace(/\r/g, '').trim() : '';
  if (!text) { const e = new Error('请粘贴教程链接或教程内容'); e.code = 'EmptyInput'; throw e; }
  const clipped = text.slice(0, MAX_INPUT);
  const single = /^\S+$/.test(clipped);
  if (single && /^[a-z][a-z0-9+.-]*:\/\//i.test(clipped) && !/^https?:\/\//i.test(clipped)) { const e = new Error('链接格式不正确，只支持 http(s)'); e.code = 'InvalidUrl'; throw e; }
  const kind = single && /^https?:\/\//i.test(clipped) ? 'url' : 'text';
  if (kind === 'url' && !safeUrl(clipped)) { const e = new Error('链接格式不正确，只支持 http(s)'); e.code = 'InvalidUrl'; throw e; }
  if (kind === 'text' && clipped.length < 4) { const e = new Error('内容太短，请粘贴教程关键步骤'); e.code = 'EmptyInput'; throw e; }
  return { kind, url: kind === 'url' ? safeUrl(clipped) : null, truncated: text.length > MAX_INPUT, ...extractFacts(clipped) };
}

export function extractFacts(text) {
  const tool = TOOLS.find((t) => t.re.test(text)) || null;
  const versions = [];
  for (const m of text.matchAll(/\bv?(20\d{2}\.\d{1,2}\.\d{1,3}(?:-(?:alpha|beta|rc)\.?\d*)?)\b/gi)) {
    if (parseVersion(m[1]) && !versions.includes(m[1])) versions.push(m[1]);
  }
  const otherVersions = [];
  for (const m of text.matchAll(/(?:version|版本|\bv)\s*[:：]?\s*(\d+\.\d+(?:\.\d+)?)\b/gi)) {
    if (!versions.some((v) => v.startsWith(m[1])) && !otherVersions.includes(m[1])) otherVersions.push(m[1]);
  }
  const commands = [];
  for (const line of text.split('\n')) {
    const m = line.trim().replace(/^`+|`+$/g, '').match(CMD_RE);
    if (m && commands.length < 8 && !commands.includes(m[1].trim())) commands.push(m[1].trim());
  }
  for (const m of text.matchAll(/`([^`\n]{3,160})`/g)) {
    const c = m[1].trim();
    if (CMD_RE.test(c) && commands.length < 8 && !commands.includes(c)) commands.push(c);
  }
  const dates = [];
  for (const m of text.matchAll(/(20\d{2})\s*([-/年])\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/g)) {
    const d = `${m[1]}-${m[3].padStart(2, '0')}-${m[4].padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(d)) && !dates.includes(d)) dates.push(d);
  }
  return { tool: tool ? { key: tool.key, name: tool.name, tracked: !!tool.tracked } : null, versions, otherVersions, commands, dates };
}

// 每次核验只发 1 次 SearchPro：链接模式查索引定位标题/日期；文本模式找官方文档与近期资料
export function buildCheckQuery(parsed) {
  if (parsed.kind === 'url') return parsed.url;
  if (parsed.tool) return `${parsed.tool.name} 最新版本 官方文档 安装`;
  const first = parsed.commands[0] || '';
  return `${first} 最新版本 官方文档`.trim();
}

function pickTutorialVersion(versions) {
  let best = null;
  for (const v of versions) {
    const p = parseVersion(v);
    if (!p) continue;
    if (!best || compareVersions(p, best) === 1) best = p;
  }
  return best;
}

const RISKY_RE = /no longer|removed|deprecat|renamed|replac|instead|breaking|must|need[s]? an? .*(upgrade|reinstall)|不再|移除|废弃|改名/i;

function commandTokens(cmd) {
  return cmd.toLowerCase().replace(/^sudo\s+/, '').split(/\s+/)
    .filter((w) => w.length >= 3 && !/^-/.test(w) && !['npm', 'npx', 'pnpm', 'yarn', 'install', 'curl', 'bash', 'http', 'https'].includes(w) && !/^https?:/.test(w));
}

export function checkTutorial({ parsed, openclaw = null, changelog = null, search = null, now = Date.now() }) {
  const limitations = [];
  const findings = [];
  const recommendedLinks = [];
  let status = 'insufficient';
  const reasons = [];
  let tutorialMeta = null;
  let facts = { ...parsed };

  // --- 搜索证据 ---
  const items = search && search.ok ? processResults(search) : [];
  if (!search) limitations.push('未连接元宝搜索：本次只比对 GitHub 官方 Release，未检索公开网页资料');
  else if (!search.ok) limitations.push(`元宝搜索请求失败（${search.error?.code || '未知'}），本次只比对官方 Release`);

  if (parsed.kind === 'url') {
    limitations.push('MVP 不抓取网页全文（避免越权抓取与版权问题）；粘贴教程关键安装步骤可显著提高判断准确度');
    const key = normalizeUrl(parsed.url);
    const hit = items.find((it) => normalizeUrl(it.url) === key);
    if (hit) {
      tutorialMeta = { title: hit.title, date: hit.date, site: hit.site, summary: hit.summary, url: hit.url };
      const more = extractFacts(`${hit.title} ${hit.summary || ''}`);
      facts = { ...facts, tool: facts.tool || more.tool, versions: [...facts.versions, ...more.versions], dates: hit.date ? [hit.date, ...facts.dates] : facts.dates };
    } else if (search && search.ok) {
      limitations.push('搜索索引中没有找到这条链接本身，无法读取它的标题和发布时间');
    }
    if (!facts.tool) {
      const fromUrl = extractFacts(decodeURIComponent(parsed.url).replace(/[-_/]/g, ' '));
      facts.tool = fromUrl.tool; facts.versions = [...facts.versions, ...fromUrl.versions];
    }
  }

  const tool = facts.tool;
  const tv = pickTutorialVersion(facts.versions);
  const tutorialDate = facts.dates.length ? [...facts.dates].sort()[0] : null;
  const latest = openclaw?.ok !== false ? openclaw?.latestStable || null : null;

  if (tool?.key === 'openclaw') {
    if (!latest) {
      limitations.push('暂时无法从 GitHub 获取 OpenClaw 官方稳定版，无法比对版本');
    } else {
      recommendedLinks.push({ label: `官方稳定版 ${latest.tag}`, url: latest.url, kind: 'release' });
      if (latest.notesUrl) recommendedLinks.push({ label: `${latest.tag} 发布说明`, url: latest.notesUrl, kind: 'docs' });
      recommendedLinks.push({ label: 'OpenClaw 官方安装文档', url: DOCS_INSTALL, kind: 'docs' });
      const releases = openclaw.releases || [];
      const stableAfter = (pred) => releases.filter((r) => !r.prerelease && r.version && pred(r));

      if (tv) {
        const cmp = compareVersions(tv, latest.version);
        if (cmp === 0) {
          status = 'fresh';
          reasons.push(`教程标注的版本 ${tv.raw} 与当前官方稳定版 ${latest.tag} 一致`);
          findings.push({ claim: `教程版本 ${tv.raw}`, change: '与 GitHub 最新稳定版一致，暂未发现版本差异', severity: 'low', sourceUrl: latest.url, sourceLabel: `GitHub Release ${latest.tag}` });
        } else if (cmp === 1) {
          status = 'needs-review';
          reasons.push(`教程版本 ${tv.raw} 比当前稳定版 ${latest.tag} 更新，可能基于预发布（beta）版本`);
          findings.push({ claim: `教程版本 ${tv.raw}`, change: '高于当前官方稳定版，可能是 beta 功能，正式环境请以稳定版为准', severity: 'medium', sourceUrl: latest.url, sourceLabel: `GitHub Release ${latest.tag}` });
        } else {
          const newer = stableAfter((r) => compareVersions(r.version, tv) === 1 && compareVersions(r.version, latest.version) <= 0);
          const inSample = releases.some((r) => compareVersions(r.version, tv) === 0);
          status = 'needs-review';
          reasons.push(inSample
            ? `教程版本 ${tv.raw} 之后，官方已发布 ${newer.length} 个稳定版（截至 ${latest.tag}）`
            : `教程版本 ${tv.raw} 早于查询到的最近 ${releases.length} 条发布记录；之后至少有 ${newer.length} 个稳定版`);
          findings.push({ claim: `教程版本 ${tv.raw}`, change: `当前官方稳定版为 ${latest.tag}，版本落后不等于步骤失效，需逐项复核`, severity: 'medium', sourceUrl: latest.url, sourceLabel: `GitHub Release ${latest.tag}` });
        }
      } else if (tutorialDate) {
        const after = stableAfter((r) => r.publishedAt && r.publishedAt.slice(0, 10) > tutorialDate);
        status = facts.commands.length ? 'needs-review' : 'insufficient';
        reasons.push(`教程未标注版本；${tutorialDate} 之后官方至少发布了 ${after.length} 个稳定版（仅统计最近 ${releases.length} 条记录）`);
      } else if (facts.commands.length) {
        status = 'needs-review';
        reasons.push('教程未标注适用版本，但包含安装 / 配置命令，建议对照官方最新文档复核');
      } else {
        reasons.push('没有识别到版本号、日期或命令，无法判断是否过期');
      }

      // 用官方 Changelog 比对教程命令
      if (changelog?.ok && status !== 'fresh') {
        const relevant = changelog.sections.filter((s) => ['breaking', 'install', 'update', 'config'].includes(s.key));
        let explicit = false;
        for (const cmd of facts.commands) {
          const toks = commandTokens(cmd);
          if (!toks.length) continue;
          for (const s of relevant) {
            const item = s.items.find((it) => toks.some((t) => it.text.toLowerCase().includes(t)));
            if (item) {
              const risky = RISKY_RE.test(item.text);
              if (risky && s.key !== 'other') explicit = explicit || /no longer|removed|deprecat|renamed|不再|移除|废弃|改名/i.test(item.text);
              findings.push({ claim: cmd, change: item.text, severity: risky ? 'high' : 'medium', sourceUrl: item.docUrl || item.prUrl || changelog.sourceUrl, sourceLabel: `${latest.tag} Changelog · ${s.title}` });
              break;
            }
          }
        }
        if (explicit) { status = 'outdated'; reasons.push('官方 Changelog 中有与教程命令直接相关的移除 / 废弃 / 改名记录'); }
        const install = changelog.impact?.find((x) => x.key === 'install');
        if (install && findings.length < 5) {
          findings.push({ claim: '安装 / 引导流程', change: `${latest.tag} 有 ${install.count} 条「${install.title}」变更，例如：${install.example}`, severity: 'medium', sourceUrl: install.docUrl || changelog.sourceUrl, sourceLabel: `${latest.tag} Changelog` });
        }
      }
      if (openclaw.latestBeta && openclaw.betaIsNewer) {
        reasons.push(`另有预发布版 ${openclaw.latestBeta.tag}（beta，非稳定版，不作为推荐版本）`);
      }
    }
  } else if (tool) {
    limitations.push(`CodeFresh 目前只对 OpenClaw 做官方 Release 比对；${tool.name} 的判断仅基于公开搜索结果`);
    const official = items.filter((i) => i.isOfficial);
    const newerDated = items.filter((i) => i.date && tutorialDate && i.date > tutorialDate);
    if (official.length && (newerDated.length || facts.commands.length)) {
      status = 'needs-review';
      reasons.push(`找到 ${official.length} 条官方来源${newerDated.length ? `，其中有比教程（${tutorialDate}）更新的资料` : ''}，建议对照复核`);
    } else {
      reasons.push('缺少可核验的官方版本记录，暂不判断是否过期');
    }
  } else {
    reasons.push('没有识别出教程对应的工具，请粘贴包含工具名、版本号或安装命令的段落');
  }

  for (const it of items.filter((i) => i.isOfficial).slice(0, 3)) {
    if (!recommendedLinks.some((l) => normalizeUrl(l.url) === normalizeUrl(it.url))) recommendedLinks.push({ label: it.title, url: it.url, kind: 'official-search' });
  }
  const relatedTutorials = items.filter((i) => !i.isOfficial && (!tutorialMeta || normalizeUrl(i.url) !== normalizeUrl(tutorialMeta.url))).slice(0, 4);

  return {
    status,
    statusLabel: STATUS_LABEL[status],
    tool: tool ? tool.name : null,
    inputKind: parsed.kind,
    tutorialVersion: tv ? tv.raw : (facts.otherVersions?.[0] || null),
    tutorialDate,
    tutorialMeta,
    commands: facts.commands,
    latestStable: latest ? { tag: latest.tag, publishedAt: latest.publishedAt, url: latest.url } : null,
    latestBeta: openclaw?.latestBeta && tool?.key === 'openclaw' ? { tag: openclaw.latestBeta.tag, url: openclaw.latestBeta.url } : null,
    checkedAt: new Date(now).toISOString(),
    reasons,
    findings: findings.slice(0, 6),
    recommendedLinks: recommendedLinks.slice(0, 6),
    relatedTutorials,
    evidence: search && search.ok ? { provider: search.provider || null, requestId: search.requestId || null, count: items.length } : null,
    limitations,
    isDemo: false,
  };
}

// 示例报告（只在页面上作为「示例数据」展示，绝不冒充真实结果）
export const DEMO_REPORT = Object.freeze({
  isDemo: true,
  status: 'needs-review',
  statusLabel: '需要更新',
  freshnessScoreDemo: 38,
  tool: 'OpenClaw',
  tutorialVersion: '旧版',
  latestStableLabel: '新版',
  steps: [
    { n: '01', title: '发现变更', text: '安装流程已更新' },
    { n: '02', title: '推荐替代', text: '查看最新安装方式' },
    { n: '03', title: '核验来源', text: '官方文档与更新日志' },
  ],
});

export const RELEASES_LINK = RELEASES_PAGE;
