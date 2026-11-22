# Uji Beban (Simulasi Siswa Serentak) — Desain Singkat (2026-11-22)

## Tujuan
Sebelum hari ujian, tahu apakah VPS sekolah sanggup melayani seluruh siswa yang mengerjakan bersamaan,
bukan baru tahu saat server melambat di tengah ujian.

## Disetujui pengguna (pilihan A)
- Dijalankan **di VPS sekolah** dengan **server tes terpisah** (port 8199, database sementara). Data asli &
  ujian yang sedang berjalan tidak tersentuh. Jalankan di luar jam ujian. Juga bisa dijalankan di komputer lain.
- Skrip Node.js tanpa paket tambahan: `node scripts/uji-beban.js --siswa 500 --pengawas 15 --menit 5`.
- Bawaan: 500 siswa, 15 pengawas, 5 menit. Siswa datang bertahap selama 1 menit pertama.
- Perilaku siswa meniru `ujian.html`: login + token → ambil sesi → minta ulang sesi tiap 6 detik →
  jawab 1 soal PG tiap 20–40 detik (heartbeat + answer) → di akhir tandai esai & Selesai.
- Pengawas: login lalu minta ulang data ruang tiap 2,5 detik (seperti `pengawas.html`).
- Skrip **tidak punya opsi alamat tujuan**: selalu ke 127.0.0.1 server tesnya sendiri.
- Hasil: tabel per jenis permintaan (jumlah, gagal, median, p95, terlama) + kesimpulan:
  ✅ SANGGUP (p95 < 1 dtk & gagal < 1%), ⚠️ BERAT (p95 1–3 dtk), ❌ TIDAK SANGGUP (lebih buruk).
- Panduan: bagian "Uji Beban".

## Pendekatan
- **Skrip Node.js sendiri (dipilih):** meniru alur ujian, tanpa instal apa pun di VPS.
- k6 / artillery / autocannon: perlu instal; autocannon hanya menembak satu alamat. Ditolak.

## Keputusan saya
- Data tes: siswa kelas `XII IPA 1` dibagi ke `Ruang 01`…`Ruang NN`, akun pengawas tes per ruang
  (password bukan bawaan), ujian aktif bawaan ditambah soal PG hingga 40 soal (mendekati ujian nyata).
- Token diambil pengawas tes lewat `/api/ujian/active-token`; bila berganti (15 menit), diambil ulang.
- Server tes berjalan sebagai proses terpisah (`node server.js` dengan `DB_PATH`, `PORT`, `BACKUP_DIR`
  sementara) agar pembangkit beban tidak berbagi event loop dengan server.
- Opsi `--json` mencetak ringkasan mesin-baca (dipakai tes otomatis). Kode keluar 0 bila SANGGUP, 1 bila tidak.
- Skrip & server tes berbagi CPU di VPS → hasil sedikit lebih buruk dari kenyataan (condong ke aman).
