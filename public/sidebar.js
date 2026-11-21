/*
 * Sidebar yang bisa diciutkan (Panel Operator, Panel Guru, Portal).
 * - Menambah tombol "Ciutkan menu" di bagian atas sidebar.
 * - Mode ciut: sidebar hanya menampilkan ikon; nama menu jadi tooltip (title).
 * - Pilihan disimpan di localStorage browser ini (berlaku untuk semua panel).
 * - Mode ciut hanya berlaku di layar lebar (>900px), lihat styles.css.
 * Muat file ini SETELAH elemen <aside> sidebar.
 */
(function () {
  var KEY = 'cbt_sidebar_collapsed';
  var root = document.documentElement;
  var sidebar = document.querySelector('.app-shell > .sidebar, .bp3-sidebar-left');
  if (!sidebar) return;

  function readSaved() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function save(collapsed) {
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (e) { /* penyimpanan diblokir: abaikan */ }
  }

  // Nama menu sebagai tooltip, supaya tetap jelas saat hanya ikon yang tampil
  var items = sidebar.querySelectorAll('.nav-btn, .bp3-nav-item');
  for (var i = 0; i < items.length; i++) {
    var label = items[i].querySelector('span:not(.nav-icon)');
    var text = label ? String(label.textContent).trim() : '';
    if (text && !items[i].getAttribute('title')) items[i].setAttribute('title', text);
  }

  var btn = document.createElement('button');
  btn.setAttribute('type', 'button');
  btn.setAttribute('class', 'sidebar-toggle');
  var icon = document.createElement('span');
  icon.setAttribute('class', 'sidebar-toggle-icon');
  icon.setAttribute('aria-hidden', 'true');
  var text2 = document.createElement('span');
  text2.setAttribute('class', 'sidebar-toggle-label');
  btn.appendChild(icon);
  btn.appendChild(text2);
  sidebar.insertBefore(btn, sidebar.firstChild);

  function apply(collapsed) {
    root.classList.toggle('sidebar-collapsed', collapsed);
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    var label = collapsed ? 'Lebarkan menu' : 'Ciutkan menu';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    icon.textContent = collapsed ? '»' : '«';
    text2.textContent = label;
  }

  apply(readSaved());
  btn.addEventListener('click', function () {
    var next = !root.classList.contains('sidebar-collapsed');
    apply(next);
    save(next);
  });
})();
