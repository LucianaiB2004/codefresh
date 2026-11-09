// CodeFresh 前端：标签切换、表单、连接状态、渲染。凭据只在内存中（conn 对象），从不持久化。
import { createConnectionManager, STATUS } from './lib/credentials.mjs';
import { createOpenClawClient, DOCS_INSTALL, RELEASES_PAGE } from './lib/openclaw.mjs';
import { parseTutorialInput, buildCheckQuery, checkTutorial, DEMO_REPORT } from './lib/tutorial-check.mjs';
import { buildDiscoverParams, processResults } from './lib/tutorial-discover.mjs';
import { safeUrl, isAuthError } from './lib/providers/wsa-response.mjs';
import { buildSearchBody, CONNECTION_TEST_QUERY } from './lib/providers/request.mjs';

// 中转服务地址（GitHub Pages 构建时写入 config.js；本地模式不使用）
function normalizeRelay(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const u = new URL(raw.trim());
    const loop = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) return '';
    return u.toString().replace(/\/+$/, '');
  } catch { return ''; }
}
const RELAY = normalizeRelay(globalThis.CODEFRESH_RELAY);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const A = './assets/codefresh/';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ext = (url, inner, cls = '') => { const u = safeUrl(url); return u ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner; };
const icon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const TZ = 'Asia/Shanghai';
const fmtDay = (iso) => { if (!iso) return '未知'; const d = new Date(iso); return Number.isNaN(+d) ? '未知' : d.toLocaleDateString('zh-CN', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-'); };
const fmtShort = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '未知' : d.toLocaleDateString('zh-CN', { timeZone: TZ, month: '2-digit', day: '2-digit' }).replace(/\//g, '-'); };
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const shortId = (id) => (id ? `${String(id).slice(0, 8)}…` : '');

const state = {
  mode: 'detecting', // local | pages（pages + RELAY 时通过中转服务调用元宝搜索）
  envCreds: { 'api-key': false, aksk: false },
  view: 'check',
  inputTab: 'url',
  releases: null, releasesLoading: true, changelog: null,
  check: { phase: 'demo', report: null, error: null, steps: [] },
  reports: [],
  windowDays: 30,
  explore: { filter: 'all', csdnOnly: false, sort: 'relevance', phase: 'idle', result: null, error: null, query: '' },
};

// ---------------- API 层 ----------------
const gh = createOpenClawClient();
const METHOD_NAME = { 'api-key': '服务 API Key', aksk: '腾讯云标准方式' };
// 能否调用元宝搜索：本地模式，或 Pages 且配置了中转服务
const canSearch = () => state.mode === 'local' || (state.mode === 'pages' && !!RELAY);
const viaRelay = () => state.mode === 'pages' && !!RELAY;

// 经中转服务调用：浏览器只构造 Query/Site/Freshness，签名在中转服务端完成；凭据只放在本次请求体里
async function relaySearch(method, creds, params) {
  let body;
  try { body = buildSearchBody(params); } catch (e) { return { ok: false, code: e.code || 'InvalidParameter', message: e.message }; }
  const payload = method === 'api-key'
    ? { apiKey: creds?.apiKey || '', body }
    : { secretId: creds?.secretId || '', secretKey: creds?.secretKey || '', body };
  const path = method === 'api-key' ? '/api/wsa/search' : '/api/wsa/tc3';
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      const res = await fetch(RELAY + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000) });
      r = await res.json().catch(() => ({ ok: false, code: `HTTP${res.status}`, message: `中转服务返回 HTTP ${res.status}` }));
    } catch (e) {
      r = { ok: false, code: 'RelayUnreachable', message: e?.name === 'TimeoutError' ? '中转服务响应超时' : '无法连接中转服务，请稍后再试' };
    }
    if (!r.ok && r.code === 'RequestLimitExceeded' && attempt === 0) { await new Promise((ok) => setTimeout(ok, 1200)); continue; }
    return r;
  }
}
async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  return res.json();
}
const api = {
  async health() {
    if (RELAY || /\.github\.io$/.test(location.hostname)) return null; // Pages 构建（含中转配置）没有本地 /api
    try {
      const res = await fetch('./api/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      const j = await res.json();
      return j && j.mode === 'local' ? j : null;
    } catch { return null; }
  },
  async test(method, credentials) {
    if (viaRelay()) {
      const r = await relaySearch(method, credentials, { query: CONNECTION_TEST_QUERY });
      return r.ok ? { ok: true, method, requestId: r.requestId, message: `已连接（${METHOD_NAME[method]} · 经中转）` } : { ok: false, method, code: r.code, message: r.message, requestId: r.requestId || null };
    }
    if (state.mode !== 'local') return { ok: false, code: 'PagesMode', message: 'GitHub Pages 预览无法调用元宝搜索（跨域被拒），请本地运行 npm start' };
    return postJson('./api/connection-test', { method, credentials });
  },
  search(method, credentials, params) {
    if (viaRelay()) return relaySearch(method, credentials, params);
    return postJson('./api/search', { method, credentials, ...params });
  },
  async releases(force = false) {
    if (state.mode === 'local') { const r = await fetch(`./api/openclaw/releases${force ? '?force=1' : ''}`, { cache: 'no-store' }); return r.json(); }
    return gh.getReleases({ force });
  },
  async changelog(tag) {
    if (state.mode === 'local') { const r = await fetch(`./api/openclaw/changelog?tag=${encodeURIComponent(tag)}`, { cache: 'no-store' }); return r.json(); }
    return gh.getChangelog(tag);
  },
};

const conn = createConnectionManager({ testFn: (m, c) => api.test(m, c).catch(() => ({ ok: false, code: 'NetworkError', message: '无法连接本地服务' })), onChange: renderConn });

async function doSearch(params) {
  const method = conn.active;
  if (!method) return { ok: false, code: 'NotConnected', message: '尚未连接元宝搜索' };
  let r;
  try { r = await api.search(method, conn.credentialsFor(method), params); } catch { r = { ok: false, code: 'NetworkError', message: '无法连接本地服务' }; }
  if (!r.ok && isAuthError(r.code)) {
    conn.reportAuthFailure(method, { code: r.code, message: r.message, requestId: r.requestId });
    toast('当前凭据认证失败，已断开。可在「API 设置」里测试另一种方式。');
  }
  return r;
}

// ---------------- 通用 ----------------
let toastTimer;
function toast(msg) { const t = $('[data-toast]'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3600); }

function setView(v, { push = true } = {}) {
  if (!['check', 'radar', 'explore', 'guide'].includes(v)) v = 'check';
  state.view = v;
  $$('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== v; });
  $$('[data-nav]').forEach((el) => { if (el.dataset.nav === v && (el.classList.contains('nav-item') || el.closest('.bottom-nav'))) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  if (push && location.hash !== `#${v}`) history.replaceState(null, '', `#${v}`);
  if (window.matchMedia('(max-width: 1000px)').matches) window.scrollTo({ top: 0 });
}

function requireSearch() {
  if (!canSearch()) { toast('GitHub Pages 预览不能调用元宝搜索：请在本机运行 npm start 使用完整功能'); openModal(); return false; }
  if (!conn.active) { toast('先在「API 设置」里连接元宝搜索（任选一种方式）'); openModal(); return false; }
  return true;
}

// ---------------- 连接状态渲染 ----------------
const STATUS_TEXT = { empty: '尚未填写', pending: '尚未测试', testing: '正在真实测试…', ok: '已连接', fail: '连接失败' };
function renderConn(snap = conn.snapshot()) {
  const active = snap.active;
  const label = active === 'api-key' ? '已连接（服务 API Key）' : active === 'aksk' ? '已连接（腾讯云标准方式）' : (canSearch() ? '未连接元宝搜索' : '元宝搜索需本地运行');
  const chip = $('[data-conn-chip]');
  chip.textContent = label;
  chip.className = `conn-chip ${active ? 'ok' : 'off'}`;
  $$('[data-conn-dot]').forEach((d) => { d.className = `dot ${active ? 'ok' : !canSearch() ? 'na' : ''}`; });
  for (const m of ['api-key', 'aksk']) {
    const s = snap[m];
    const el = $(`[data-status="${m}"]`);
    let text = STATUS_TEXT[s.status] || '';
    if (s.status === STATUS.OK) text = s.message || '已连接';
    if (s.status === STATUS.FAIL) text = `连接失败 · ${s.code || ''}${s.message ? `：${s.message}` : ''}${s.requestId ? `（RequestId ${shortId(s.requestId)}）` : ''}`;
    el.textContent = text;
    el.className = `status ${s.status}`;
    $(`[data-auth="${m}"]`).classList.toggle('active', active === m);
    const btn = $(`[data-test="${m}"]`);
    btn.disabled = !canSearch() || s.status === STATUS.TESTING;
    btn.textContent = s.status === STATUS.TESTING ? '测试中…' : active === m ? '已在使用 · 重新测试' : s.status === STATUS.OK ? '切换为此方式' : '测试并使用';
  }
  $('[data-auto-detect]').disabled = !canSearch() || !(snap['api-key'].configured && snap.aksk.configured);
  renderQuotaNotes();
}

function renderQuotaNotes() {
  const n = $('[data-quota-note]');
  n.textContent = !canSearch() ? 'Pages 预览：只比对 GitHub 官方 Release，不调用元宝搜索'
    : conn.active ? '每次检测调用 1 次元宝搜索，会消耗额度' : '未连接元宝搜索时，只比对 GitHub 官方 Release';
}

// ---------------- 弹窗 ----------------
let lastFocus = null;
function openModal() {
  lastFocus = document.activeElement;
  $('[data-modal]').hidden = false;
  $('[data-pages-warn]').hidden = state.mode !== 'pages';
  ['#in-apikey', '#in-sid', '#in-skey'].forEach((s) => { $(s).type = 'password'; }); // 每次打开都默认遮挡
  $('[data-use-env]').hidden = !(state.envCreds['api-key'] || state.envCreds.aksk);
  setTimeout(() => ($('#in-apikey').disabled ? $('.modal') : $('#in-apikey')).focus(), 20);
}
function closeModal() {
  $('[data-modal]').hidden = true;
  ['#in-apikey', '#in-sid', '#in-skey'].forEach((s) => { $(s).type = 'password'; });
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
function renderModeTexts() {
  if (!viaRelay()) return;
  const warn = $('[data-pages-warn]');
  warn.classList.add('relay');
  $('[data-pages-warn-text]').innerHTML = '<b>当前是 GitHub Pages 在线版，已接入 CodeFresh 中转服务。</b>元宝搜索不允许网页直接跨域调用，所以你填的密钥会随每次搜索请求发给中转服务，<b>只用于转发给腾讯云官方接口</b>，中转服务不保存、不写日志；网页里也只放在内存，刷新即清空。';
  $('[data-aksk-hint]').textContent = '中转服务端用 TC3-HMAC-SHA256 签名后转发，不保存密钥';
  $('[data-guide-pages]').textContent = '通过 CodeFresh 中转服务调用元宝搜索：填入自己的密钥即可在线体检、检索 CSDN；中转只转发不保存。也可本地运行获得完全离线的密钥处理。';
  const yb = $('[data-guide-pages-yb]'); yb.className = 'y'; yb.textContent = '元宝搜索（经中转）';
}
function readCreds(method) {
  if (method === 'api-key') { const v = $('#in-apikey').value; return v.trim() ? { apiKey: v } : null; }
  const id = $('#in-sid').value; const key = $('#in-skey').value;
  return id.trim() || key.trim() ? { secretId: id, secretKey: key } : null;
}

// ---------------- 版本雷达 ----------------
async function loadReleases(force = false) {
  state.releasesLoading = true; renderRadarMini(); renderRadar();
  try { state.releases = await api.releases(force); } catch { state.releases = { ok: false, error: { code: 'NetworkError', message: '无法获取 GitHub 发布记录' } }; }
  state.releasesLoading = false;
  const tag = state.releases?.latestStable?.tag;
  if (tag && (!state.changelog || state.changelog.tag !== tag)) {
    try { const c = await api.changelog(tag); state.changelog = { ...c, tag }; } catch { state.changelog = { ok: false, tag }; }
  }
  renderRadarMini(); renderRadar();
}

function bucketBars(releases, days = 30, n = 6, now = Date.now()) {
  const size = (days * 86400000) / n; const out = Array.from({ length: n }, () => ({ s: 0, b: 0 }));
  for (const r of releases || []) {
    const t = Date.parse(r.publishedAt || ''); if (!Number.isFinite(t) || t < now - days * 86400000) continue;
    const i = Math.min(n - 1, Math.floor((t - (now - days * 86400000)) / size));
    if (r.prerelease) out[i].b++; else out[i].s++;
  }
  return out;
}

function renderRadarMini() {
  const el = $('[data-radar-mini]');
  const r = state.releases;
  if (state.releasesLoading && !r) { el.innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line short"></div>'; return; }
  if (!r || !r.ok) {
    el.innerHTML = `<div class="rm-tile"><div class="rm-title">${icon('layers')}OpenClaw<span class="track">暂未获取</span></div><div class="rm-meta">${esc(r?.error?.message || 'GitHub 数据暂不可用')}</div><div class="rm-meta">${ext(RELEASES_PAGE, `查看官方 Releases ${icon('arrow')}`)}</div></div><div></div>`;
    return;
  }
  const s = r.latestStable;
  const bars = bucketBars(r.releases, 30, 6);
  const max = Math.max(1, ...bars.map((b) => b.s + b.b));
  el.innerHTML = `
    <div class="rm-tile">
      <div class="rm-title">${icon('layers')}OpenClaw<span class="track">${icon('refresh')}追踪中</span></div>
      <div class="ver">${s ? esc(s.tag) : '暂未获取'}<small>最新稳定版</small></div>
      <div class="rm-meta"><span>${s ? `发布于 ${fmtDay(s.publishedAt)}` : ''}</span>${s ? ext(s.url, `查看更新日志 ${icon('arrow')}`) : ''}</div>
      ${r.latestBeta && r.betaIsNewer ? `<div class="rm-meta"><span>另有 beta：${esc(r.latestBeta.tag)}（非稳定版）</span></div>` : ''}
    </div>
    <div class="spark-chart" aria-label="近 30 天发布分布（每 5 天一组）">
      <div class="bars">${bars.map((b) => `<i style="height:${Math.round(((b.s + b.b) / max) * 100)}%" title="稳定 ${b.s} · beta ${b.b}"><b style="height:${b.s + b.b ? Math.round((b.b / (b.s + b.b)) * 100) : 0}%"></b></i>`).join('')}</div>
      <div class="legend"><span>稳定 ${r.windows[30].stable}</span><span class="b">beta ${r.windows[30].beta}</span></div>
      <div class="legend">近 30 天 · 每 5 天一组</div>
    </div>`;
}

const IMPACT_ICON = { breaking: 'warn', install: 'layers', update: 'refresh', config: 'settings', security: 'shield', model: 'bolt', other: 'flow' };
const LVL_TEXT = { high: '需留意', medium: '建议了解', low: '一般' };

function renderRadar() {
  const r = state.releases; const d = state.windowDays;
  const statsEl = $('[data-radar-stats]'); const main = $('[data-radar-main]');
  const review = state.reports.filter((x) => x.status === 'needs-review' || x.status === 'outdated').length;
  if (!r || !r.ok) {
    const msg = state.releasesLoading ? '正在读取 GitHub 官方发布记录…' : esc(r?.error?.message || 'GitHub 数据暂不可用');
    statsEl.innerHTML = statCard('', 'radar-dish', '正在追踪', '1', 'OpenClaw 官方仓库') + statCard('g', 'layers', '近期更新', '—', msg) + statCard('o', 'clip', '待复核教程', String(review), '本次会话');
    main.innerHTML = `<div class="empty"><img src="${A}version-radar-dish.webp" alt="" /><strong>${msg}</strong>${!state.releasesLoading ? `<span>${r?.lastSuccessAt ? `最后一次成功：${fmtDay(r.lastSuccessAt)}` : '还没有成功获取过数据'}；不会猜测版本号。</span>${ext(RELEASES_PAGE, `打开 GitHub Releases ${icon('arrow')}`)}` : ''}</div>`;
  } else {
    const w = r.windows[d];
    const cover = r.windowCoverage[d] ? '' : `<span class="cov">样本始于 ${fmtShort(r.oldestInSample)} · 可能更多</span>`;
    statsEl.innerHTML = statCard('', 'radar-dish', '正在追踪', '1', `<span>OpenClaw 官方仓库</span><span>${esc(r.repo)}</span>`)
      + statCard('g', 'layers', '近期更新', String(w.stable).padStart(2, '0'), `<div class="seg" role="group" aria-label="统计窗口">${[7, 30, 90].map((x) => `<button type="button" data-window="${x}" aria-pressed="${x === d}">${x}天</button>`).join('')}</div><span>近 ${d} 天稳定版 · 另有 beta ${w.beta}</span>${cover}`)
      + statCard('o', 'clip', '待复核教程', String(review).padStart(2, '0'), '<span>本次会话检测</span><span>刷新页面即清空</span>');
    const s = r.latestStable;
    const cl = state.changelog;
    const impact = cl && cl.ok ? cl.impact : [];
    main.innerHTML = `
      <div class="oc-left">
        <div class="flow" aria-label="更新路径">
          <div>${icon('book')}旧版教程</div><i></i>
          <div>${icon('refresh')}近 30 天 ${r.windows[30].stable} 版</div><i></i>
          <div class="cur">${icon('check')}<b>${esc(s?.tag || '暂未获取')}</b></div>
        </div>
        ${impact.length ? `<p class="meta-line">${esc(s.tag)} 官方 Changelog 中与教程最相关的变更类别（${ext(cl.sourceUrl, '查看原文')}）：</p>
        <ul class="impact-list">${impact.slice(0, 4).map((x) => `<li>${ext(x.docUrl || cl.sourceUrl, `<span class="ii">${icon(IMPACT_ICON[x.key] || 'flow')}</span><span><strong>${esc(x.label === x.title ? x.title : `${x.label}`)} · ${x.count} 条</strong><small>${esc(x.example || '')}</small></span><span class="lvl ${x.level}">${LVL_TEXT[x.level]}</span>${icon('chev')}`, 'imp')}</li>`).join('')}</ul>`
        : `<div class="empty"><strong>${cl && !cl.ok ? '这个版本没有可读取的 Changelog' : '正在读取官方 Changelog…'}</strong><span>可直接查看 GitHub 发布说明。</span></div>`}
        <div class="oc-foot">
          <button class="yb-strip" type="button" data-radar-search><img src="./assets/brand/yuanbao-icon.png" alt="" /><b>元宝搜索</b> · 搜官方更新信息<span class="slashes"></span></button>
          ${s ? ext(s.url, `查看官方更新日志 ${icon('arrow')}`, 'btn btn-primary') : ''}
        </div>
      </div>
      <div class="timeline">
        <h3>${icon('cal')}发布时间线</h3>
        <ol>${r.releases.map((x) => `<li>${ext(x.url, `<i></i><b>${esc(x.tag.replace(/^v/, ''))}</b><span>${fmtShort(x.publishedAt)}</span>`, x.prerelease ? 'beta' : '')}</li>`).join('')}</ol>
        <span class="tl-note"><i class="lg"></i>稳定 <i class="lg b"></i>beta · 近 ${r.sampleSize} 条 · ${r.stale ? '缓存 ' : ''}${fmtTime(r.fetchedAt)}</span>
      </div>`;
  }
  renderImpact();
  renderRadarRead();
}

function statCard(cls, ico, label, num, side) {
  const img = ico === 'radar-dish' ? `<img src="${A}version-radar-dish.webp" alt="" />` : ico === 'layers' ? `<img src="${A}mcp-cubes.webp" alt="" />` : `<img src="${A}hourglass.webp" alt="" />`;
  return `<div class="card stat ${cls}"><span class="s-ico">${img}</span><span class="s-txt"><span>${label}</span><b>${num}</b></span><span class="s-side">${side}</span></div>`;
}

function reportTitle(rp) {
  return rp.tutorialMeta?.title || rp.commands?.[0] || (rp.inputKind === 'url' ? '链接教程' : `${rp.tool || '未识别工具'} 教程片段`);
}
const LVL_BY_STATUS = { outdated: 'high', 'needs-review': 'medium', fresh: 'low', insufficient: 'medium' };

function renderImpact() {
  const el = $('[data-impact]');
  const list = state.reports;
  if (!list.length) {
    el.innerHTML = `<div class="empty"><img src="${A}report-robot.webp" alt="" /><strong>还没有检测过教程</strong><span>在「教程体检」检测后，这里会列出需要复核的教程。</span><button class="btn btn-ghost" type="button" data-nav="check">去检测一篇</button></div>`;
    return;
  }
  const review = list.filter((x) => x.status === 'needs-review' || x.status === 'outdated').length;
  el.innerHTML = `<div class="big-count">${icon('warn')}<b>${review}</b>篇教程建议复核 <small class="muted">/ 共检测 ${list.length} 篇</small></div>
    <ul class="mini-list">${list.slice(-3).reverse().map((rp, i) => `<li><button type="button" data-open-report="${list.length - 1 - i}">${icon('book')}<span class="t">${esc(reportTitle(rp))}</span><span class="lvl ${LVL_BY_STATUS[rp.status]}">${esc(rp.statusLabel)}</span>${icon('chev')}</button></li>`).join('')}</ul>
    <h3 class="sub-h">更新路径 · 官方入口</h3>
    <ul class="links">${[[state.releases?.latestStable?.notesUrl, `${state.releases?.latestStable?.tag || ''} 发布说明`], [DOCS_INSTALL, '官方安装文档'], [RELEASES_PAGE, '全部 Releases']].filter((x) => x[0]).map(([u, t]) => `<li>${ext(u, esc(t))}</li>`).join('')}</ul>`;
}

const READ_TOPICS = [
  { q: 'OpenClaw 升级 配置', title: '升级之后怎么配置？', sub: '检索 CSDN 上的 OpenClaw 升级配置文章' },
  { q: 'OpenClaw 常见问题', title: '新手常见问题整理', sub: '检索 CSDN 上的 OpenClaw 问题汇总' },
];
function renderRadarRead() {
  $('[data-radar-read]').innerHTML = `<ul class="mini-list">${READ_TOPICS.map((t, i) => `<li><button type="button" data-read="${i}">${icon('doc')}<span class="t"><b>${esc(t.title)}</b><br><small class="muted">${esc(t.sub)}</small></span><span class="go-csdn"><span class="gt">检索&nbsp;</span>CSDN</span>${icon('chev')}</button></li>`).join('')}</ul>
    <p class="panel-note">点击后用元宝搜索限定 blog.csdn.net 实时检索，结果在「发现新教程」展示</p>`;
}

// ---------------- 教程体检 ----------------
const SAMPLES = {
  openclaw: 'OpenClaw 安装教程（基于 v2026.10.5）\nnpm install -g openclaw@2026.10.5\nopenclaw onboard --install-daemon',
  mcp: 'MCP 服务器调试教程（2025-03-12 发布）\nnpx @modelcontextprotocol/inspector node build/index.js',
  qwen: 'Qwen Agent 入门教程 2025年1月10日\npip install -U "qwen-agent[gui,rag,code_interpreter,mcp]"',
};

function setInputTab(tab) {
  state.inputTab = tab;
  $$('[data-input-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.inputTab === tab)));
  $('[data-field="url"]').hidden = tab !== 'url';
  $('[data-field="text"]').hidden = tab !== 'text';
}

async function runCheck() {
  const raw = state.inputTab === 'url' ? $('#check-url').value : $('#check-text').value;
  let parsed;
  try { parsed = parseTutorialInput(raw); } catch (e) { state.check = { phase: 'error', error: e.message, report: null }; renderReport(); (state.inputTab === 'url' ? $('#check-url') : $('#check-text')).focus(); return; }
  if (parsed.kind === 'text' && state.inputTab === 'url') { /* 允许在链接框输入文字 */ }
  const btn = $('[data-check-btn]'); btn.disabled = true;
  const willSearch = canSearch() && !!conn.active;
  const steps = [{ k: 'gh', t: '读取 GitHub 官方发布记录与 Changelog' }, { k: 'yb', t: willSearch ? '元宝搜索检索公开资料（1 次调用）' : '未连接元宝搜索，跳过联网检索' }, { k: 'match', t: '比对教程版本、命令与官方变更' }];
  const setStep = (i) => { state.check = { phase: 'checking', steps: steps.map((s, j) => ({ ...s, st: j < i ? 'done' : j === i ? 'doing' : '' })) }; renderReport(); };
  try {
    setStep(0);
    if (!state.releases || !state.releases.ok) await loadReleases();
    setStep(1);
    let search = null;
    if (willSearch) {
      const r = await doSearch({ query: buildCheckQuery(parsed) });
      search = r.ok ? { ok: true, provider: r.provider, requestId: r.requestId, items: r.items } : { ok: false, error: { code: r.code, message: r.message } };
    }
    setStep(2);
    const report = checkTutorial({ parsed, openclaw: state.releases, changelog: state.changelog?.ok ? state.changelog : null, search });
    state.reports.push(report);
    state.check = { phase: 'result', report };
  } catch (e) {
    state.check = { phase: 'error', error: '检测过程中出现网络错误，请稍后再试', report: null };
  } finally { btn.disabled = false; }
  renderReport(); renderCsdnPanel(); renderImpact(); renderRadar();
}

function renderReport() {
  const el = $('[data-report]'); const c = state.check;
  if (c.phase === 'checking') {
    el.innerHTML = `<div class="rp-head"><h2 id="h-report">${icon('doc')}正在体检…</h2></div><div class="rp-body"><ul class="progress">${c.steps.map((s) => `<li class="${s.st}">${esc(s.t)}</li>`).join('')}</ul><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`;
    return;
  }
  if (c.phase === 'error') {
    el.innerHTML = `<div class="rp-head"><h2 id="h-report">${icon('doc')}体检报告</h2><span class="badge bad">${icon('warn')}无法检测</span></div><div class="rp-body"><div class="err-box">${esc(c.error)}</div><button class="btn btn-ghost rp-cta" type="button" data-demo>查看示例报告</button></div>`;
    return;
  }
  if (c.phase === 'result' && c.report) { el.innerHTML = realReportHtml(c.report); return; }
  const d = DEMO_REPORT;
  el.innerHTML = `
    <div class="rp-head"><h2 id="h-report">${icon('doc')}示例体检报告</h2><span class="vsep"></span><span class="badge demo">示例数据</span><span class="badge ok">${icon('check')}版式演示</span></div>
    <div class="rp-body">
      <div class="rp-top">
        <div class="stamp"><small>示例</small>${esc(d.statusLabel)}</div>
        <div class="score"><span>新鲜度评分（示例）</span><b>${d.freshnessScoreDemo}<sup>%</sup></b></div>
        <div class="vcompare"><div class="vbox"><span>教程适用版本</span><b>${esc(d.tutorialVersion)}</b></div>${icon('right')}<div class="vbox new"><span>当前官方版本</span><b>${esc(d.latestStableLabel)}</b></div></div>
      </div>
      <div class="yb-strip"><img src="./assets/brand/yuanbao-icon.png" alt="" /><b>元宝搜索</b> · 示例：已检索公开信息<span class="slashes"></span></div>
      <div class="rp-split">
        <div class="steps-wrap">
          <ol class="steps">${d.steps.map((s, i) => `<li>${icon(['settings', 'refresh', 'doc'][i])}<span class="n">${s.n}</span><strong>${esc(s.title)}</strong><span>· ${esc(s.text)}</span>${icon('chev').replace('<svg', '<svg class="chev-r"')}</li>`).join('')}</ol>
        </div>
        <img class="robot" src="${A}report-robot.webp" alt="" />
      </div>
      <button class="btn btn-primary rp-cta" type="button" data-focus-input>用你的教程开始真实检测${icon('arrow')}</button>
    </div>`;
}

const BADGE_CLS = { fresh: 'ok', 'needs-review': 'warn', outdated: 'bad', insufficient: 'na' };
function realReportHtml(rp) {
  const ev = rp.evidence;
  return `
    <div class="rp-head"><h2 id="h-report">${icon('doc')}体检报告</h2><span class="vsep"></span><span class="badge ${BADGE_CLS[rp.status]}">${rp.status === 'fresh' ? icon('check') : icon('warn')}${esc(rp.statusLabel)}</span><span class="meta-line">${esc(rp.tool || '未识别工具')} · ${fmtTime(rp.checkedAt)} 检测</span><button class="link-btn" type="button" data-demo>示例报告</button></div>
    <div class="rp-body">
      <div class="rp-top real">
        <div class="stamp ${rp.status}">${esc(rp.statusLabel)}</div>
        <div class="vcompare"><div class="vbox"><span>教程适用版本</span><b>${esc(rp.tutorialVersion || '未标注')}</b></div>${icon('right')}<div class="vbox new"><span>当前官方稳定版</span><b>${esc(rp.latestStable?.tag || (rp.tool === 'OpenClaw' ? '暂未获取' : '未追踪'))}</b></div></div>
      </div>
      ${ev ? `<div class="yb-strip"><img src="./assets/brand/yuanbao-icon.png" alt="" /><b>元宝搜索</b> · 已检索 ${ev.count} 条公开信息<code>RequestId ${esc(shortId(ev.requestId))}</code></div>`
        : `<div class="yb-strip off">${icon('github')}<b>GitHub 官方数据</b> · 未使用元宝搜索（${!canSearch() ? 'Pages 预览' : '未连接'}）</div>`}
      ${rp.tutorialMeta ? `<p class="meta-line">索引中的原文：${ext(rp.tutorialMeta.url, esc(rp.tutorialMeta.title))} · ${esc(rp.tutorialMeta.site || '')} · ${rp.tutorialMeta.date ? `发布于 ${esc(rp.tutorialMeta.date)}` : '日期未知'}</p>` : ''}
      <ul class="rp-reason">${rp.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      ${rp.findings.length ? `<h3 class="sub-h">核验依据 · 原教程 → 官方证据</h3><ul class="findings">${rp.findings.map((f) => `<li class="${f.severity}"><span class="claim">${esc(f.claim)}</span><span class="chg">${esc(f.change)}</span>${ext(f.sourceUrl, `${esc(f.sourceLabel || '来源')} ${icon('arrow')}`)}</li>`).join('')}</ul>` : ''}
      ${rp.recommendedLinks.length ? `<h3 class="sub-h">更新路径 · 官方入口</h3><ul class="links">${rp.recommendedLinks.map((l) => `<li>${ext(l.url, `${esc(l.label)}`)}</li>`).join('')}</ul>` : ''}
      ${rp.limitations.length ? `<h3 class="sub-h">本次检测的限制</h3><ul class="limits">${rp.limitations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

const CHECK_TOPICS = [
  { q: 'OpenClaw 入门教程', title: 'OpenClaw 入门', sub: '官方文档 · 入门教程', img: 'tutorial-robot', cls: 'g' },
  { q: 'MCP 实战教程', title: 'MCP 实战', sub: '社区精选 · 实战案例', img: 'mcp-cubes', cls: 'p' },
  { q: 'Qwen Agent 工作流', title: 'Qwen Agent 工作流', sub: '实用指南 · 工作流搭建', img: 'qwen-chat-bubbles', cls: 'o' },
];
function renderCsdnPanel() {
  const el = $('[data-csdn-panel]');
  const rp = state.check.phase === 'result' ? state.check.report : null;
  if (rp && rp.relatedTutorials.length) {
    el.innerHTML = `<div class="csdn-head"><h2 id="h-csdn">相关教程</h2><small>来自本次元宝搜索 · 来源按真实链接标注</small></div>
      <ul class="topic-list">${rp.relatedTutorials.map((it) => `<li>${ext(it.url, `<span class="ic ${it.isCsdn ? 'o' : 'g'}"><img src="${A}${it.isCsdn ? 'csdn-code-note' : TOPIC_IMG[it.topic] || 'hourglass'}.webp" alt="" /></span><span><strong>${esc(it.title)}</strong><small>${esc(it.site || it.domain || '来源未知')} · ${esc(it.date || '日期未知')}</small></span>${it.isCsdn ? '<span class="badge csdn">CSDN</span>' : `<span class="src-tag">${esc(it.domain || '未知来源')}</span>`}${icon('chev')}`, 'topic')}</li>`).join('')}</ul>
      <button class="btn btn-csdn" type="button" data-more-csdn>探索更多 CSDN 教程${icon('arrow')}</button>`;
    return;
  }
  el.innerHTML = `<div class="csdn-head"><h2 id="h-csdn"><img class="csdn-word" src="./assets/brand/csdn-wordmark.png" alt="CSDN" />开发者热学</h2><small>点击即实时检索 CSDN</small></div>
    <ul class="topic-list">${CHECK_TOPICS.map((t, i) => `<li><button class="topic" type="button" data-check-topic="${i}"><span class="ic ${t.cls}"><img src="${A}${t.img}.webp" alt="" /></span><span><strong>${esc(t.title)}</strong><small>${esc(t.sub)}</small></span><span class="go-csdn"><span class="gt">检索&nbsp;</span>CSDN</span>${icon('chev')}</button></li>`).join('')}</ul>
    <button class="btn btn-csdn" type="button" data-more-csdn>探索更多 CSDN 教程${icon('arrow')}</button>`;
}

// ---------------- 发现新教程 ----------------
const TOPIC_IMG = { openclaw: 'tutorial-robot', mcp: 'mcp-cubes', qwen: 'qwen-chat-bubbles', workflow: 'terminal-workflow', general: 'hourglass' };
const EXPLORE_TOPICS = [
  { q: 'OpenClaw 快速上手', title: 'OpenClaw 快速上手', tag: '入门', desc: '快速了解 OpenClaw 的核心概念与基本使用流程。', topic: 'openclaw' },
  { q: 'MCP 工具调用实战', title: 'MCP 工具调用实战', tag: '近期更新', desc: '通过实际案例，掌握 MCP 在 AI 应用中的工具调用方法。', topic: 'mcp' },
  { q: 'Qwen Agent 入门', title: 'Qwen Agent 入门', tag: '入门', desc: '从零认识 Qwen Agent，搭建你的第一个智能代理。', topic: 'qwen' },
  { q: 'AI 工作流搭建', title: 'AI 工作流搭建', tag: '近期更新', desc: '结合常用工具，构建高效、可复用的 AI 工作流。', topic: 'workflow' },
];

async function runExplore(query, opts = {}) {
  const q = (query ?? $('#explore-q').value).trim();
  if (!q) { toast('请输入搜索关键词'); $('#explore-q').focus(); return; }
  if (opts.csdnOnly !== undefined) { state.explore.csdnOnly = opts.csdnOnly; $('[data-csdn-only]').checked = opts.csdnOnly; }
  $('#explore-q').value = q;
  if (!requireSearch()) return;
  let params;
  try { params = buildDiscoverParams(q, { filter: state.explore.filter, csdnOnly: state.explore.csdnOnly }); } catch (e) { toast(e.message); return; }
  state.explore = { ...state.explore, phase: 'loading', query: q, params };
  renderExplore();
  $('[data-explore-btn]').disabled = true;
  const r = await doSearch(params);
  $('[data-explore-btn]').disabled = false;
  state.explore = r.ok ? { ...state.explore, phase: 'result', result: r } : { ...state.explore, phase: 'error', error: r };
  renderExplore();
}

function renderExplore() {
  const el = $('[data-results]'); const e = state.explore;
  if (e.phase === 'loading') {
    el.innerHTML = `<div class="res-head"><h2 id="h-results">${icon('search')}正在检索「${esc(e.query)}」…</h2><small>调用 1 次元宝搜索</small></div><div class="res-grid">${'<div class="result"><div class="thumb general"></div><div><div class="skeleton-line"></div><br><div class="skeleton-line short"></div></div></div>'.repeat(4)}</div>`;
    return;
  }
  if (e.phase === 'error') {
    el.innerHTML = `<div class="res-head"><h2 id="h-results">${icon('warn')}检索失败</h2></div><div class="err-box">${esc(e.error.code || '')} · ${esc(e.error.message || '未知错误')}${e.error.requestId ? `（RequestId ${esc(shortId(e.error.requestId))}）` : ''}</div><p class="meta-line">认证 / 未开通 / 参数错误不会自动重试；限流最多退避重试 1 次。</p>`;
    return;
  }
  if (e.phase === 'result') {
    const items = processResults(e.result, { sort: e.sort });
    const p = e.params || {};
    el.innerHTML = `<div class="res-head"><h2 id="h-results">${e.csdnOnly ? '<img class="csdn-word" src="./assets/brand/csdn-wordmark.png" alt="CSDN" />' : icon('search')}检索结果 · ${items.length} 条</h2>
      <small>「${esc(p.query)}」${p.freshness ? ` · 时效 ${esc(p.freshness)}` : ''}${p.site ? ` · 站点 ${esc(p.site)}` : ''} · ${e.result.provider === 'aksk' ? '腾讯云标准方式' : '服务 API Key'} · ${fmtTime(e.result.searchedAt)} · RequestId ${esc(shortId(e.result.requestId))}${e.result.skipped ? ` · 跳过 ${e.result.skipped} 条格式异常` : ''}</small></div>
      ${items.length ? `<div class="res-grid">${items.map(resultCard).join('')}</div>` : `<div class="empty"><img src="${A}sleepy-cat.webp" alt="" /><strong>没有找到相关结果</strong><span>换个关键词，或放宽时间筛选。</span></div>`}`;
    return;
  }
  const notReady = !canSearch() ? 'Pages 预览不可检索 · 本地运行后可用' : conn.active ? '点击主题即用元宝搜索实时检索' : '连接元宝搜索后即可检索';
  el.innerHTML = `<div class="res-head"><h2 id="h-results"><img class="csdn-word" src="./assets/brand/csdn-wordmark.png" alt="CSDN" />开发者精选</h2><small>主题入口，不是预置结果 · ${esc(notReady)}</small></div>
    <div class="topic-grid">${EXPLORE_TOPICS.map((t, i) => `<button class="tcard" type="button" data-explore-topic="${i}"><span class="thumb ${t.topic === 'openclaw' ? '' : t.topic}"><img src="${A}${TOPIC_IMG[t.topic]}.webp" alt="" /></span><span><h3>${esc(t.title)}${icon('chev')}</h3><span class="tags"><span class="tag p">检索 CSDN</span><span class="tag">${esc(t.tag)}</span></span><p>${esc(t.desc)}</p></span></button>`).join('')}</div>`;
}

function resultCard(it) {
  const thumbCls = it.isCsdn ? 'csdn' : it.topic;
  const img = it.isCsdn ? 'csdn-code-note' : TOPIC_IMG[it.topic];
  return ext(it.url, `<span class="thumb ${thumbCls}"><img src="${A}${img}.webp" alt="" /></span>
    <span><h3>${esc(it.title)}</h3>
    <span class="tags">${it.isCsdn ? '<span class="badge csdn">CSDN</span>' : `<span class="src-tag" title="${esc(it.domain || '')}">${esc(it.site || it.domain || '来源未知')}</span>`}${it.isOfficial ? '<span class="src-tag off">官方</span>' : ''}<span class="date ${it.date ? '' : 'unknown'}">${it.date ? esc(it.date) : '日期未知'}</span></span>
    <p>${esc(it.summary || '（无摘要）')}</p></span>`, `result ${it.isCsdn ? 'is-csdn' : ''}`);
}

// ---------------- 事件 ----------------
function bind() {
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button, a');
    if (!t) { if (ev.target.matches('[data-modal]')) closeModal(); return; }
    if (t.dataset.nav) { ev.preventDefault(); setView(t.dataset.nav); return; }
    if (t.hasAttribute('data-open-settings')) { openModal(); return; }
    if (t.hasAttribute('data-close-modal')) { closeModal(); return; }
    if (t.dataset.inputTab) { setInputTab(t.dataset.inputTab); return; }
    if (t.dataset.sample) { setInputTab('text'); $('#check-text').value = SAMPLES[t.dataset.sample]; $('#check-text').focus(); return; }
    if (t.hasAttribute('data-focus-input')) { (state.inputTab === 'url' ? $('#check-url') : $('#check-text')).focus(); return; }
    if (t.hasAttribute('data-demo')) { state.check = { phase: 'demo' }; renderReport(); renderCsdnPanel(); return; }
    if (t.dataset.test) { const m = t.dataset.test; conn.setCredentials(m, readCreds(m)); conn.test(m).then((r) => { if (r?.ok) toast(r.message); }); return; }
    if (t.hasAttribute('data-auto-detect')) { conn.setCredentials('api-key', readCreds('api-key')); conn.setCredentials('aksk', readCreds('aksk')); conn.autoSelect().then((m) => toast(m ? `已自动选择：${m === 'api-key' ? '服务 API Key' : '腾讯云标准方式'}` : '两种方式都没有连接成功，请检查凭据')); return; }
    if (t.hasAttribute('data-use-env')) {
      if (state.envCreds['api-key']) conn.setCredentials('api-key', { source: 'env' });
      if (state.envCreds.aksk) conn.setCredentials('aksk', { source: 'env' });
      conn.autoSelect().then((m) => toast(m ? '已使用本机环境变量连接' : '本机环境变量凭据测试失败'));
      return;
    }
    if (t.hasAttribute('data-clear-creds')) { ['#in-apikey', '#in-sid', '#in-skey'].forEach((s) => { $(s).value = ''; }); conn.clear(); toast('已清除内存中的全部凭据'); return; }
    if (t.dataset.eye) { const i = $(`#${t.dataset.eye}`); i.type = i.type === 'password' ? 'text' : 'password'; return; }
    if (t.dataset.window) { state.windowDays = Number(t.dataset.window); renderRadar(); return; }
    if (t.hasAttribute('data-refresh-releases')) { loadReleases(true); return; }
    if (t.hasAttribute('data-radar-search')) { setView('explore'); state.explore.filter = 'official'; syncFilters(); runExplore('OpenClaw 最新版本 更新', { csdnOnly: false }); return; }
    if (t.dataset.read !== undefined) { setView('explore'); runExplore(READ_TOPICS[Number(t.dataset.read)].q, { csdnOnly: true }); return; }
    if (t.dataset.checkTopic !== undefined) { setView('explore'); runExplore(CHECK_TOPICS[Number(t.dataset.checkTopic)].q, { csdnOnly: true }); return; }
    if (t.dataset.exploreTopic !== undefined) { runExplore(EXPLORE_TOPICS[Number(t.dataset.exploreTopic)].q, { csdnOnly: true }); return; }
    if (t.hasAttribute('data-more-csdn')) { setView('explore'); state.explore.csdnOnly = true; $('[data-csdn-only]').checked = true; if (state.explore.phase === 'idle') renderExplore(); $('#explore-q').focus(); return; }
    if (t.dataset.openReport !== undefined) { state.check = { phase: 'result', report: state.reports[Number(t.dataset.openReport)] }; renderReport(); renderCsdnPanel(); setView('check'); return; }
    if (t.dataset.filter) { state.explore.filter = t.dataset.filter; syncFilters(); return; }
  });
  $('#check-form').addEventListener('submit', (e) => { e.preventDefault(); runCheck(); });
  $('#explore-form').addEventListener('submit', (e) => { e.preventDefault(); runExplore(); });
  $('[data-csdn-only]').addEventListener('change', (e) => { state.explore.csdnOnly = e.target.checked; });
  $('[data-sort]').addEventListener('change', (e) => { state.explore.sort = e.target.value; renderExplore(); });
  ['#in-apikey'].forEach((s) => $(s).addEventListener('input', () => conn.setCredentials('api-key', readCreds('api-key'))));
  ['#in-sid', '#in-skey'].forEach((s) => $(s).addEventListener('input', () => conn.setCredentials('aksk', readCreds('aksk'))));
  document.addEventListener('keydown', (e) => {
    const modal = $('[data-modal]');
    if (modal.hidden) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Tab') {
      const f = $$('button:not([disabled]), input:not([disabled]), a[href], select', $('.modal')).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  $$('.filters .fchip').forEach((b) => b.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const all = $$('.filters .fchip'); const i = all.indexOf(b); const n = all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
    n.focus(); n.click();
  }));
  window.addEventListener('hashchange', () => setView(location.hash.slice(1), { push: false }));
}
function syncFilters() { $$('.filters .fchip').forEach((b) => { const on = b.dataset.filter === state.explore.filter; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }); }

// ---------------- 启动 ----------------
async function init() {
  bind(); syncFilters(); setInputTab('url');
  setView(location.hash.slice(1) || 'check', { push: false });
  renderReport(); renderCsdnPanel(); renderExplore(); renderRadarMini(); renderRadar();
  const h = await api.health();
  state.mode = h ? 'local' : 'pages';
  if (h) state.envCreds = h.envCredentials || state.envCreds;
  const chip = $('[data-mode-chip]');
  chip.textContent = h ? '本地完整模式' : RELAY ? 'GitHub Pages · 在线版' : 'GitHub Pages 预览';
  chip.className = `mode-chip ${state.mode}`;
  chip.title = h ? '同源本地服务 127.0.0.1，元宝搜索可用' : RELAY ? '元宝搜索经 CodeFresh 中转服务调用；中转只转发、不保存密钥' : '静态预览：GitHub 版本数据实时可用；元宝搜索需本地运行';
  renderModeTexts(); renderConn(); renderExplore();
  loadReleases();
}
init();
