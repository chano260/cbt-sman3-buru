// Opsi jawaban PG boleh berupa gambar (mis. tabel persamaan akuntansi di soal Ekonomi):
// "A. <gambar>" di Word disimpan sebagai gambar opsi A, bukan menimpa gambar soal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseQuestionsFromText } = require('../src/wordParser');
const { renderOptionHtml } = require('../public/math-render');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

const IMG = (n) => `data:image/png;base64,OPT${n}`;

test('Word: opsi yang hanya berisi gambar terbaca sebagai gambar opsi', () => {
  const text = [
    '[PG]',
    '21. Pencatatan pada persamaan akuntansi adalah…',
    'A.', `IMG_DATA:${IMG('A')}`,
    'B.', `IMG_DATA:${IMG('B')}`,
    'C.', `IMG_DATA:${IMG('C')}`,
    'D.', `IMG_DATA:${IMG('D')}`,
    'E.', `IMG_DATA:${IMG('E')}`,
    'KUNCI: C'
  ].join('\n');
  const [q] = parseQuestionsFromText(text);
  assert.equal(q.question_text, 'Pencatatan pada persamaan akuntansi adalah…');
  assert.equal(q.image_data, null, 'gambar opsi tidak dipakai sebagai gambar soal');
  assert.deepEqual(q.option_images, { A: IMG('A'), B: IMG('B'), C: IMG('C'), D: IMG('D'), E: IMG('E') });
  assert.equal(q.answer_key, 'C');
});

test('Word: gambar soal dan gambar opsi dalam satu soal tetap terpisah', () => {
  const text = [
    '22. Perhatikan gambar berikut!', `IMG_DATA:${IMG('Q')}`,
    'A.', `IMG_DATA:${IMG('A')}`,
    'B. Jawaban teks', `IMG_DATA:${IMG('B')}`,
    'C. Teks saja',
    'D.', `IMG_DATA:${IMG('D')}`,
    'E.', `IMG_DATA:${IMG('E')}`,
    'KUNCI: B',
    '23. Soal biasa', 'A. satu', 'B. dua', 'C. tiga', 'D. empat', 'E. lima', 'KUNCI: A'
  ].join('\n');
  const [q, next] = parseQuestionsFromText(text);
  assert.equal(q.question_text, 'Perhatikan gambar berikut!');
  assert.equal(q.image_data, IMG('Q'));
  assert.equal(q.option_b, 'Jawaban teks');
  assert.equal(q.option_c, 'Teks saja');
  assert.deepEqual(q.option_images, { A: IMG('A'), B: IMG('B'), D: IMG('D'), E: IMG('E') });
  assert.equal(next.option_images, null, 'soal tanpa gambar opsi');
  assert.equal(next.option_a, 'satu');
});

test('tampilan opsi: teks + gambar, hanya sumber gambar yang aman', () => {
  const html = renderOptionHtml('Jawaban', IMG('A'));
  assert.match(html, /Jawaban/);
  assert.match(html, /<img class="opt-img" src="data:image\/png;base64,OPTA"/);
  assert.match(renderOptionHtml('', '/uploads/img_1.png'), /src="\/uploads\/img_1\.png"/);
  assert.doesNotMatch(renderOptionHtml('x', 'javascript:alert(1)'), /<img/);
  assert.doesNotMatch(renderOptionHtml('x', '" onerror="alert(1)'), /<img/);
  assert.equal(renderOptionHtml('x²', null), renderOptionHtml('x²'));
});

async function setup(t) {
  const db = initDb(':memory:');
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base };
}

test('database: kolom gambar opsi ada, ikut tersalin, dan dikirim ke layar ujian', async (t) => {
  const { db, base } = await setup(t);
  const cols = db.prepare('PRAGMA table_info(questions)').all().map(c => c.name);
  assert.ok(cols.includes('option_images'));

  const exam = db.prepare('SELECT * FROM exams WHERE is_active = 1 ORDER BY id LIMIT 1').get();
  const q = db.prepare("SELECT * FROM questions WHERE exam_id = ? AND type = 'PG' ORDER BY id LIMIT 1").get(exam.id);
  db.prepare('UPDATE questions SET option_images = ? WHERE id = ?').run(JSON.stringify({ A: IMG('A') }), q.id);

  // Ujian: login siswa kelas ujian lalu ambil soal
  const student = db.prepare('SELECT * FROM students LIMIT 1').get();
  const login = await fetch(`${base}/api/ujian/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam_number: student.exam_number, password: student.password, token: exam.token })
  }).then(r => r.json());
  assert.ok(login.sessionId, JSON.stringify(login));
  const sess = await fetch(`${base}/api/ujian/session/${login.sessionId}`, {
    headers: { 'X-Session-Token': login.sessionToken || '' }
  }).then(r => r.json());
  const sent = sess.questions.find(x => x.id === q.id);
  assert.deepEqual(sent.option_images, { A: IMG('A') }, 'layar ujian menerima gambar opsi sebagai objek');
});

test('impor Word menyimpan gambar opsi', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const imp = src.slice(src.indexOf("'/api/guru/exams/:id/import-word'"), src.indexOf('importTx();'));
  assert.match(imp, /option_images/);
  const copy = src.slice(src.indexOf('function copyQuestions('), src.indexOf('function copyQuestions(') + 1200);
  assert.match(copy, /option_images/);
});

test('layar ujian, pratinjau guru & operator memakai renderOptionHtml', () => {
  const ujian = fs.readFileSync(path.join(__dirname, '..', 'public', 'ujian.html'), 'utf8');
  const guru = fs.readFileSync(path.join(__dirname, '..', 'public', 'guru.html'), 'utf8');
  const operator = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
  for (const html of [ujian, guru, operator]) assert.match(html, /renderOptionHtml\(/);
  // Opsi yang hanya bergambar (teks kosong) tetap ditampilkan di layar ujian
  assert.match(ujian, /optionImage\(q, letter\)|optionImage\(q, '[A-E]'\)/);
});
