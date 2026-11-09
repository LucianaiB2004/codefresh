import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionManager, STATUS } from '../src/credentials.mjs';

function mgr(results) {
  const calls = [];
  const m = createConnectionManager({ testFn: async (method) => { calls.push(method); return results[method]; } });
  return { m, calls };
}
const OK = (method) => ({ ok: true, message: `ok ${method}`, requestId: 'r' });
const FAIL = { ok: false, code: 'UnauthorizedOperation', message: 'bad' };

test('只有 A：只测试 A', async () => {
  const { m, calls } = mgr({ 'api-key': OK('a') });
  m.setCredentials('api-key', { apiKey: 'k' });
  assert.equal(await m.autoSelect(), 'api-key');
  assert.deepEqual(calls, ['api-key']);
});

test('只有 B：只测试 B', async () => {
  const { m, calls } = mgr({ aksk: OK('b') });
  m.setCredentials('aksk', { secretId: 'AKID', secretKey: 's' });
  assert.equal(await m.autoSelect(), 'aksk');
  assert.deepEqual(calls, ['aksk']);
});

test('两套都填，A 成功：优先 A，不多调用 B', async () => {
  const { m, calls } = mgr({ 'api-key': OK('a'), aksk: OK('b') });
  m.setCredentials('api-key', { apiKey: 'k' });
  m.setCredentials('aksk', { secretId: 'AKID', secretKey: 's' });
  assert.equal(await m.autoSelect(), 'api-key');
  assert.deepEqual(calls, ['api-key']);
});

test('两套都填，A 失败 B 成功：选用 B，A 的输入保留不要求重填', async () => {
  const { m } = mgr({ 'api-key': FAIL, aksk: OK('b') });
  m.setCredentials('api-key', { apiKey: 'k' });
  m.setCredentials('aksk', { secretId: 'AKID', secretKey: 's' });
  assert.equal(await m.autoSelect(), 'aksk');
  const s = m.snapshot();
  assert.equal(s.active, 'aksk');
  assert.equal(s['api-key'].status, STATUS.FAIL);
  assert.equal(s['api-key'].configured, true);
});

test('两套都无效：明确错误，绝不显示连接成功', async () => {
  const { m } = mgr({ 'api-key': FAIL, aksk: FAIL });
  m.setCredentials('api-key', { apiKey: 'k' });
  m.setCredentials('aksk', { secretId: 'AKID', secretKey: 's' });
  assert.equal(await m.autoSelect(), null);
  const s = m.snapshot();
  assert.equal(s.active, null);
  assert.equal(s['api-key'].status, STATUS.FAIL);
  assert.equal(s.aksk.code, 'UnauthorizedOperation');
});

test('testFn 抛异常（网络）也不会误判成功', async () => {
  const m = createConnectionManager({ testFn: async () => { throw new Error('x'); } });
  m.setCredentials('api-key', { apiKey: 'k' });
  const r = await m.test('api-key');
  assert.equal(r.ok, false);
  assert.equal(m.active, null);
});

test('凭据改变后 active 失效；清除凭据后内存为空', async () => {
  const { m } = mgr({ 'api-key': OK('a') });
  m.setCredentials('api-key', { apiKey: 'k' });
  await m.test('api-key');
  assert.equal(m.active, 'api-key');
  m.setCredentials('api-key', { apiKey: 'k2' });
  assert.equal(m.active, null, '改了凭据必须重新测试');
  await m.test('api-key');
  m.clear();
  assert.equal(m.active, null);
  assert.equal(m.credentialsFor('api-key'), null);
  assert.equal(m.snapshot()['api-key'].configured, false);
});

test('认证失败上报：取消 active，不自动切换另一套', async () => {
  const { m, calls } = mgr({ 'api-key': OK('a'), aksk: OK('b') });
  m.setCredentials('api-key', { apiKey: 'k' });
  m.setCredentials('aksk', { secretId: 'AKID', secretKey: 's' });
  await m.autoSelect();
  m.reportAuthFailure('api-key', { code: 'UnauthorizedOperation' });
  assert.equal(m.active, null);
  assert.deepEqual(calls, ['api-key']);
});

test('模块源码不使用任何浏览器持久化存储', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const f of ['src/credentials.mjs', 'public/app.js']) {
    const src = (await readFile(new URL(`../${f}`, import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie|indexedDB/, f);
  }
});
