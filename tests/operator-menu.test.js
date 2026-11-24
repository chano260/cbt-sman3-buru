const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'operator.html'), 'utf8');
const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
const section = (id) => {
  const start = html.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `section ${id} harus ada`);
  return html.slice(start, html.indexOf('</section>', start));
};

test('menu operator: Jadwal, Bank soal masuk, Akun guru, Akun pengawas, dan Akun operator terpisah', () => {
  for (const [tab, label] of [
    ['tab-exams', 'Jadwal & sesi ujian'],
    ['tab-banks', 'Bank soal masuk'],
    ['tab-staff-guru', 'Akun guru'],
    ['tab-staff-pengawas', 'Akun pengawas'],
    ['tab-staff-operator', 'Akun operator']
  ]) {
    assert.match(aside, new RegExp(`switchTab\\('${tab}', this\\)[^>]*>[\\s\\S]*?<span>${label}</span>`), `menu ${label}`);
  }
  assert.doesNotMatch(aside, /Akun guru & pengawas/, 'menu gabungan lama sudah tidak ada');
});

test('Jadwal & sesi ujian hanya untuk jadwal; urusan soal pindah ke Bank soal masuk', () => {
  const jadwal = section('tab-exams');
  assert.match(jadwal, /id="examsTableBody"/);
  const banks = section('tab-banks');
  assert.match(banks, /id="banksTableBody"/);
  // Tombol soal tidak lagi dibuat di tabel jadwal
  const renderJadwal = html.slice(html.indexOf("getElementById('examsTableBody').innerHTML"), html.indexOf("getElementById('banksTableBody').innerHTML"));
  assert.ok(renderJadwal.length > 0, 'tabel jadwal dirender sebelum tabel bank soal');
  assert.doesNotMatch(renderJadwal, /openPreviewQuestionsModal|openUploadWordModal|openCopyQuestionsModal/);
  const renderBanks = html.slice(html.indexOf("getElementById('banksTableBody').innerHTML"));
  assert.match(renderBanks, /openPreviewQuestionsModal/);
  assert.match(renderBanks, /openUploadWordModal/);
  assert.match(renderBanks, /openCopyQuestionsModal/);
});

test('akun dipisah per peran: tiap menu punya tabel sendiri', () => {
  assert.match(section('tab-staff-guru'), /id="staffGuruBody"/);
  assert.match(section('tab-staff-pengawas'), /id="staffPengawasBody"/);
  assert.match(section('tab-staff-operator'), /id="staffOperatorBody"/);
  assert.match(html, /u\.role === 'guru'[\s\S]*staffGuruBody|staffGuruBody[\s\S]*role === 'guru'/);
  // Formulir tambah akun memakai peran dari menu yang sedang dibuka
  assert.match(html, /function placeStaffForms\(role\)/);
});

test('kotak cari di setiap daftar dan penyaringan langsung saat mengetik', () => {
  for (const [input, body] of [
    ['studentSearch', 'studentsTableBody'],
    ['examSearch', 'examsTableBody'],
    ['bankSearch', 'banksTableBody'],
    ['staffGuruSearch', 'staffGuruBody'],
    ['staffPengawasSearch', 'staffPengawasBody'],
    ['staffOperatorSearch', 'staffOperatorBody']
  ]) {
    assert.match(html, new RegExp(`id="${input}"[^>]*oninput="filterTable\\('${input}', '${body}'\\)"`), `cari untuk ${body}`);
  }
  assert.match(html, /function filterTable\(inputId, tbodyId\)/);
  assert.match(html, /function applyAllSearches\(\)/);
});
