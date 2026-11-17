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
    if (page === '/') {
      assert.ok(html.includes('/logoBP3.png'), '/ must include BPPP Kemendikdasmen logo');
      assert.ok(html.includes('MONITORING ABM'), '/ must match Monitoring ABM layout');
      assert.ok(html.includes('INFORMASI LANJUTAN UJI COBA SERENTAK ABM TAHUN 2026'), '/ must contain ABM announcement');
    }
    if (page === '/ujian.html') {
      assert.ok(!html.includes('value="26-03-001"'), 'ujian.html must not hardcode Student #1 exam_number');
      assert.ok(html.includes('sessionStorage'), 'ujian.html must persist active session in sessionStorage');
      assert.ok(html.includes('/logoBP3.png'), 'ujian.html must include Kemendikdasmen BPPP logo');
      assert.ok(html.includes('ExamBPPP'), 'ujian.html must follow ExamBPPP application design');
      assert.ok(html.includes('Daftar Soal'), 'ujian.html must have Daftar Soal drawer');
      assert.ok(!html.includes('Contoh:'), 'ujian.html must not contain example placeholders');
    }
  }

});
