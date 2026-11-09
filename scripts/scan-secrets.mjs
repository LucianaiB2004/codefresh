// 密钥扫描：检查将要提交的文件（git 跟踪 + 未忽略的新文件）与 dist/ 中是否含有凭据。
// 若当前环境里有 TENCENTCLOUD_* 变量，还会逐字比对它们的真实值（只报告文件名，不打印值）。
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let files = [];
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch { console.error('需要在 git 仓库中运行'); process.exit(2); }
async function walk(d, out) { try { for (const e of await readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p, out); else out.push(path.relative(ROOT, p)); } } catch {} return out; }
files = [...new Set([...files, ...(await walk(path.join(ROOT, 'dist'), []))])];

const PATTERNS = [
  { name: '腾讯云 SecretId (AKID…)', re: /AKID[A-Za-z0-9]{28,}/ },
  { name: 'sk- 形式的 API Key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'Bearer 令牌字面量', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '环境变量赋值了非占位符的值', re: /TENCENTCLOUD_(?:WSA_APIKEY|SECRET_ID|SECRET_KEY)\s*=\s*(?!REPLACE_WITH)[A-Za-z0-9]{12,}/ },
];
const literal = ['TENCENTCLOUD_WSA_APIKEY', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'].map((k) => process.env[k]).filter((v) => v && v.length >= 8);
const findings = [];
for (const f of files) {
  const full = path.join(ROOT, f);
  try { if ((await stat(full)).size > 5_000_000) continue; } catch { continue; }
  const buf = await readFile(full);
  if (buf.includes(0)) { if (literal.some((v) => buf.includes(Buffer.from(v)))) findings.push(`${f}: 含真实凭据值（二进制）`); continue; }
  const t = buf.toString('utf8');
  for (const p of PATTERNS) if (p.re.test(t)) findings.push(`${f}: ${p.name}`);
  if (literal.some((v) => t.includes(v))) findings.push(`${f}: 含当前环境中的真实凭据值`);
  if (path.basename(f) === '.env') findings.push(`${f}: .env 不应被提交`);
}
console.log(`扫描 ${files.length} 个文件，比对真实凭据值 ${literal.length} 个`);
if (findings.length) { console.log('发现问题：'); for (const x of findings) console.log('  - ' + x); process.exit(1); }
console.log('未发现凭据 ✔');
