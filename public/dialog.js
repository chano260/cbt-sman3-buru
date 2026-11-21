/*
 * Pop-up bersama CBT SMA Negeri 3 Buru (pengganti alert()/confirm() bawaan browser).
 *
 *   await cbtAlert('Data tersimpan', 'success');            // tipe: info | success | warning | error
 *   if (await cbtConfirm({ title, message, confirmText, tone })) { ... }   // tone: warning | danger | info
 *
 * Semua teks ditampilkan sebagai teks biasa (textContent), jadi aman dari XSS.
 * Pop-up yang dipanggil bersamaan ditampilkan bergantian (antrian), tidak saling menimpa.
 */
(function () {
  var TONES = {
    info: { icon: 'ℹ️', bg: '#dbeafe', fg: '#1d4ed8', btn: '#2563eb' },
    success: { icon: '✅', bg: '#dcfce7', fg: '#15803d', btn: '#16a34a' },
    warning: { icon: '⚠️', bg: '#fef3c7', fg: '#b45309', btn: '#d97706' },
    error: { icon: '⛔', bg: '#fee2e2', fg: '#b91c1c', btn: '#dc2626' },
    danger: { icon: '⚠️', bg: '#fee2e2', fg: '#b91c1c', btn: '#dc2626' }
  };
  var TITLES = { info: 'Informasi', success: 'Berhasil', warning: 'Perhatian', error: 'Terjadi Kendala', danger: 'Konfirmasi' };

  // Tebak jenis pesan dari isinya bila pemanggil tidak menyebutkan tipe
  function guessType(msg) {
    var s = String(msg || '');
    if (/^\s*(✓|✅|🎉)/.test(s) || /\bberhasil\b/i.test(s)) return 'success';
    if (/gagal|error|kesalahan|tidak sesuai|ditolak|tidak dapat|tidak ditemukan/i.test(s)) return 'error';
    if (/^\s*(⚠|❗)/.test(s) || /\b(wajib|silakan|silahkan|pilih|belum)\b/i.test(s)) return 'warning';
    return 'info';
  }

  var queue = Promise.resolve();
  function enqueue(job) {
    var run = queue.then(job, job);
    queue = run.then(function () {}, function () {});
    return run;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function open(opts) {
    return new Promise(function (resolve) {
      var tone = TONES[opts.tone] || TONES.info;
      var overlay = el('div', 'cbt-dialog-overlay');
      overlay.setAttribute('role', 'presentation');
      var card = el('div', 'cbt-dialog-card');
      card.setAttribute('role', opts.cancelText ? 'alertdialog' : 'dialog');
      card.setAttribute('aria-modal', 'true');

      var icon = el('div', 'cbt-dialog-icon', opts.icon || tone.icon);
      icon.style.background = tone.bg;
      icon.style.color = tone.fg;
      var title = el('div', 'cbt-dialog-title', opts.title);
      var msg = el('div', 'cbt-dialog-message', opts.message);
      var actions = el('div', 'cbt-dialog-actions');

      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(value);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); finish(opts.cancelText ? false : true); }
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      }

      if (opts.cancelText) {
        var cancel = el('button', 'btn btn-outline cbt-dialog-btn', opts.cancelText);
        cancel.setAttribute('type', 'button');
        cancel.addEventListener('click', function () { finish(false); });
        actions.appendChild(cancel);
      }
      var ok = el('button', 'btn cbt-dialog-btn cbt-dialog-btn-primary', opts.okText);
      ok.setAttribute('type', 'button');
      ok.style.background = tone.btn;
      ok.addEventListener('click', function () { finish(true); });
      actions.appendChild(ok);

      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay && opts.cancelText) finish(false);
      });

      card.appendChild(icon);
      card.appendChild(title);
      card.appendChild(msg);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKey, true);
      try { ok.focus(); } catch (e) {}
    });
  }

  window.cbtAlert = function (message, type, title) {
    var t = TONES[type] ? type : guessType(message);
    return enqueue(function () {
      return open({ tone: t, title: title || TITLES[t], message: message, okText: 'OK' });
    }).then(function () {});
  };

  window.cbtConfirm = function (opts) {
    opts = opts || {};
    var t = TONES[opts.tone] ? opts.tone : 'warning';
    return enqueue(function () {
      return open({
        tone: t,
        icon: opts.icon,
        title: opts.title || 'Konfirmasi',
        message: opts.message || 'Apakah Anda yakin?',
        okText: opts.confirmText || 'Ya, Lanjutkan',
        cancelText: opts.cancelText || 'Batal'
      });
    });
  };
})();
