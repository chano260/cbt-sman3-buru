// Di Safe Exam Browser bilah navigasi soal (‹ 1/4 ›) ikut tergulir bersama soal, padahal memakai
// position: fixed. Tata letak tidak lagi bergantung pada fixed: layar ujian setinggi jendela, hanya
// area soal yang bergulir, dan bilah navigasi berada di bawahnya sebagai elemen biasa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'ujian.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

test('layar ujian: area soal bergulir sendiri, bilah navigasi di luar area itu', () => {
  const screen = html.slice(html.indexOf('id="screenExam"'), html.indexOf('MODAL: JAWABAN BELUM LENGKAP'));
  assert.match(screen, /class="exam-screen"/);
  const scrollAt = screen.indexOf('id="examScroll"');
  const cardAt = screen.indexOf('id="activeQuestionCard"');
  const navAt = screen.indexOf('<footer class="exambppp-bottom-nav"');
  assert.ok(scrollAt > 0 && cardAt > scrollAt, 'kartu soal ada di dalam area gulir');
  const scrollClose = screen.indexOf('</main>', cardAt);
  assert.ok(scrollClose > cardAt && navAt > scrollClose, 'bilah navigasi sesudah area gulir ditutup');
  assert.doesNotMatch(screen.slice(0, 200), /padding-bottom:80px/, 'tidak perlu ruang kosong untuk bilah fixed');
});

test('layar ujian setinggi jendela dan tidak memakai position fixed untuk bilah navigasi', () => {
  assert.match(css, /\.exam-screen\s*\{[^}]*height:\s*100dvh/);
  assert.match(css, /\.exam-screen\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.exam-screen \.exam-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.exam-screen \.exambppp-bottom-nav\s*\{[^}]*position:\s*static/);
  assert.match(html, /s === 'screenExam' \? 'flex' : 'block'/, 'showScreen menampilkan layar ujian sebagai flex');
});

test('pindah soal menggulir area soal kembali ke atas', () => {
  assert.match(html, /function scrollQuestionToTop\(/);
  for (const fn of ['jumpToQuestion', 'prevQuestion', 'nextQuestion']) {
    const body = html.slice(html.indexOf(`function ${fn}(`), html.indexOf('}\n', html.indexOf(`function ${fn}(`) + 40) + 40);
    assert.match(body, /scrollQuestionToTop\(\)/, `${fn} menggulir ke atas`);
  }
});
