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
// 产物自检：不允许出现签名 / 服务端代码
const files = [];
async function walk(d) { for (const e of await readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else files.push(p); } }
await walk(DIST);
for (const f of files) {
  if (!/\.(m?js|html|css)$/.test(f)) continue;
  const t = await readFile(f, 'utf8');
  if (/createHmac|TENCENTCLOUD_SECRET|node:crypto/.test(t)) throw new Error(`dist 中出现不应发布的内容：${path.relative(ROOT, f)}`);
}
console.log(`dist/ 已生成：${files.length} 个文件（GitHub Pages 预览模式）`);
