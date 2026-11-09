// 仅内存的连接状态管理（浏览器 / Node 通用）。
// 规则：只填 A 测 A；只填 B 测 B；都填按 A → B，第一个真实成功者为 activeProvider；
// 已验证的 activeProvider 在本页内复用，不会每次查询重复测试两套凭据；
// 绝不写 localStorage / sessionStorage / cookie / URL。

export const STATUS = { EMPTY: 'empty', PENDING: 'pending', TESTING: 'testing', OK: 'ok', FAIL: 'fail' };

export function hasCredentials(method, c) {
  if (!c) return false;
  if (c.source === 'env') return true;
  if (method === 'api-key') return typeof c.apiKey === 'string' && c.apiKey.trim().length > 0;
  if (method === 'aksk') return typeof c.secretId === 'string' && c.secretId.trim().length > 0
    && typeof c.secretKey === 'string' && c.secretKey.trim().length > 0;
  return false;
}

export function createConnectionManager({ testFn, onChange = () => {} } = {}) {
  if (typeof testFn !== 'function') throw new Error('testFn required');
  let creds = { 'api-key': null, aksk: null };
  let state = {
    'api-key': { status: STATUS.EMPTY, message: null, code: null, requestId: null },
    aksk: { status: STATUS.EMPTY, message: null, code: null, requestId: null },
  };
  let active = null;
  const emit = () => onChange(snapshot());

  function snapshot() {
    return {
      active,
      'api-key': { ...state['api-key'], configured: hasCredentials('api-key', creds['api-key']) },
      aksk: { ...state.aksk, configured: hasCredentials('aksk', creds.aksk) },
    };
  }

  function setCredentials(method, c) {
    creds[method] = c ? { ...c } : null;
    state[method] = { status: hasCredentials(method, c) ? STATUS.PENDING : STATUS.EMPTY, message: null, code: null, requestId: null };
    if (active === method) active = null; // 凭据变化后必须重新测试
    emit();
  }

  async function test(method) {
    if (!hasCredentials(method, creds[method])) {
      state[method] = { status: STATUS.EMPTY, message: '尚未填写', code: 'MissingCredentials', requestId: null };
      emit();
      return { ok: false, code: 'MissingCredentials' };
    }
    state[method] = { ...state[method], status: STATUS.TESTING };
    emit();
    let r;
    try { r = await testFn(method, creds[method]); } catch (e) { r = { ok: false, code: 'NetworkError', message: '无法连接本地服务' }; }
    if (r && r.ok === true) {
      state[method] = { status: STATUS.OK, message: r.message, code: null, requestId: r.requestId || null };
      active = method;
    } else {
      state[method] = { status: STATUS.FAIL, message: r?.message || '连接失败', code: r?.code || 'UnknownError', requestId: r?.requestId || null };
      if (active === method) active = null;
    }
    emit();
    return r;
  }

  // 自动检测：A → B，第一个成功即停止，不再调用后者
  async function autoSelect() {
    const order = ['api-key', 'aksk'].filter((m) => hasCredentials(m, creds[m]));
    for (const m of order) {
      const r = await test(m);
      if (r && r.ok) return m;
    }
    return null;
  }

  function use(method) {
    if (state[method].status === STATUS.OK) { active = method; emit(); return true; }
    return false;
  }

  function credentialsFor(method = active) { return method ? creds[method] : null; }

  // 当前凭据认证失败：标记失败、取消 active，交由用户决定是否切换（不自动重试其他凭据）
  function reportAuthFailure(method, info = {}) {
    state[method] = { status: STATUS.FAIL, message: info.message || '认证失败', code: info.code || 'UnauthorizedOperation', requestId: info.requestId || null };
    if (active === method) active = null;
    emit();
  }

  function clear() {
    creds = { 'api-key': null, aksk: null };
    state['api-key'] = { status: STATUS.EMPTY, message: null, code: null, requestId: null };
    state.aksk = { status: STATUS.EMPTY, message: null, code: null, requestId: null };
    active = null;
    emit();
  }

  return { setCredentials, test, autoSelect, use, credentialsFor, reportAuthFailure, clear, snapshot, get active() { return active; } };
}
