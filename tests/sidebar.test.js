const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pub = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');
const SIDEBAR_PAGES = ['operator.html', 'guru.html', 'index.html'];

test('Halaman dengan sidebar memuat /sidebar.js setelah sidebar dan sebelum script halaman', () => {
  for (const page of SIDEBAR_PAGES) {
    const html = read(page);
    const tag = html.search(/<script[^>]*src="\/sidebar\.js"[^>]*><\/script>/);
    assert.ok(tag >= 0, `${page} harus memuat /sidebar.js`);
    assert.ok(tag > html.indexOf('</aside>'), `${page}: /sidebar.js harus dimuat setelah elemen sidebar`);
    assert.ok(tag < html.search(/<script(?![^>]*\bsrc=)[^>]*>/), `${page}: /sidebar.js harus sebelum script inline`);
  }
});

test('Setiap menu sidebar punya ikon dan label terpisah (agar mode ciut hanya menampilkan ikon)', () => {
  for (const page of SIDEBAR_PAGES) {
    const html = read(page);
    const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
    const items = [...aside.matchAll(/<(button|a)\b[^>]*class="[^"]*\b(nav-btn|bp3-nav-item)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)];
    assert.ok(items.length > 0, `${page} harus punya menu sidebar`);
    for (const [, , , inner] of items) {
      const hasIcon = /<svg\b/.test(inner) || /class="nav-icon"/.test(inner);
      const hasLabel = /<span(?![^>]*nav-icon)[^>]*>[^<]+<\/span>/.test(inner);
      assert.ok(hasIcon && hasLabel, `${page}: menu "${inner.replace(/<[^>]+>/g, '').trim()}" harus punya ikon + <span> label`);
    }
  }
});

test('CSS mode ciut hanya berlaku di layar lebar (>900px)', () => {
  const css = read('styles.css');
  const block = css.slice(css.indexOf('@media (min-width: 901px)'));
  assert.ok(css.includes('@media (min-width: 901px)'), 'harus ada media query min-width 901px');
  assert.match(block, /\.sidebar-collapsed\s+\.app-shell/);
  assert.match(block, /\.sidebar-collapsed\s+\.bp3-dashboard-grid/);
});

// DOM minimal untuk menjalankan sidebar.js di Node
function makeDom({ stored, storageThrows } = {}) {
  const mk = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], attrs: {}, listeners: {}, _text: '',
      classList: {
        set: new Set(),
        add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
        toggle(c, force) { const on = force === undefined ? !this.set.has(c) : force; on ? this.set.add(c) : this.set.delete(c); return on; }
      },
      set textContent(v) { this._text = String(v); }, get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? 0 : i, 0, c); c.parentNode = this; return c; },
      get firstChild() { return this.children[0] || null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }, hasAttribute(k) { return k in this.attrs; },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      click() { (this.listeners.click || []).forEach(f => f({ preventDefault() {} })); },
      querySelectorAll(sel) { return sel.includes('nav') ? this.children.filter(c => c.isNav) : []; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    };
    return el;
  };
  const html = mk('html');
  const aside = mk('aside');
  ['Pantauan & Token', 'Cetak Dokumen'].forEach(label => {
    const b = mk('button'); b.isNav = true;
    const icon = mk('span'); icon.attrs.class = 'nav-icon'; icon.textContent = '📊';
    const lab = mk('span'); lab.textContent = label;
    b.appendChild(icon); b.appendChild(lab); b.label = lab;
    b.querySelector = (sel) => (sel.includes('span') ? lab : null);
    aside.appendChild(b);
  });
  const store = {};
  if (stored !== undefined) store.cbt_sidebar_collapsed = stored;
  const localStorage = {
    getItem(k) { if (storageThrows) throw new Error('blocked'); return k in store ? store[k] : null; },
    setItem(k, v) { if (storageThrows) throw new Error('blocked'); store[k] = String(v); }
  };
  const document = {
    documentElement: html, createElement: mk,
    querySelector: (sel) => (sel.includes('sidebar') ? aside : null)
  };
  const ctx = { document, localStorage, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('sidebar.js'), ctx);
  const toggle = aside.children.find(c => c.tagName === 'BUTTON' && !c.isNav);
  return { html, aside, toggle, store };
}

test('sidebar.js menambah tombol ciut, mengubah kelas, dan mengingat pilihan', () => {
  const { html, aside, toggle, store } = makeDom();
  assert.ok(toggle, 'tombol ciutkan menu harus ditambahkan');
  assert.equal(aside.children[0], toggle, 'tombol ada di bagian atas sidebar');
  assert.equal(html.classList.contains('sidebar-collapsed'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  toggle.click();
  assert.equal(html.classList.contains('sidebar-collapsed'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(store.cbt_sidebar_collapsed, '1');

  toggle.click();
  assert.equal(html.classList.contains('sidebar-collapsed'), false);
  assert.equal(store.cbt_sidebar_collapsed, '0');

  // Nama menu menjadi tooltip saat diciutkan
  const nav = aside.children.filter(c => c.isNav);
  assert.deepEqual(nav.map(b => b.getAttribute('title')), ['Pantauan & Token', 'Cetak Dokumen']);
});

test('sidebar.js memulai dalam keadaan ciut bila tersimpan, dan tetap jalan bila penyimpanan diblokir', () => {
  const a = makeDom({ stored: '1' });
  assert.equal(a.html.classList.contains('sidebar-collapsed'), true);
  assert.equal(a.toggle.getAttribute('aria-expanded'), 'false');

  const b = makeDom({ storageThrows: true });
  assert.ok(b.toggle, 'tetap menambah tombol walau localStorage diblokir');
  b.toggle.click();
  assert.equal(b.html.classList.contains('sidebar-collapsed'), true);
});
