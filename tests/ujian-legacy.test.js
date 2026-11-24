const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// HP Android lama dengan WebView yang jarang diperbarui tidak mengenal sintaks JavaScript baru.
// Satu sintaks yang tidak dikenal membuat SELURUH script halaman ujian gagal (layar kosong).
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'ujian.html'), 'utf8');
const scripts = (html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || []).join('\n');

function findAll(re) {
  const out = [];
  scripts.split('\n').forEach((line, i) => { if (re.test(line)) out.push(`${i + 1}: ${line.trim()}`); });
  return out;
}

test('ujian.html: tanpa optional chaining (?.) — butuh WebView 80+', () => {
  assert.deepEqual(findAll(/\?\.[A-Za-z_$(\[]/), []);
});

test('ujian.html: tanpa nullish coalescing (??) — butuh WebView 80+', () => {
  assert.deepEqual(findAll(/\?\?/), []);
});

test('ujian.html: tanpa catch tanpa variabel (catch {) — butuh WebView 66+', () => {
  assert.deepEqual(findAll(/catch\s*\{/), []);
});

test('ujian.html: menyediakan hook keluar oleh pengawas untuk aplikasi Android', () => {
  assert.match(scripts, /window\.cbtSupervisorExit\s*=/);
  assert.match(scripts, /\/api\/ujian\/supervisor-exit/);
  assert.match(scripts, /__cbtExiting/);
});
