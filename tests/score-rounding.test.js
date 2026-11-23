const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp, calculateExamScores, pgScore } = require('../src/app');

test('nilai PG dibulatkan ke bilangan bulat (pembulatan biasa, ,5 ke atas)', () => {
  assert.equal(pgScore(29, 30), 97);   // 96,666…
  assert.equal(pgScore(30, 35), 86);   // 85,714…
  assert.equal(pgScore(7, 40), 18);    // 17,5 tepat → naik (tanpa galat pecahan biner)
  assert.equal(pgScore(1, 3), 33);     // 33,333…
  assert.equal(pgScore(2, 3), 67);     // 66,666…
  assert.equal(pgScore(25, 25), 100);
  assert.equal(pgScore(0, 40), 0);
  assert.equal(pgScore(5, 0), 0);      // ujian tanpa soal PG
});

function seedExam(db, pgTotal, correctCount) {
  const examId = Number(db.prepare(`INSERT INTO exams (title, subject, class_target, exam_date, start_time, session_name, duration_minutes, token, token_updated_at, shuffle_questions, is_active, teacher_id)
    VALUES ('Uji Bulat', 'Matematika', 'XII IPA 1', '2026-11-23', '08:00 WIT', 'Sesi 1', 90, 'BULAT', ?, 0, 0, NULL)`).run(new Date().toISOString()).lastInsertRowid);
  const insQ = db.prepare(`INSERT INTO questions (exam_id, number, type, question_text, option_a, option_b, option_c, option_d, option_e, answer_key)
    VALUES (?, ?, 'PG', 'Soal', 'a', 'b', 'c', 'd', 'e', 'A')`);
  const qIds = [];
  for (let i = 1; i <= pgTotal; i++) qIds.push(Number(insQ.run(examId, i).lastInsertRowid));
  const st = db.prepare('SELECT id FROM students LIMIT 1').get();
  const now = new Date().toISOString();
  const sid = Number(db.prepare(`INSERT INTO exam_sessions (exam_id, student_id, status, started_at) VALUES (?, ?, 'FINISHED', ?)`).run(examId, st.id, now).lastInsertRowid);
  const insA = db.prepare('INSERT INTO answers (session_id, question_id, chosen_option, updated_at) VALUES (?, ?, ?, ?)');
  qIds.forEach((q, i) => insA.run(sid, q, i < correctCount ? 'A' : 'B', now));
  return { examId, studentId: st.id };
}

test('rekap guru & Excel memakai nilai bilangan bulat', () => {
  const db = initDb(':memory:');
  const { examId, studentId } = seedExam(db, 30, 29);
  const row = calculateExamScores(db, examId).scores.find(s => s.student_id === studentId);
  assert.equal(row.correct_pg, 29);
  assert.equal(row.score, 97);
});

test('pantauan operator memakai rumus nilai yang sama', async (t) => {
  const db = initDb(':memory:');
  const { examId, studentId } = seedExam(db, 30, 29);
  const server = createApp(db, { enforceDefaultPasswordChange: false }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const op = await fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'operator', password: 'admin123' })
  }).then(r => r.json());
  const ov = await fetch(`${base}/api/operator/overview?exam_id=${examId}`, { headers: { Authorization: `Bearer ${op.staffToken}` } }).then(r => r.json());
  const m = ov.monitoring.find(x => x.student_id === studentId);
  assert.equal(m.score, 97);
});
