const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');

test('initDb creates tables and seeds default SMAN 3 Buru accounts, students, and exam', () => {
  const db = initDb(':memory:');
  const operator = db.prepare("SELECT * FROM users WHERE role = 'operator'").get();
  const guru = db.prepare("SELECT * FROM users WHERE role = 'guru'").get();
  const pengawas = db.prepare("SELECT * FROM users WHERE role = 'pengawas'").get();
  const students = db.prepare('SELECT * FROM students').all();
  const questions = db.prepare('SELECT * FROM questions').all();

  assert.equal(operator.username, 'operator');
  assert.equal(guru.username, 'guru');
  assert.equal(pengawas.username, 'pengawas');
  assert.ok(students.length >= 5);
  assert.ok(questions.some(q => q.type === 'PG'));
  assert.ok(questions.some(q => q.type === 'ESAI'));
});
