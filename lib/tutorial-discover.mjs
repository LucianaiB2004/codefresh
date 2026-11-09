// 近期 AI 教程发现：参数构造、去重、官方来源标记、CSDN 来源仅按真实域名标记
import { normalizeUrl, hostOf, isCsdnUrl } from './providers/wsa-response.mjs';

export const FILTERS = {
  all: { label: '全部' },
  recent: { label: '近 30 天', freshness: 'd30' },
  new: { label: '近 7 天', freshness: 'd7' },
  official: { label: '官方文档', suffix: '官方文档' },
  beginner: { label: '入门教程', suffix: '入门教程' },
};

const OFFICIAL_HOSTS = [
  'docs.openclaw.ai', 'openclaw.ai', 'modelcontextprotocol.io', 'spec.modelcontextprotocol.io',
  'qwen.readthedocs.io', 'qwenlm.github.io', 'docs.github.com', 'cloud.tencent.com', 'help.aliyun.com',
  'docs.anthropic.com', 'platform.openai.com', 'docs.dify.ai', 'python.langchain.com', 'docs.langchain.com', 'ollama.com',
];
const OFFICIAL_GH_ORGS = ['openclaw', 'modelcontextprotocol', 'qwenlm', 'langchain-ai', 'langgenius', 'ollama'];

export function isOfficialUrl(url) {
  const h = hostOf(url);
  if (!h) return false;
  if (OFFICIAL_HOSTS.some((o) => h === o || h.endsWith('.' + o))) return true;
  if (h === 'github.com') {
    try { const org = new URL(url).pathname.split('/')[1]?.toLowerCase(); return OFFICIAL_GH_ORGS.includes(org); } catch { return false; }
  }
  return false;
}

export function buildDiscoverParams(query, { filter = 'all', csdnOnly = false } = {}) {
  const q = typeof query === 'string' ? query.replace(/\s+/g, ' ').trim() : '';
  if (!q) { const e = new Error('请输入搜索关键词'); e.code = 'EmptyQuery'; throw e; }
  const f = FILTERS[filter] || FILTERS.all;
  return {
    query: f.suffix && !q.includes(f.suffix) ? `${q} ${f.suffix}` : q,
    freshness: f.freshness || null,
    site: csdnOnly ? 'blog.csdn.net' : null,
  };
}

export function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const key = normalizeUrl(it.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export function topicOf(item) {
  const t = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  if (/open\s?claw/.test(t)) return 'openclaw';
  if (/\bmcp\b|model context protocol/.test(t)) return 'mcp';
  if (/qwen/.test(t)) return 'qwen';
  if (/workflow|工作流|agent|智能体/.test(t)) return 'workflow';
  return 'general';
}

export function processResults(result, { sort = 'relevance' } = {}) {
  const items = dedupeItems(result?.items || []).map((it) => ({
    ...it,
    isCsdn: isCsdnUrl(it.url), // 只看真实 URL，不信任 site 字段
    isOfficial: isOfficialUrl(it.url),
    topic: topicOf(it),
  }));
  if (sort === 'date') {
    const t = (x) => (x.date ? Date.parse(x.date) : null);
    items.sort((a, b) => {
      const ta = t(a); const tb = t(b);
      if (ta === tb) return 0;
      if (ta === null) return 1; // 无日期排最后（显示「日期未知」）
      if (tb === null) return -1;
      return tb - ta;
    });
  }
  return items;
}
