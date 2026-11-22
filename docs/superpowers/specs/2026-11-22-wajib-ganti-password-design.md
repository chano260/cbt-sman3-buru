# Wajib Ganti Password Bawaan — Desain Singkat (2026-11-22)

## Tujuan
Password bawaan (`admin123`, `guru123`, `pengawas123`) tercatat di kode & panduan, jadi siapa pun bisa
masuk panel staf. Akun yang masih memakainya harus mengganti password sebelum bisa memakai panel.

## Disetujui pengguna (pilihan A)
- Hanya akun yang **login dengan salah satu password bawaan** yang wajib ganti. Password yang dibuat
  operator untuk guru/pengawas tetap berlaku seperti biasa (operator tetap tahu password yang ia bagikan).
- Bila operator me-reset password ke salah satu password bawaan, akun itu juga diminta ganti.
- Pemeriksaan di server saat login → token login diberi tanda `mustChangePassword`.
- Selama tanda aktif, semua endpoint staf menolak dengan **403** `{ code: 'PASSWORD_CHANGE_REQUIRED' }`;
  token ujian juga tidak ditampilkan (server-info / active-token). Yang tetap boleh: ganti password & logout.
- Endpoint baru `POST /api/staff/change-password` `{ old_password, new_password }`:
  minimal 8 karakter, bukan salah satu password bawaan, tidak sama dengan username, password lama harus benar.
  Berhasil → tanda dicabut pada token itu, panel langsung bisa dipakai.
- Pop-up "🔐 Ganti Password Dulu" di panel Operator, Guru, Pengawas; tidak bisa ditutup kecuali Keluar.
- Panduan bagian 2: password bawaan hanya untuk login pertama. Peringatan konsol server tetap ada.

## Pendekatan
- **Cek saat login, tanda di token (dipilih):** tanpa kolom database baru, cukup untuk pilihan A.
- Kolom `must_change_password` di DB: perlu untuk pilihan B (ditolak pengguna) — tambahan tak perlu.
- Cek hanya di halaman: bisa dilewati dengan memanggil API langsung. Ditolak.

## Keputusan saya
- Daftar password bawaan dipindah ke `src/security.js` (`DEFAULT_STAFF_PASSWORDS`), dipakai server.js juga.
- Modul bersama `public/password-gate.js`: dipanggil panel setelah login (`cbtPasswordGate.require(token)`)
  dan juga otomatis membuka pop-up bila ada respons 403 `PASSWORD_CHANGE_REQUIRED` (mis. setelah refresh).
- Keluar dari pop-up: hapus token panel di sessionStorage lalu muat ulang halaman.
