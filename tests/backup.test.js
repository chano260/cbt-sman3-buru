const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initDb } = require('../src/db');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbt-backup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function backupFiles(dir) {
  return fs.readdirSync(dir).filter(f => /^cbt-backup-\d{8}-\d{6}(-\d+)?\.db$/.test(f)).sort();
}

test('backup: membuat folder & salinan utuh berisi data terbaru (mode WAL)', (t) => {
  const { createBackup } = require('../src/backup');
  const dir = tmpDir(t);
  const db = initDb(path.join(dir, 'asli.db'));
  db.prepare("INSERT INTO users (username, password, full_name, role) VALUES ('baru_saja', 'x', 'Data Terbaru', 'guru')").run();

  const outDir = path.join(dir, 'backups');
  const file = createBackup(db, outDir);
  assert.ok(fs.existsSync(file));
  assert.match(path.basename(file), /^cbt-backup-\d{8}-\d{6}(-\d+)?\.db$/);

  const copy = initDb(file);
  const row = copy.prepare("SELECT full_name FROM users WHERE username = 'baru_saja'").get();
  copy.close();
  db.close();
  assert.equal(row.full_name, 'Data Terbaru');
});

test('backup: dua backup beruntun tidak saling menimpa', (t) => {
  const { createBackup } = require('../src/backup');
  const dir = tmpDir(t);
  const db = initDb(':memory:');
  const a = createBackup(db, dir);
  const b = createBackup(db, dir);
  assert.notEqual(a, b);
  assert.equal(backupFiles(dir).length, 2);
});

test('backup: rotasi hanya menyisakan N terbaru dan tidak menyentuh file lain', (t) => {
  const { createBackup } = require('../src/backup');
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'catatan.txt'), 'jangan dihapus');
  const db = initDb(':memory:');
  const made = [];
  for (let i = 0; i < 5; i++) made.push(path.basename(createBackup(db, dir, { keep: 3 })));
  assert.deepEqual(backupFiles(dir), made.slice(-3).sort());
  assert.ok(fs.existsSync(path.join(dir, 'catatan.txt')));
});

test('backup: status folder kosong lalu terisi', (t) => {
  const { createBackup, backupStatus } = require('../src/backup');
  const dir = tmpDir(t);
  assert.deepEqual(backupStatus(path.join(dir, 'belum-ada')), { last: null, count: 0 });
  createBackup(initDb(':memory:'), dir);
  const st = backupStatus(dir);
  assert.equal(st.count, 1);
  assert.ok(!Number.isNaN(Date.parse(st.last)));
});

test('backup: penjadwal membuat backup dan bisa dihentikan', async (t) => {
  const { startBackupSchedule } = require('../src/backup');
  const dir = tmpDir(t);
  const sched = startBackupSchedule(initDb(':memory:'), dir, { firstDelayMs: 10, intervalMs: 1000 });
  await new Promise(r => setTimeout(r, 100));
  sched.stop();
  assert.equal(backupFiles(dir).length, 1);
});

async function serve(t) {
  const { createApp } = require('../src/app');
  const dir = tmpDir(t);
  const db = initDb(':memory:');
  const server = createApp(db, { backupDir: dir, enforceDefaultPasswordChange: false }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => {
    const r = await fetch(`${base}/api/staff/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
    }).then(r => r.json());
    return { Authorization: `Bearer ${r.staffToken}` };
  };
  return { base, dir, login };
}

test('backup API: status hanya untuk operator', async (t) => {
  const { base, login } = await serve(t);
  assert.equal((await fetch(`${base}/api/operator/backup/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/operator/backup/status`, { headers: await login('guru', 'guru123') })).status, 403);
  const ok = await fetch(`${base}/api/operator/backup/status`, { headers: await login('operator', 'admin123') });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { last: null, count: 0 });
});

test('backup API: operator mengunduh file SQLite yang utuh', async (t) => {
  const { base, dir, login } = await serve(t);
  assert.equal((await fetch(`${base}/api/operator/backup/download`, { headers: await login('pengawas', 'pengawas123') })).status, 403);
  const res = await fetch(`${base}/api/operator/backup/download`, { headers: await login('operator', 'admin123') });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /cbt-backup-\d{8}-\d{6}/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal(backupFiles(dir).length, 1);
});
