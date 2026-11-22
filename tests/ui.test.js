const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

test('All 5 web interfaces load with 200 OK and no external scripts/CDN (Google Fonts allowed with system fallback)', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db, { enforceDefaultPasswordChange: false });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const page of ['/', '/operator.html', '/guru.html', '/pengawas.html', '/ujian.html']) {
    const res = await fetch(`${base}${page}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    // Keputusan pengguna (2026-11-22): server berjalan online, jadi font boleh dari Google Fonts,
    // asalkan halaman tetap berfungsi tanpa internet (font cadangan bawaan perangkat, tanpa script luar).
    assert.ok(!html.includes('https://cdn.'), `${page} must not depend on external CDN`);
    const externalScripts = (html.match(/<script[^>]+src="https?:\/\/[^"]+"/gi) || []);
    assert.deepEqual(externalScripts, [], `${page} must not load external scripts`);
    const externalCss = (html.match(/<link[^>]+href="https?:\/\/[^"]+"/gi) || [])
      .filter(tag => !/fonts\.(googleapis|gstatic)\.com/.test(tag));
    assert.deepEqual(externalCss, [], `${page}: only Google Fonts may be loaded from outside`);

    // Verify all inline <script> tags have 100% valid JavaScript syntax
    const scripts = html.match(/<script[\s\S]*?<\/script>/gi) || [];
    for (const s of scripts) {
      const code = s.replace(/<script[\s\S]*?>/i, '').replace(/<\/script>/i, '');
      assert.doesNotThrow(() => {
        new Function(code);
      }, `SyntaxError in script tag of ${page}`);
    }
    if (page === '/') {
      assert.ok(html.includes('SMA NEGERI 3 BURU'), '/ must include SMA NEGERI 3 BURU branding');
      assert.ok(/monitoring/i.test(html), '/ must match Monitoring layout');
      assert.ok(html.includes('Token'), '/ must include Token monitoring box');
    }
    if (page === '/operator.html') {
      assert.ok(html.includes('id="modalConfirmDelete"'), 'operator.html must have delete confirmation modal');
      assert.ok(html.includes('showConfirmDelete'), 'operator.html must have showConfirmDelete function');
      assert.ok(html.includes('confirmDeleteStudent'), 'operator.html must have confirmDeleteStudent');
      assert.ok(html.includes('confirmDeleteExam'), 'operator.html must have confirmDeleteExam');
      assert.ok(html.includes('confirmDeleteStaff'), 'operator.html must have confirmDeleteStaff');
    }
    if (page === '/guru.html') {
      assert.ok(html.includes('id="modalConfirmDelete"'), 'guru.html must have delete confirmation modal');
      assert.ok(html.includes('showConfirmDelete'), 'guru.html must have showConfirmDelete function');
      assert.ok(html.includes('confirmDeleteQuestion'), 'guru.html must have confirmDeleteQuestion');
      assert.ok(html.includes('deleteCurrentBankSoal'), 'guru.html must have deleteCurrentBankSoal');
    }
    if (page === '/ujian.html') {
      assert.ok(!html.includes('value="26-03-001"'), 'ujian.html must not hardcode Student #1 exam_number');
      assert.ok(html.includes('sessionStorage'), 'ujian.html must persist active session in sessionStorage');
      assert.ok(html.includes('SMA NEGERI 3 BURU'), 'ujian.html must be branded for SMA NEGERI 3 BURU');
      assert.ok(html.includes('Daftar Soal'), 'ujian.html must have Daftar Soal drawer');
      assert.ok(!html.includes('Contoh:'), 'ujian.html must not contain example placeholders');
    }
  }

});
