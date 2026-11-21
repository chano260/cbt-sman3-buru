// Meniru perilaku public/ujian.html: menyimpan sessionToken dari respons login siswa
// lalu menyertakannya sebagai header X-Session-Token pada request /api/ujian/* untuk sesi tersebut.
// Hanya dipakai oleh tes alur lama; tests/security.test.js sengaja memakai fetch mentah.
const tokens = new Map();
const realFetch = globalThis.fetch;

function extractSessionId(url, body) {
  const m = String(url).match(/\/api\/ujian\/session\/(\d+)/);
  if (m) return m[1];
  if (body instanceof FormData) return body.get('sessionId');
  if (typeof body === 'string') {
    try { return JSON.parse(body).sessionId; } catch { return null; }
  }
  return null;
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/api/ujian/')) {
    const sid = extractSessionId(u, opts.body);
    if (sid != null && tokens.has(String(sid))) {
      const headers = { ...(opts.headers || {}) };
      if (!headers['X-Session-Token']) headers['X-Session-Token'] = tokens.get(String(sid));
      opts = { ...opts, headers };
    }
  }
  const res = await realFetch(url, opts);
  if (/\/api\/ujian\/(login|start-direct)$/.test(u.split('?')[0])) {
    const clone = res.clone();
    try {
      const data = await clone.json();
      if (data && data.sessionId && data.sessionToken) tokens.set(String(data.sessionId), data.sessionToken);
    } catch {}
  }
  return res;
};

module.exports = { sessionTokens: tokens };
