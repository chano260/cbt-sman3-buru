// Formulir Buat jadwal ujian: kotak cari untuk daftar mata pelajaran / bank soal guru,
// supaya operator tidak perlu menggulir daftar panjang.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');

function loadFn(name) {
  const a = html.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${name} ada`);
  const end = html.indexOf('\n    }\n', a) + 6;
  const norm = html.slice(html.indexOf('function normSearch('), html.indexOf('\n    }\n', html.indexOf('function normSearch(')) + 6);
  return new Function(`${norm}\n${html.slice(a, end)}; return ${name};`)();
}

test('kotak cari ada di atas pilihan mata pelajaran', () => {
  const form = html.slice(html.indexOf('Buat jadwal ujian'), html.indexOf('id="subjectStatusBanner"'));
  assert.match(form, /id="exSubjectSearch"/);
  assert.match(form, /oninput="filterSubjectOptions\(\)"/);
  assert.ok(form.indexOf('id="exSubjectSearch"') < form.indexOf('id="exSubjectSelect"'));
});

test('pencarian cocok dengan mapel, nama paket, atau guru; tanpa beda huruf besar/kecil', () => {
  const buildSubjectOptions = loadFn('buildSubjectOptions');
  const exams = [
    { id: 1, subject: 'Kimia', title: 'ASAS Kimia', teacher_name: 'Ibu Siti', total_questions: 7, pg_count: 5, esai_count: 2 },
    { id: 2, subject: 'Matematika', title: 'ASAS Matematika Wajib', teacher_name: 'Pak Ahmad', total_questions: 0 },
    { id: 3, subject: 'Matematika Lanjut', title: 'PAS', teacher_name: 'Pak Budi', total_questions: 20, pg_count: 20, esai_count: 0 }
  ];
  const teachers = [{ subject: 'Kimia', full_name: 'Ibu Siti' }, { subject: 'Ekonomi', full_name: 'Ibu Rina' }];
  const values = (q) => buildSubjectOptions(exams, teachers, q).filter(o => !o.fixed).map(o => o.value);

  assert.deepEqual(values(''), ['exam:1', 'exam:2', 'exam:3', 'subj:Kimia', 'subj:Ekonomi']);
  assert.deepEqual(values('matematika'), ['exam:2', 'exam:3']);
  assert.deepEqual(values('mat lanjut'), ['exam:3'], 'semua kata harus cocok');
  assert.deepEqual(values('BUDI'), ['exam:3'], 'cari nama guru');
  assert.deepEqual(values('ekonomi'), ['subj:Ekonomi']);
  assert.deepEqual(values('fisika'), []);
  // "Ketik mata pelajaran baru" selalu ada
  assert.ok(buildSubjectOptions(exams, teachers, 'fisika').some(o => o.value === 'CUSTOM'));
});

test('saat mencari daftar tampil terbuka; Enter memilih hasil pertama; Jadwalkan dari Bank soal mengosongkan pencarian', () => {
  const fn = html.slice(html.indexOf('function filterSubjectOptions('), html.indexOf('function filterSubjectOptions(') + 1600);
  assert.match(fn, /\.size\s*=/, 'select menjadi daftar terbuka saat ada kata cari');
  assert.match(html, /function pickFirstSubjectMatch\(/);
  assert.match(html, /onkeydown="if \(event\.key === 'Enter'\)/);
  const sched = html.slice(html.indexOf('function scheduleBank('), html.indexOf('function scheduleBank(') + 600);
  assert.match(sched, /exSubjectSearch/);
});
