// 生成 GitHub Pages 静态产物到 dist/：public/ + 浏览器可用的通用模块（lib/）。
// 不包含 server/、签名模块、.env 或任何凭据。产物里没有 /api，前端会自动进入「Pages 预览模式」。
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIB_ALLOW } from '../server/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await cp(path.join(ROOT, 'public'), DIST, { recursive: true });
for (const rel of LIB_ALLOW) {
  await mkdir(path.dirname(path.join(DIST, 'lib', rel)), { recursive: true });
  await cp(path.join(ROOT, 'src', rel), path.join(DIST, 'lib', rel));
}
await writeFile(path.join(DIST, '.nojekyll'), '');
// 中转服务地址：CODEFRESH_RELAY_URL（https://…；仅本机测试允许 http://127.0.0.1 / localhost）。留空 = 纯静态预览
const relayRaw = (process.env.CODEFRESH_RELAY_URL || '').trim();
let relay = '';
if (relayRaw) {
  let u;
  try { u = new URL(relayRaw); } catch { throw new Error('CODEFRESH_RELAY_URL 不是合法 URL'); }
  const loop = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) throw new Error('CODEFRESH_RELAY_URL 必须是 https://（本机测试可用 http://127.0.0.1）');
  if (u.username || u.password || u.search || u.hash) throw new Error('CODEFRESH_RELAY_URL 不能包含账号、查询参数或 #');
  relay = u.toString().replace(/\/+$/, '');
}
await writeFile(path.join(DIST, 'config.js'), `// 由 npm run build:pages 生成\nwindow.CODEFRESH_RELAY = ${JSON.stringify(relay)};\n`);
// 产物自检：不允许出现签名 / 服务端代码
const files = [];
async function walk(d) { for (const e of await readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else files.push(p); } }
await walk(DIST);
for (const f of files) {
  if (!/\.(m?js|html|css)$/.test(f)) continue;
  const t = await readFile(f, 'utf8');
  if (/createHmac|TENCENTCLOUD_SECRET|node:crypto/.test(t)) throw new Error(`dist 中出现不应发布的内容：${path.relative(ROOT, f)}`);
}
console.log(`dist/ 已生成：${files.length} 个文件（GitHub Pages ${relay ? `在线版，中转服务 ${relay}` : '预览模式，未配置中转服务'}）`);
