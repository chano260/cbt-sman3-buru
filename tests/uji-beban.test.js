const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'uji-beban.js');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out, err }));
  });
}

test('uji beban kecil: semua siswa login, menjawab, dan selesai tanpa gagal', { timeout: 90000 }, async () => {
  const port = await freePort();
  const r = await run(['--siswa', '6', '--pengawas', '2', '--menit', '0.2', '--datang', '1', '--port', String(port), '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  const summary = JSON.parse(r.out.trim().split('\n').pop());
  for (const key of ['login', 'sesi', 'jawab', 'selesai', 'pengawas_ruang']) {
    assert.ok(summary.endpoints[key] && summary.endpoints[key].count > 0, `endpoint ${key} tidak tercatat`);
  }
  assert.equal(summary.totalErrors, 0, JSON.stringify(summary.errorSamples));
  assert.equal(summary.finished, 6);
  assert.equal(summary.verdict, 'SANGGUP');
});

test('uji beban menolak berjalan bila port sudah dipakai', { timeout: 30000 }, async () => {
  const port = await freePort();
  const blocker = net.createServer().listen(port, '0.0.0.0');
  await new Promise(r => blocker.once('listening', r));
  try {
    const r = await run(['--siswa', '2', '--menit', '0.1', '--port', String(port)]);
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /sudah dipakai/);
  } finally {
    blocker.close();
  }
});

test('uji beban tidak menyediakan opsi alamat tujuan luar', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--url', 'https://cbt.smanegeri3buru.my.id'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /tidak dikenal/);
});
