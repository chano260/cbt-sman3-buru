/*
 * Pop-up wajib ganti password bawaan untuk panel staf (operator, guru, pengawas).
 *   cbtPasswordGate.require(staffToken, passwordLamaOpsional)
 * Otomatis terbuka juga bila server membalas 403 { code: 'PASSWORD_CHANGE_REQUIRED' }
 * (mis. setelah halaman di-refresh). Tidak bisa ditutup kecuali "Keluar".
 */
(function () {
  var TOKEN_KEYS = ['cbt_operator_token', 'cbt_guru_token', 'cbt_pengawas_token'];
  var isOpen = false;
  var nativeFetch = window.fetch.bind(window);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function field(label, id, value) {
    var wrap = el('label', 'cbt-pw-field');
    wrap.appendChild(el('span', 'cbt-pw-label', label));
    var input = el('input', 'input');
    input.type = 'password';
    input.id = id;
    input.autocomplete = id === 'cbtPwOld' ? 'current-password' : 'new-password';
    if (value) input.value = value;
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function logout(token) {
    nativeFetch('/api/staff/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
      .catch(function () {})
      .then(function () {
        TOKEN_KEYS.forEach(function (k) { try { sessionStorage.removeItem(k); } catch (e) {} });
        location.reload();
      });
  }

  function open(token, oldPassword) {
    if (isOpen || !token) return;
    isOpen = true;
    // Sesi login sudah sah; kotak login panel tidak perlu tampil di belakang pop-up
    var loginOverlay = document.getElementById('loginOverlay');
    if (loginOverlay) loginOverlay.style.display = 'none';

    var overlay = el('div', 'cbt-dialog-overlay');
    var card = el('div', 'cbt-dialog-card cbt-pw-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'cbtPwTitle');

    var icon = el('div', 'cbt-dialog-icon', typeof window.cbtIcon === 'function' ? null : '🔐');
    if (typeof window.cbtIcon === 'function') icon.innerHTML = window.cbtIcon('lock');
    icon.style.background = '#fef3c7';
    icon.style.color = '#b45309';
    var title = el('div', 'cbt-dialog-title', 'Ganti Password Dulu');
    title.id = 'cbtPwTitle';
    var msg = el('div', 'cbt-dialog-message',
      'Akun ini masih memakai password bawaan. Demi keamanan, buat password baru sebelum melanjutkan.');

    var form = el('form', 'cbt-pw-form');
    var fOld = field('Password lama', 'cbtPwOld', oldPassword);
    var fNew = field('Password baru (minimal 8 karakter)', 'cbtPwNew');
    var fRep = field('Ulangi password baru', 'cbtPwRep');
    var err = el('div', 'cbt-pw-error');
    err.setAttribute('role', 'alert');
    form.appendChild(fOld.wrap);
    form.appendChild(fNew.wrap);
    form.appendChild(fRep.wrap);
    form.appendChild(err);

    var actions = el('div', 'cbt-dialog-actions');
    var out = el('button', 'btn btn-outline cbt-dialog-btn', 'Keluar');
    out.type = 'button';
    var save = el('button', 'btn cbt-dialog-btn cbt-dialog-btn-primary', 'Simpan Password');
    save.type = 'submit';
    save.style.background = '#27449b';
    actions.appendChild(out);
    actions.appendChild(save);
    form.appendChild(actions);

    function showError(text) { err.textContent = text; err.style.display = text ? 'block' : 'none'; }
    showError('');

    out.addEventListener('click', function () { logout(token); });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var newPw = fNew.input.value.trim();
      if (newPw.length < 8) return showError('Password baru minimal 8 karakter.');
      if (newPw !== fRep.input.value.trim()) return showError('Ulangi password baru belum sama.');
      save.disabled = true;
      save.textContent = 'Menyimpan...';
      nativeFetch('/api/staff/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ old_password: fOld.input.value, new_password: newPw })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Gagal mengganti password.');
          overlay.remove();
          isOpen = false;
          var next = window.cbtAlert
            ? window.cbtAlert('Password berhasil diganti. Gunakan password baru ini untuk login berikutnya.', 'success')
            : Promise.resolve();
          return next.then(function () { location.reload(); });
        });
      }).catch(function (e) {
        showError(e.message || 'Gagal mengganti password. Periksa koneksi ke server.');
        save.disabled = false;
        save.textContent = 'Simpan Password';
      });
    });

    card.appendChild(icon);
    card.appendChild(title);
    card.appendChild(msg);
    card.appendChild(form);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    try { (oldPassword ? fNew.input : fOld.input).focus(); } catch (e) {}
  }

  function tokenFromInit(init) {
    var h = init && init.headers;
    if (!h) return '';
    var auth = typeof h.get === 'function' ? h.get('Authorization') : (h.Authorization || h.authorization);
    return auth && /^Bearer\s+/.test(auth) ? auth.replace(/^Bearer\s+/, '') : '';
  }

  // Tangkap 403 PASSWORD_CHANGE_REQUIRED dari panggilan API panel mana pun
  window.fetch = function (input, init) {
    return nativeFetch(input, init).then(function (res) {
      if (res.status === 403) {
        res.clone().json().then(function (data) {
          if (data && data.code === 'PASSWORD_CHANGE_REQUIRED') open(tokenFromInit(init));
        }).catch(function () {});
      }
      return res;
    });
  };

  window.cbtPasswordGate = { require: open };
})();
