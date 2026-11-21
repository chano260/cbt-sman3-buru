const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pub = path.join(__dirname, '..', 'public');
const PAGES = ['index.html', 'operator.html', 'guru.html', 'pengawas.html', 'ujian.html'];
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

// Ambil isi semua <script> inline (tanpa atribut src)
function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
}

// Panggilan dialog bawaan browser: alert( / confirm( / prompt( yang bukan bagian dari nama lain
const NATIVE = /(^|[^\w.$])(alert|confirm|prompt)\s*\(/g;

function functionBody(src, name) {
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `fungsi ${name} harus ada`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`body ${name} tidak lengkap`);
}

test('Semua halaman memuat modul pop-up bersama /dialog.js sebelum script halaman', () => {
  for (const page of PAGES) {
    const html = read(page);
    const tag = html.search(/<script[^>]*src="\/dialog\.js"[^>]*><\/script>/);
    assert.ok(tag >= 0, `${page} harus memuat /dialog.js`);
    const firstInline = html.search(/<script(?![^>]*\bsrc=)[^>]*>/);
    assert.ok(tag < firstInline, `${page}: /dialog.js harus dimuat sebelum script inline`);
  }
});

test('Tidak ada lagi alert()/confirm()/prompt() bawaan browser di halaman mana pun', () => {
  for (const page of PAGES) {
    const html = read(page);
    const code = inlineScripts(html);
    const attrs = [...html.matchAll(/\son[a-z]+="([^"]*)"/g)].map(m => m[1]).join('\n');
    const found = [...(code + '\n' + attrs).matchAll(NATIVE)].map(m => m[2]);
    assert.deepEqual(found, [], `${page} masih memakai dialog bawaan: ${found.join(', ')}`);
  }
});

test('dialog.js menyediakan cbtConfirm (Promise<boolean>) dan cbtAlert (Promise) yang aman dari XSS', async () => {
  const src = read('dialog.js');
  // DOM minimal untuk menjalankan modul di Node
  const nodes = [];
  const makeEl = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], style: {}, attrs: {}, listeners: {}, className: '', _text: '',
      set textContent(v) { this._text = String(v); this.children = []; }, get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
      set innerHTML(v) { throw new Error('innerHTML tidak boleh dipakai untuk teks pesan'); },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      focus() {}, querySelector: () => null,
      click() { (this.listeners.click || []).forEach(f => f({ target: this })); }
    };
    nodes.push(el); return el;
  };
  const body = makeEl('body');
  const document = { createElement: makeEl, body, getElementById: () => null, addEventListener() {}, removeEventListener() {}, activeElement: null };
  const ctx = { window: {}, document, setTimeout, clearTimeout, Promise, console };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);

  assert.equal(typeof ctx.cbtConfirm, 'function');
  assert.equal(typeof ctx.cbtAlert, 'function');

  // Pop-up diantrikan, jadi muncul satu tick setelah dipanggil
  const tick = () => new Promise(r => setImmediate(r));
  const onScreen = (n) => { let p = n; while (p && p !== body) p = p.parentNode; return p === body; };
  const findBtn = (label) => nodes.find(n => n.tagName === 'BUTTON' && n.textContent === label && onScreen(n));

  const p1 = ctx.cbtConfirm({ title: 'Reset?', message: '<img src=x onerror=alert(1)>', confirmText: 'Ya, Reset' });
  await tick();
  assert.ok(nodes.some(n => onScreen(n) && n.textContent.includes('<img src=x')), 'pesan ditampilkan sebagai teks biasa');
  findBtn('Ya, Reset').click();
  assert.equal(await p1, true);

  const p2 = ctx.cbtConfirm({ title: 'Reset?', message: 'x', confirmText: 'Ya' });
  await tick();
  findBtn('Batal').click();
  assert.equal(await p2, false);

  // Dua pesan sekaligus tampil bergantian, bukan bertumpuk
  const p3 = ctx.cbtAlert('Berhasil disimpan', 'success');
  const p4 = ctx.cbtAlert('Pesan kedua');
  await tick();
  assert.equal(body.children.length, 1, 'hanya satu pop-up yang tampil');
  findBtn('OK').click();
  await p3;
  await tick();
  findBtn('OK').click();
  await p4;
  assert.equal(body.children.length, 0, 'semua pop-up tertutup');
});

test('Aksi berisiko meminta konfirmasi pop-up sebelum dijalankan', () => {
  const required = {
    'operator.html': ['resetSession', 'submitChangeClass', 'submitCopyQuestions', 'refreshToken', 'activateExam', 'submitOperatorWordUpload'],
    'pengawas.html': ['resetStudentLogin'],
    'guru.html': ['clearQuestionMedia', 'uploadWordFile']
  };
  for (const [page, fns] of Object.entries(required)) {
    const code = inlineScripts(read(page));
    for (const fn of fns) {
      assert.ok(functionBody(code, fn).includes('cbtConfirm('), `${page}: ${fn}() harus memanggil cbtConfirm()`);
    }
  }
});
