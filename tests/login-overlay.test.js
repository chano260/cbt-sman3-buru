const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

function functionBody(src, name) {
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `fungsi ${name} harus ada`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  throw new Error(`body ${name} tidak lengkap`);
}

// Bug: setelah refresh, token staf di sessionStorage masih berlaku dan data ter-load,
// tetapi kotak login tetap menutupi panel karena hanya tombol "Masuk" yang menyembunyikannya.
const PANELS = [
  ['operator.html', 'loadOverview'],
  ['guru.html', 'loadExams'],
  ['pengawas.html', 'loadRoomData']
];

for (const [page, loader] of PANELS) {
  test(`${page}: ${loader}() menutup kotak login bila token tersimpan masih berlaku`, () => {
    const body = functionBody(read(page), loader);
    const authCheck = body.search(/res\.status === 401|!res\.ok/);
    assert.ok(authCheck >= 0, `${loader} harus memeriksa respons tidak sah`);
    const hide = body.search(/getElementById\('loginOverlay'\)\.style\.display\s*=\s*'none'/);
    assert.ok(hide >= 0, `${loader} harus menyembunyikan #loginOverlay setelah data berhasil dimuat`);
    assert.ok(hide > authCheck, `${loader}: kotak login baru boleh ditutup SETELAH respons dipastikan sah`);
  });
}
