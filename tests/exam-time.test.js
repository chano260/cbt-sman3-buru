// Sesi dan jam mulai dipisah. Jam mulai kelipatan 5 menit (07.00, 07.05, 07.10, ...).
// Data lama "Sesi 1 (08:00 WIT)" dipecah otomatis menjadi sesi "Sesi 1" + jam "08:00 WIT".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeStartTime, splitSessionLabel } = require('../src/examTime');
const { initDb, splitLegacySessionNames } = require('../src/db');
const { createApp } = require('../src/app');

test('jam mulai dibakukan "HH:MM WIT" dan harus kelipatan 5 menit', () => {
  assert.equal(normalizeStartTime('07:15'), '07:15 WIT');
  assert.equal(normalizeStartTime('7.10'), '07:10 WIT');
  assert.equal(normalizeStartTime('07.00 WIT'), '07:00 WIT');
  assert.equal(normalizeStartTime('13:55 wit'), '13:55 WIT');
  assert.equal(normalizeStartTime('07:12'), null, 'bukan kelipatan 5');
  assert.equal(normalizeStartTime('24:00'), null);
  assert.equal(normalizeStartTime('pagi'), null);
});

test('label sesi lama dipecah menjadi nama sesi + jam', () => {
  assert.deepEqual(splitSessionLabel('Sesi 1 (08:00 WIT)'), { session: 'Sesi 1', time: '08:00 WIT' });
  assert.deepEqual(splitSessionLabel('Sesi 2 (10.30)'), { session: 'Sesi 2', time: '10:30 WIT' });
  assert.deepEqual(splitSessionLabel('Sesi 3'), { session: 'Sesi 3', time: null });
});

test('database lama: session_name berisi jam dipecah saat server menyala', () => {
  const db = initDb(':memory:');
  const id = db.prepare(`INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token)
    VALUES ('A', 'Kimia', 'XII IPA 1', '2030-01-01', '08:00 WIT', 'Sesi 2 (10:30 WIT)', 90, 'LGC01')`).run().lastInsertRowid;
  splitLegacySessionNames(db);
  const row = db.prepare('SELECT session_name, start_time FROM exams WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { session_name: 'Sesi 2', start_time: '10:30 WIT' });
});

async function setup(t) {
  const db = initDb(':memory:');
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'admin123', role: 'operator' })
  }).then(r => r.json());
  const post = (body) => fetch(`${base}/api/operator/exams`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.staffToken}` }, body: JSON.stringify(body)
  });
  return { db, post };
}

test('simpan jadwal: sesi & jam terpisah; jam bukan kelipatan 5 ditolak', async (t) => {
  const { db, post } = await setup(t);
  const base = { subject: 'Fisika', title: 'PAS Fisika', class_target: 'XII IPA 1', exam_date: '2030-01-01' };

  const ok = await post({ ...base, session_name: 'Sesi 2', start_time: '07:15' });
  assert.equal(ok.status, 200);
  const saved = db.prepare('SELECT session_name, start_time FROM exams WHERE id = ?').get((await ok.json()).id);
  assert.deepEqual({ ...saved }, { session_name: 'Sesi 2', start_time: '07:15 WIT' });

  const bad = await post({ ...base, session_name: 'Sesi 1', start_time: '07:12' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /kelipatan 5/);

  // Label gabungan dari aplikasi lama tetap diterima, lalu dipecah
  const legacy = await post({ ...base, subject: 'Kimia', session_name: 'Sesi 3 (10:30 WIT)' }).then(r => r.json());
  const row = db.prepare('SELECT session_name, start_time FROM exams WHERE id = ?').get(legacy.id);
  assert.deepEqual({ ...row }, { session_name: 'Sesi 3', start_time: '10:30 WIT' });
});

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');

test('formulir: pilihan Sesi dan Jam mulai terpisah, jam tiap 5 menit', () => {
  assert.match(html, /<select id="exSession"/);
  assert.match(html, /<select id="exStartTime"/);
  assert.doesNotMatch(html, /Jam mulai & sesi/);
  const a = html.indexOf('function startTimeOptions(');
  const fn = new Function(`${html.slice(a, html.indexOf('\n    }\n', a) + 6)}; return startTimeOptions;`)();
  const times = fn();
  assert.ok(times.includes('07:00') && times.includes('07:05') && times.includes('07:10') && times.includes('07:15'));
  assert.ok(!times.includes('07:12'));
  assert.ok(times.every(t => /^\d{2}:\d{2}$/.test(t) && Number(t.slice(3)) % 5 === 0));
  const create = html.slice(html.indexOf('async function createExam('), html.indexOf('async function createExam(') + 900);
  assert.match(create, /start_time: document\.getElementById\('exStartTime'\)\.value/);
});

test('daftar jadwal menampilkan jam mulai (format 07.15)', () => {
  const render = html.slice(html.indexOf('// Render tabel jadwal ujian'), html.indexOf("getElementById('banksTableBody').innerHTML"));
  assert.match(render, /formatJam\(/);
  const a = html.indexOf('function formatJam(');
  const fmt = new Function(`${html.slice(a, html.indexOf('\n    }\n', a) + 6)}; return formatJam;`)();
  assert.equal(fmt('07:15 WIT'), '07.15 WIT');
  assert.equal(fmt(''), '');
});
