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

test('Pages 构建：CODEFRESH_RELAY_URL 写入 config.js，非法地址拒绝，默认为空', async () => {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { stdio: 'pipe', env: { ...process.env, CODEFRESH_RELAY_URL: 'https://relay.example.com/' } });
  assert.match(await readFile('dist/config.js', 'utf8'), /window\.CODEFRESH_RELAY = "https:\/\/relay\.example\.com";/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-pages.mjs'], { stdio: 'pipe', env: { ...process.env, CODEFRESH_RELAY_URL: 'http://relay.example.com' } }));
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { stdio: 'pipe', env: { ...process.env, CODEFRESH_RELAY_URL: '' } });
  assert.match(await readFile('dist/config.js', 'utf8'), /window\.CODEFRESH_RELAY = "";/);
  await access('dist/lib/providers/request.mjs');
  const html = await readFile('dist/index.html', 'utf8');
  assert.ok(html.indexOf('config.js') < html.indexOf('app.js'));
});
