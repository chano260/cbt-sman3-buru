const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

function setup(t) {
  const db = initDb(':memory:');
  const server = createApp(db, { enforceDefaultPasswordChange: false }).listen(0);
  t.after(() => server.close());
  return { db, base: `http://127.0.0.1:${server.address().port}` };
}

test('jadwal ujian publik: tanpa login, tanpa token, hanya kolom jadwal', async (t) => {
  const { base } = setup(t);
  const res = await fetch(`${base}/api/jadwal-ujian`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.jadwal) && body.jadwal.length > 0);
  const row = body.jadwal[0];
  assert.deepEqual(Object.keys(row).sort(), [
    'class_target', 'duration_minutes', 'exam_date', 'id', 'is_active', 'session_name', 'start_time', 'subject', 'title'
  ]);
  assert.equal(JSON.stringify(body).includes('token'), false);
});

test('jadwal ujian publik: draf bank soal kosong tidak tampil, yang aktif tampil paling atas', async (t) => {
  const { db, base } = setup(t);
  const ins = db.prepare(`INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at, shuffle_questions, is_active, teacher_id)
    VALUES (?, ?, 'XII IPA 2', ?, '10:00 WIT', 'Sesi 2', 60, 'ZZZZZ', ?, 1, 0, NULL)`);
  const draft = Number(ins.run('Draf Kosong', 'Biologi', '2026-12-01', new Date().toISOString()).lastInsertRowid);
  const ready = Number(ins.run('Ulangan Harian', 'Fisika', '2026-11-30', new Date().toISOString()).lastInsertRowid);
  db.prepare(`INSERT INTO questions (exam_id, number, type, question_text, option_a, option_b, option_c, option_d, option_e, answer_key)
    VALUES (?, 1, 'PG', 'Soal', 'a', 'b', 'c', 'd', 'e', 'A')`).run(ready);

  const { jadwal } = await fetch(`${base}/api/jadwal-ujian`).then(r => r.json());
  const ids = jadwal.map(j => j.id);
  assert.ok(!ids.includes(draft), 'draf tanpa soal tidak boleh tampil');
  assert.ok(ids.includes(ready), 'ujian berisi soal harus tampil');
  assert.equal(jadwal[0].is_active, 1, 'ujian aktif tampil paling atas');
});
