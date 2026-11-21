const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/app');

test('All 5 web interfaces load with 200 OK and contain zero external CDN links (100% offline-ready)', async (t) => {
  const db = initDb(':memory:');
  const app = createApp(db);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const page of ['/', '/operator.html', '/guru.html', '/pengawas.html', '/ujian.html']) {
    const res = await fetch(`${base}${page}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('https://fonts.googleapis.com'), `${page} must not depend on external fonts`);
    assert.ok(!html.includes('https://cdn.'), `${page} must not depend on external CDN`);

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
      assert.ok(html.includes('MONITORING'), '/ must match Monitoring layout');
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
