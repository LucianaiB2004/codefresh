// 真实联调（会消耗少量元宝搜索额度）：node --env-file=.env scripts/integration.mjs
// 只输出结果码、RequestId 前缀与条数，绝不输出任何凭据。
import { testConnection, runSearch } from '../src/providers/index.mjs';
import { createOpenClawClient } from '../src/openclaw.mjs';
import { processResults } from '../src/tutorial-discover.mjs';

const env = process.env;
const apiKey = env.TENCENTCLOUD_WSA_APIKEY;
const aksk = env.TENCENTCLOUD_SECRET_ID && env.TENCENTCLOUD_SECRET_KEY ? { secretId: env.TENCENTCLOUD_SECRET_ID, secretKey: env.TENCENTCLOUD_SECRET_KEY } : null;
const id = (x) => (x ? `${String(x).slice(0, 8)}…` : '-');
const rows = [];
const log = (name, r, extra = '') => { rows.push({ name, pass: r.pass, detail: r.detail }); console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${name}  ${r.detail}${extra}`); };

const gh = createOpenClawClient();
const rel = await gh.getReleases();
log('GitHub openclaw/openclaw releases', { pass: rel.ok && !!rel.latestStable && !rel.latestStable.prerelease, detail: rel.ok ? `latestStable=${rel.latestStable?.tag} published=${rel.latestStable?.publishedAt} latestBeta=${rel.latestBeta?.tag} sample=${rel.sampleSize}` : rel.error?.code });

if (apiKey) {
  const t = await testConnection('api-key', { apiKey });
  log('API Key 连接测试（真实 SearchPro）', { pass: t.ok, detail: t.ok ? `${t.message} version=${t.version} RequestId=${id(t.requestId)}` : `${t.code} ${t.message} RequestId=${id(t.requestId)}` });
  const s = await runSearch('api-key', { apiKey }, { query: 'OpenClaw 教程', site: 'blog.csdn.net', freshness: 'm3' });
  const items = s.ok ? processResults(s) : [];
  log('API Key 搜索 Site=blog.csdn.net Freshness=m3', { pass: s.ok, detail: s.ok ? `items=${items.length} csdn=${items.filter((i) => i.isCsdn).length} withDate=${items.filter((i) => i.date).length} skipped=${s.skipped} RequestId=${id(s.requestId)}` : `${s.error.code} ${s.error.message}` });
  const bad = await testConnection('api-key', { apiKey: 'invalid-key-for-negative-test' });
  log('API Key 错误凭据 → 必须失败', { pass: !bad.ok, detail: `ok=${bad.ok} code=${bad.code}` });
} else console.log('SKIP  API Key：未配置 TENCENTCLOUD_WSA_APIKEY（未进行真实联调）');

if (aksk) {
  const t = await testConnection('aksk', aksk);
  log('AK/SK 连接测试（TC3 签名，真实 SearchPro）', { pass: t.ok, detail: t.ok ? `${t.message} version=${t.version} RequestId=${id(t.requestId)}` : `${t.code} ${t.message} RequestId=${id(t.requestId)}` });
  const s = await runSearch('aksk', aksk, { query: 'MCP 工具调用 教程', freshness: 'd30' });
  const items = s.ok ? processResults(s) : [];
  log('AK/SK 搜索 Freshness=d30', { pass: s.ok, detail: s.ok ? `items=${items.length} official=${items.filter((i) => i.isOfficial).length} csdn=${items.filter((i) => i.isCsdn).length} RequestId=${id(s.requestId)}` : `${s.error.code} ${s.error.message}` });
  const bad = await testConnection('aksk', { secretId: aksk.secretId, secretKey: 'wrong-secret-key-for-negative-test' });
  log('AK/SK 错误 SecretKey → 必须失败', { pass: !bad.ok, detail: `ok=${bad.ok} code=${bad.code}` });
} else console.log('SKIP  AK/SK：未配置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY（未进行真实联调）');

const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exitCode = failed ? 1 : 0;
