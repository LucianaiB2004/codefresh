import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';

test('Pages 构建：包含前端与通用模块，不包含签名/服务端代码', async () => {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { stdio: 'pipe' });
  await access('dist/index.html'); await access('dist/.nojekyll'); await access('dist/lib/openclaw.mjs');
  await assert.rejects(access('dist/lib/providers/wsa-aksk.mjs'));
  await assert.rejects(access('dist/server'));
  const app = await readFile('dist/app.js', 'utf8');
  assert.ok(!/createHmac|SECRET_KEY/.test(app));
});
