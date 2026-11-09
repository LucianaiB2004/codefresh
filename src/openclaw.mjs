// OpenClaw 版本雷达：GitHub 官方 Releases（openclaw/openclaw）
// - 稳定版来自 /releases/latest（GitHub 已排除 draft 与 prerelease）
// - 列表来自 /releases?per_page=20，按 prerelease / draft 区分稳定版与 beta
// - 日期式版本号（2026.11.2 / 2026.10.10-beta.5），不按普通 semver 硬比较
// 浏览器 / Node 通用，fetchImpl 可注入便于测试。

export const REPO = 'openclaw/openclaw';
export const GH_API = 'https://api.github.com';
export const LATEST_URL = `${GH_API}/repos/${REPO}/releases/latest`;
export const LIST_URL = `${GH_API}/repos/${REPO}/releases?per_page=20`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
export const DOCS_INSTALL = 'https://docs.openclaw.ai/install';
export const DOCS_HOME = 'https://docs.openclaw.ai/';
export const CACHE_TTL_MS = 15 * 60 * 1000;

const VERSION_RE = /^v?(\d{4})\.(\d{1,2})\.(\d{1,3})(?:-(alpha|beta|rc)\.?(\d+)?)?$/i;

export function parseVersion(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().match(VERSION_RE);
  if (!m) return null;
  return {
    raw: tag.trim(),
    core: `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`,
    year: Number(m[1]), month: Number(m[2]), patch: Number(m[3]),
    pre: m[4] ? m[4].toLowerCase() : null,
    preNum: m[5] ? Number(m[5]) : null,
  };
}

