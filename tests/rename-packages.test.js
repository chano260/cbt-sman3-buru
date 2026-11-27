// Operator mengganti nama banyak paket ujian sekaligus (cari & ganti teks di nama paket).
// Hanya nama paket yang berubah: soal, token, jadwal, dan nilai tetap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initDb } = require('../src/db');
const { createApp, replaceTitleText } = require('../src/app');

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
  const op = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.staffToken}` };
  const rename = (body, headers = op) => fetch(`${base}/api/operator/exams/rename-titles`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  // Data contoh hanya punya satu paket: tambah dua salinan (beserta soalnya) untuk uji massal
  const first = db.prepare('SELECT * FROM exams ORDER BY id LIMIT 1').get();
  for (const subject of ['Fisika', 'Biologi']) {
    const id = db.prepare(`INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at, shuffle_questions, is_active, teacher_id, is_scheduled)
      SELECT title, ?, class_target, exam_date, start_time, session_name, duration_minutes, ?, token_updated_at, shuffle_questions, 0, teacher_id, is_scheduled FROM exams WHERE id = ?`)
      .run(subject, `TK${subject.slice(0, 3).toUpperCase()}`, first.id).lastInsertRowid;
    const cols = db.prepare('PRAGMA table_info(questions)').all().map(c => c.name).filter(c => c !== 'id' && c !== 'exam_id');
    db.prepare(`INSERT INTO questions (exam_id, ${cols.join(', ')}) SELECT ?, ${cols.join(', ')} FROM questions WHERE exam_id = ?`).run(id, first.id);
  }
  return { db, rename };
}

test('replaceTitleText: ganti semua kemunculan, tanpa beda huruf besar/kecil', () => {
  assert.equal(replaceTitleText('ASAS Matematika Ganjil', 'ASAS', 'PAS'), 'PAS Matematika Ganjil');
  assert.equal(replaceTitleText('asas Kimia', 'ASAS', 'PAS'), 'PAS Kimia');
  assert.equal(replaceTitleText('Ujian 2025 (2025)', '2025', '2026'), 'Ujian 2026 (2026)');
  assert.equal(replaceTitleText('Nilai a+b', 'a+b', 'x'), 'Nilai x', 'teks dicari apa adanya, bukan regex');
  assert.equal(replaceTitleText('Fisika', 'ASAS', 'PAS'), 'Fisika');
  assert.equal(replaceTitleText('ASAS  Fisika ', 'ASAS', ''), 'Fisika', 'spasi berlebih dirapikan');
});

test('ganti nama banyak paket sekaligus: hanya nama yang berubah, soal tetap', async (t) => {
  const { db, rename } = await setup(t);
  const exams = db.prepare('SELECT * FROM exams ORDER BY id').all();
  assert.ok(exams.length >= 2, 'data contoh punya minimal 2 paket');
  const [a, b] = exams;
  db.prepare("UPDATE exams SET title = 'ASAS Ganjil 2025' WHERE id IN (?, ?)").run(a.id, b.id);
  const countQ = (id) => db.prepare('SELECT COUNT(*) AS n FROM questions WHERE exam_id = ?').get(id).n;
  const before = { a: countQ(a.id), b: countQ(b.id) };

  const res = await rename({ exam_ids: [a.id, b.id], find: 'ASAS', replace: 'PAS' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.renamed, 2);

  for (const e of [a, b]) {
    const now = db.prepare('SELECT * FROM exams WHERE id = ?').get(e.id);
    assert.equal(now.title, 'PAS Ganjil 2025');
    assert.equal(now.subject, e.subject);
    assert.equal(now.class_target, e.class_target);
    assert.equal(now.token, e.token);
    assert.equal(now.is_active, e.is_active);
    assert.equal(now.exam_date, e.exam_date);
  }
  assert.deepEqual({ a: countQ(a.id), b: countQ(b.id) }, before, 'jumlah soal tidak berubah');
});

test('paket yang tidak dicentang atau tidak memuat teks tidak diubah', async (t) => {
  const { db, rename } = await setup(t);
  const [a, b, c] = db.prepare('SELECT * FROM exams ORDER BY id').all();
  db.prepare("UPDATE exams SET title = 'ASAS A' WHERE id = ?").run(a.id);
  db.prepare("UPDATE exams SET title = 'Ulangan B' WHERE id = ?").run(b.id);
  if (c) db.prepare("UPDATE exams SET title = 'ASAS C' WHERE id = ?").run(c.id);

  const data = await rename({ exam_ids: [a.id, b.id], find: 'ASAS', replace: 'PAS' }).then(r => r.json());
  assert.equal(data.renamed, 1);
  assert.equal(db.prepare('SELECT title FROM exams WHERE id = ?').get(a.id).title, 'PAS A');
  assert.equal(db.prepare('SELECT title FROM exams WHERE id = ?').get(b.id).title, 'Ulangan B');
  if (c) assert.equal(db.prepare('SELECT title FROM exams WHERE id = ?').get(c.id).title, 'ASAS C');
});

test('menolak teks cari kosong dan nama hasil yang kosong', async (t) => {
  const { db, rename } = await setup(t);
  const [a] = db.prepare('SELECT * FROM exams ORDER BY id').all();
  db.prepare("UPDATE exams SET title = 'ASAS' WHERE id = ?").run(a.id);

  assert.equal((await rename({ exam_ids: [a.id], find: '  ', replace: 'PAS' })).status, 400);
  const empty = await rename({ exam_ids: [a.id], find: 'ASAS', replace: '' });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /kosong/);
  assert.equal(db.prepare('SELECT title FROM exams WHERE id = ?').get(a.id).title, 'ASAS', 'tidak ada yang tersimpan');
});

test('hanya operator yang boleh mengganti nama paket massal', async (t) => {
  const { rename } = await setup(t);
  const res = await rename({ exam_ids: [1], find: 'a', replace: 'b' }, { 'Content-Type': 'application/json' });
  assert.equal(res.status, 401);
});

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');

test('menu Bank soal punya tombol & jendela ganti nama paket dengan pratinjau', () => {
  const tab = html.slice(html.indexOf('id="tab-banks"'), html.indexOf('</section>', html.indexOf('id="tab-banks"')));
  assert.match(tab, /onclick="openRenamePackagesModal\(\)"/);
  assert.match(html, /id="modalRenamePackages"/);
  assert.match(html, /id="renameFind"/);
  assert.match(html, /id="renameReplace"/);
  assert.match(html, /id="renamePreview"/);
  assert.match(html, /\/api\/operator\/exams\/rename-titles/);
});

test('pratinjau di halaman memakai aturan ganti yang sama dengan server', () => {
  const src = html.slice(html.indexOf('function replaceTitleText('), html.indexOf('function openRenamePackagesModal('));
  const fn = new Function(`${src}; return replaceTitleText;`)();
  for (const [t, f, r] of [['ASAS Matematika', 'asas', 'PAS'], ['Nilai a+b', 'a+b', 'x'], ['ASAS  Fisika ', 'ASAS', ''], ['Fisika', 'X', 'Y']]) {
    assert.equal(fn(t, f, r), replaceTitleText(t, f, r));
  }
});
