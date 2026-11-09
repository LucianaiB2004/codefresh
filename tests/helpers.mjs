export function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await handler(String(url), init, calls.length);
    if (r instanceof Error) throw r;
    const { status = 200, json, text, headers = {} } = r;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => { if (json === undefined) throw new Error('no json'); return json; },
      text: async () => (text ?? JSON.stringify(json)),
    };
  };
  fn.calls = calls;
  return fn;
}
export const okSearch = (pages = [JSON.stringify({ title: 'OpenClaw docs', url: 'https://docs.openclaw.ai/install', date: '2026/10/06 00:00:00', passage: 'install', site: 'OpenClaw文档' })]) => ({
  status: 200, json: { Response: { RequestId: 'req-ok-1', Query: 'q', Version: 'lite', Pages: pages } },
});
export const errSearch = (code, status = 200) => ({ status, json: { Response: { RequestId: 'req-err-1', Error: { Code: code, Message: 'upstream message' } } } });