// 仅用于「同为日期式版本号」时的大致比较；返回 null 表示无法比较
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) return null;
  for (const k of ['year', 'month', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1; // 正式版 > 同号预发布
  if (!y.pre) return -1;
  return (x.preNum ?? 0) === (y.preNum ?? 0) ? 0 : (x.preNum ?? 0) < (y.preNum ?? 0) ? -1 : 1;
}

function stripMd(s) {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '').replace(/\(#\d+(?:,\s*#\d+)*[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

export function summarizeBody(body) {
  const text = typeof body === 'string' ? body : '';
  const statsMatch = text.match(/(\d+)\s+commits?\s+·\s+(\d+)\s+pull requests?\s+·\s+(\d+)\s+contributors?/i);
  const notes = text.match(/https:\/\/docs\.openclaw\.ai\/releases\/[0-9a-z.\-]+/i);
  const highlights = [];
  const hl = text.split(/\n#{2,4}\s*Highlights\s*\n/i)[1];
  if (hl) {
    for (const line of hl.split('\n')) {
      if (/^#{2,4}\s/.test(line)) break;
      const m = line.match(/^\s*[-*]\s+(.*)$/);
      if (m) {
        const t = stripMd(m[1]);
        const parts = t.match(/^([^:：]{2,60})[:：]\s*(.*)$/);
        highlights.push(parts ? { title: parts[1], text: parts[2].replace(/\s*(Thanks|Authored by)\b.*$/i, '').trim() } : { title: null, text: t });
      }
      if (highlights.length >= 6) break;
    }
  }
  return {
    stats: statsMatch ? { commits: Number(statsMatch[1]), pullRequests: Number(statsMatch[2]), contributors: Number(statsMatch[3]) } : null,
    notesUrl: notes ? notes[0] : null,
    highlights,
  };
}

export function toRelease(r) {
  if (!r || typeof r !== 'object' || typeof r.tag_name !== 'string') return null;
  const html = typeof r.html_url === 'string' && r.html_url.startsWith(`https://github.com/${REPO}/`) ? r.html_url : RELEASES_PAGE;
  return {
    tag: r.tag_name,
    name: typeof r.name === 'string' && r.name ? r.name : r.tag_name,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    url: html,
    prerelease: r.prerelease === true,
    draft: r.draft === true,
    version: parseVersion(r.tag_name),
    ...summarizeBody(r.body),
  };
}

export function processReleases({ latest, list, now = Date.now() }) {
  const releases = (Array.isArray(list) ? list : []).map(toRelease).filter((r) => r && !r.draft);
  releases.sort((a, b) => (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0));
  let latestStable = latest ? toRelease(latest) : null;
  if (latestStable && (latestStable.prerelease || latestStable.draft)) latestStable = null; // 防御：绝不把 beta 当稳定版
  const latestBeta = releases.find((r) => r.prerelease) || null;
  const stableList = releases.filter((r) => !r.prerelease);
  const betaList = releases.filter((r) => r.prerelease);
  const windows = {};
  for (const d of [7, 30, 90]) windows[d] = countInWindow(releases, d, now);
  const oldest = releases.length ? releases[releases.length - 1].publishedAt : null;
  return {
    repo: REPO,
    latestStable,
    latestBeta,
    betaIsNewer: !!(latestBeta && latestStable && compareVersions(latestBeta.version, latestStable.version) === 1),
    releases,
    stableCount: stableList.length,
    betaCount: betaList.length,
    windows,
    sampleSize: releases.length,
    oldestInSample: oldest,
    // 只统计查询到的最近 20 条发布记录；若窗口早于样本最早一条，则数字可能偏少
    windowCoverage: Object.fromEntries([7, 30, 90].map((d) => [d, !!oldest && Date.parse(oldest) <= now - d * 86400000])),
  };
}

export function countInWindow(releases, days, now = Date.now()) {
  const since = now - days * 86400000;
  let stable = 0; let beta = 0;
  for (const r of releases) {
    const t = Date.parse(r.publishedAt || '');
    if (!Number.isFinite(t) || t < since) continue;
    if (r.prerelease) beta++; else stable++;
  }
  return { stable, beta };
}

// ---- Changelog（官方仓库 CHANGELOG/<version>.md，只解析固定地址） ----
export function changelogUrl(tag) {
  const v = parseVersion(tag);
  if (!v) return null;
  const ver = v.pre ? `${v.core}-${v.pre}.${v.preNum ?? ''}`.replace(/\.$/, '') : v.core;
  return `https://raw.githubusercontent.com/${REPO}/main/CHANGELOG/${ver}.md`;
}

const CATEGORY_RULES = [
  { key: 'breaking', label: '破坏性变更', level: 'high', re: /breaking|removed|deprecat/i },
  { key: 'install', label: '安装与引导', level: 'high', re: /install|onboard|setup/i },
  { key: 'update', label: '更新与维护', level: 'high', re: /update|upgrad|maintenance|migrat/i },
  { key: 'security', label: '安全与隐私', level: 'medium', re: /security|privacy/i },
  { key: 'config', label: '配置与设置', level: 'medium', re: /config|setting/i },
  { key: 'model', label: '模型与提供方', level: 'medium', re: /model|provider/i },
];

export function categorize(title) {
  for (const r of CATEGORY_RULES) if (r.re.test(title)) return { key: r.key, label: r.label, level: r.level };
  return { key: 'other', label: title, level: 'low' };
}

export function parseChangelog(md) {
  if (typeof md !== 'string') return { intro: null, sections: [] };
  const lines = md.split('\n');
  const sections = [];
  let cur = null; let intro = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^#{3,4}\s+(.+?)\s*$/);
    if (h && !/^v?\d{4}\.\d/.test(h[1])) { cur = { title: h[1], ...categorize(h[1]), items: [] }; sections.push(cur); continue; }
    if (!cur && !intro && /^[A-Z][^#\n]{40,}/.test(line) && !/release notes|docs site/i.test(line)) intro = stripMd(line);
    const it = line.match(/^-\s+(.+)$/);
    if (it && cur) {
      // 续行（下一行缩进的链接行）
      let text = it[1];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) text += ' ' + lines[++i].trim();
      const docLink = text.match(/https:\/\/docs\.openclaw\.ai\/[^\s)]+/);
      const prLink = text.match(/https:\/\/github\.com\/openclaw\/openclaw\/(?:pull|issues)\/\d+/);
      const clean = stripMd(text).replace(/\s*Thanks to .*$/i, '').replace(/\s*\.?\s*See the .*$/i, '.').replace(/\s*#\d+(,\s*#\d+)*\.?/g, '').trim();
      cur.items.push({ text: clean, docUrl: docLink ? docLink[0] : null, prUrl: prLink ? prLink[0] : null });
    }
  }
  return { intro, sections: sections.filter((s) => s.items.length) };
}

export function impactSummary(parsed, limit = 5) {
  const rank = { breaking: 0, install: 1, update: 2, config: 3, security: 4, model: 5, other: 6 };
  return [...(parsed?.sections || [])]
    .sort((a, b) => rank[a.key] - rank[b.key] || b.items.length - a.items.length)
    .slice(0, limit)
    .map((s) => ({ title: s.title, label: s.label, key: s.key, level: s.level, count: s.items.length, example: s.items[0]?.text || null, docUrl: s.items.find((x) => x.docUrl)?.docUrl || null }));
}

// ---- 带短期缓存的客户端 ----
export function createOpenClawClient({ fetchImpl = fetch, now = () => Date.now(), ttlMs = CACHE_TTL_MS, timeoutMs = 12000 } = {}) {
  let cache = null; // { data, fetchedAt }
  let lastError = null;
  const clCache = new Map();

  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const remaining = res.headers?.get?.('x-ratelimit-remaining');
      const err = new Error(res.status === 403 || res.status === 429
        ? (remaining === '0' ? 'GitHub API 未认证调用已达到限速，请稍后再试' : `GitHub API 拒绝访问（HTTP ${res.status}）`)
        : `GitHub API 返回 HTTP ${res.status}`);
      err.code = res.status === 403 || res.status === 429 ? 'GitHubRateLimited' : `HTTP${res.status}`;
      throw err;
    }
    return res.json();
  }

  async function getReleases({ force = false } = {}) {
    const t = now();
    if (!force && cache && t - cache.fetchedAt < ttlMs) return { ok: true, cached: true, fetchedAt: new Date(cache.fetchedAt).toISOString(), ...cache.data };
    try {
      const [latest, list] = await Promise.all([getJson(LATEST_URL), getJson(LIST_URL)]);
      const data = processReleases({ latest, list, now: t });
      cache = { data, fetchedAt: t };
      lastError = null;
      return { ok: true, cached: false, fetchedAt: new Date(t).toISOString(), ...data };
    } catch (e) {
      lastError = { code: e.code || (e.name === 'TimeoutError' ? 'Timeout' : 'NetworkError'), message: e.code ? e.message : (e.name === 'TimeoutError' ? 'GitHub API 请求超时' : '无法连接 GitHub API'), at: new Date(t).toISOString() };
      if (cache) return { ok: true, cached: true, stale: true, error: lastError, fetchedAt: new Date(cache.fetchedAt).toISOString(), ...cache.data };
      return { ok: false, error: lastError, lastSuccessAt: null };
    }
  }

  async function getChangelog(tag) {
    const url = changelogUrl(tag);
    if (!url) return { ok: false, error: { code: 'InvalidVersion', message: '版本号格式无法识别' } };
    const hit = clCache.get(url);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, url, error: { code: `HTTP${res.status}`, message: '该版本没有可读取的 Changelog 文件' } };
      const md = await res.text();
      const parsed = parseChangelog(md.slice(0, 400000));
      const value = { ok: true, url, sourceUrl: `https://github.com/${REPO}/blob/main/CHANGELOG/${url.split('/').pop()}`, intro: parsed.intro, sections: parsed.sections.map((s) => ({ title: s.title, label: s.label, key: s.key, level: s.level, items: s.items.slice(0, 40) })), impact: impactSummary(parsed) };
      clCache.set(url, { at: now(), value });
      return value;
    } catch (e) {
      return { ok: false, url, error: { code: e.name === 'TimeoutError' ? 'Timeout' : 'NetworkError', message: '无法读取官方 Changelog' } };
    }
  }

  return { getReleases, getChangelog, get lastError() { return lastError; } };
}
