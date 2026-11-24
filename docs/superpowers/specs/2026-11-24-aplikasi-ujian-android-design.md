# Aplikasi Ujian Android Sendiri (pengganti SMANTRI CBT) — Desain (2026-11-24)

## Intent & alasan
Sekolah ingin aplikasi ujian Android **milik sendiri**. Alasan utama dari pengguna: **SMANTRI CBT tidak bisa
dibuka di banyak HP siswa (semua merek)**, kebanyakan karena aplikasi pendukung wajib **Simple Keyboard**
(harus dipasang, dijadikan keyboard utama, diberi izin — sering gagal / membingungkan).

Keberhasilan = siswa cukup **pasang 1 APK → buka → masukkan kode masuk → langsung halaman login ujian**,
di HP Android apa pun (Android 6+), tanpa aplikasi pendukung dan tanpa langkah pengaturan HP yang bisa gagal.

## Tujuan
- Satu APK, tanpa aplikasi pendukung, tanpa keyboard khusus, tanpa izin runtime khusus.
- Alur: **Layar kode masuk → halaman login `ujian.html` yang sudah ada** (tanpa scan QR).
- Pengamanan selama ujian setara/lebih baik dari sekarang, tapi **tidak ada fitur yang wajib diaktifkan
  di pengaturan HP**: bila suatu pengunci tidak didukung HP, ujian tetap berjalan.
- Keluar aplikasi hanya dengan **password pengawas** (sama dengan password keluar SEB iPhone).
- Kode masuk **diatur operator di Panel Operator**, dicek server, bisa diganti tanpa pasang ulang.

## Bukan tujuan
- Tidak menyalin kode, tampilan, nama, atau enkripsi QR SMANTRI CBT / RDEV. Aplikasi ini buatan sekolah.
- Tidak ada scan QR dan tidak ada QR terenkripsi.
- Tidak ada keyboard khusus. Kolom login (nomor peserta, kata sandi, token) memakai keyboard HP —
  selama ujian tidak ada yang diketik (PG diketuk, esai di kertas).
- Tidak menggantikan SEB untuk iPhone/PC; SMANTRI CBT tidak dihapus dari server (kartu meja Android lama
  tetap bisa dipakai selama masa transisi).
- Tidak mengunggah ke Play Store (distribusi lewat APK di situs sekolah).

## Anti-tujuan (gagal walau "jalan")
- Aplikasi yang lagi-lagi gagal dibuka di sebagian HP (karena izin, aplikasi pendukung, atau pengaturan wajib).
- Siswa terjebak tanpa bisa keluar bila pengawas lupa / server mati (harus ada jalan keluar yang jelas).
- Kode masuk atau password pengawas tertanam di APK (bisa dibongkar).

## Batasan
- Basis kode: proyek yang ada `android-exambro/` (Java, `MainActivity.java`, paket `id.sch.sman3buru.exambro`),
  dibangun dengan `build-apk.ps1` (aapt2 + javac + d8 + apksigner, tanpa Gradle). SDK di komputer: build-tools
  34–36, platforms android-35/36/37, JDK 17.
- **minSdk 23 (Android 6.0)**, targetSdk 35.
- Kunci tanda tangan lama hilang → **kunci baru**. Password keystore **tidak** ditulis di `build-apk.ps1`
  (diminta saat build / variabel lingkungan) — sekaligus menutup sisa pekerjaan lama.
- Server produksi: `https://cbt.smanegeri3buru.my.id`. APK diterbitkan ke `public/Exambro-SMAN3-Buru.apk`
  (tautan "Unduh Aplikasi Exambro (.apk)" di Beranda sudah ada).
- Halaman ujian sudah punya `window.onExambroViolationDetected(reason)` (mengunci layar ujian & mencatat
  pelanggaran) — aplikasi memanggilnya saat siswa keluar/split screen.

## Pendekatan yang dipertimbangkan
- **Meneruskan aplikasi Java yang ada (dipilih):** sudah punya FLAG_SECURE, lock task, deteksi keluar,
  deteksi split screen, blok Back; komputer sudah bisa membangun APK; tidak ada alat baru.
- Niotron / App Inventor (seperti SMANTRI): ditolak — itulah sumber keterbatasannya (kamera, keyboard khusus).
- Flutter / React Native: ditolak — perlu instal banyak alat, tanpa manfaat untuk aplikasi WebView sederhana.

## Desain yang disetujui pengguna
### Alur & layar
1. **Layar kode masuk (native):** logo sekolah, judul "Aplikasi Ujian CBT — SMA Negeri 3 Buru",
   kolom kode tersamar, **tombol angka di layar** (0–9, hapus, Masuk). Tidak memunculkan keyboard HP.
2. Kode dikirim ke server untuk dicek. Benar → WebView membuka `<server>/ujian.html`. Salah → pesan;
   setelah 5 kali salah ditahan 1 menit (di aplikasi) — server juga membatasi percobaan.
3. **Halaman ujian = `ujian.html` yang sudah ada** (login, token, soal, tombol esai). Tidak ada perubahan alur ujian.
4. **Tombol Keluar** (selalu terlihat di pojok, tidak menutupi soal) → minta **password pengawas**
   (tombol huruf/angka: pakai keyboard HP di dialog ini boleh) → dicek server → keluar dari pengunci & tutup aplikasi.

### Pengamanan selama ujian
- FLAG_SECURE (blok screenshot/rekam layar & pratinjau Recent Apps), layar tetap menyala, layar penuh (immersive).
- Tombol Back dinonaktifkan di WebView ujian.
- **Coba** `startLockTask()` (screen pinning). Gagal/tidak didukung → lanjut tanpa error.
- Deteksi keluar (onPause/onWindowFocusChanged karena Home/Recent/notifikasi) & split screen →
  panggil `onExambroViolationDetected(...)` di halaman (sudah ada logika kunci + catat di server).
- Blok salin-tempel: matikan seleksi teks/long-press di WebView; navigasi keluar domain server diblokir.
- User-Agent ditandai (sudah ada: `SMAN3BURU-EXAMBRO-ANDROID/1.0`), naikkan versi.
- Hapus kode foto esai/kamera lama (fitur foto esai sudah dihapus dari server).

### Server (baru)
- **Kode masuk aplikasi:** operator mengatur di Panel Operator (kotak baru dekat pengaturan SEB):
  angka **4–8 digit**, disimpan sebagai hash. Endpoint publik `POST /api/app/verify-code {code}` → `{ ok }`,
  dengan batas percobaan per IP (mis. 10 salah / 15 menit).
- **Password keluar:** endpoint `POST /api/app/verify-quit {password}` membandingkan dengan hash password
  keluar SEB yang sudah ada (`seb_quit_hash`). Bila belum diatur → aplikasi menampilkan bahwa password
  pengawas belum diatur (lihat Jalan keluar darurat).
- Server tidak pernah mengirim kode/password ke aplikasi; aplikasi hanya mengirim yang diketik siswa/pengawas.

### Wajibkan aplikasi ujian (diputuskan pengguna: bisa diatur operator)
- Panel Operator mendapat sakelar **"Wajibkan aplikasi ujian"** (bawaan: **mati**, untuk masa peralihan
  dari SMANTRI CBT).
- Saat `verify-code` benar, server membuat **tiket aplikasi** acak (berlaku 12 jam, disimpan di memori server
  seperti token staf) dan mengembalikannya ke aplikasi. Aplikasi memasang tiket itu sebagai **cookie**
  (`cbt_app`) untuk domain server di CookieManager WebView, sehingga semua permintaan halaman ujian membawanya.
- Bila sakelar **aktif**, `POST /api/ujian/login` (dan jalur masuk sesi lain seperti `start-direct`) hanya
  menerima permintaan yang membawa tiket aplikasi yang sah **atau** berasal dari Safe Exam Browser
  (User-Agent memuat `SEB/`; iPhone & PC). Lainnya ditolak 403 dengan pesan "Ujian hanya bisa dibuka lewat
  aplikasi ujian sekolah". Bila **mati**, perilaku sama seperti sekarang (SMANTRI CBT & browser biasa bisa).
- Pemeriksaan User-Agent SEB bisa dipalsukan; ini pengaman praktis, bukan mutlak (cukup untuk mencegah siswa
  membuka ujian dari Chrome biasa). Verifikasi Config Key SEB bisa menyusul bila perlu.

### Keputusan pembuat dari pemeriksaan desain (bisa dikoreksi pengguna)
- **Nama paket baru** `id.sch.sman3buru.ujian` (kunci baru; tak perlu hapus Exambro lama lebih dulu).
- **WebView lama (Android 6 tanpa pembaruan WebView):** `ujian.html` memakai sintaks modern (mis. optional
  chaining `?.`) yang membuat halaman kosong di WebView lama → sintaks itu ditulis ulang ke bentuk lama.
  Alur ujian tidak berubah. Tes otomatis memastikan script `ujian.html` tidak memakai sintaks itu.
- **Kunci layar dimulai tepat setelah kode masuk benar**; hilangnya fokus karena dialog sistem
  "sematkan aplikasi?" tidak dihitung pelanggaran (deteksi ditunda sampai pengunci selesai diproses).
- **Keluar oleh pengawas** (password benar) di tengah ujian **bukan pelanggaran**: aplikasi mematikan deteksi
  dulu, server mencatat kejadian "Keluar aplikasi oleh pengawas" tanpa mengunci sesi
  (endpoint baru yang membutuhkan token sesi siswa bila ada sesi aktif).
- **Pengaturan tersembunyi saat server tak terjangkau:** setelah password pengawas pernah dicek benar,
  aplikasi menyimpan hash-nya (SHA-256) di perangkat; bila server tak terjangkau, password dicek terhadap
  hash simpanan itu. Belum pernah dicek & server tak terjangkau → pengaturan tidak bisa dibuka (pasang ulang).

### Alamat server & pengaturan tersembunyi
- Alamat bawaan tertanam: `https://cbt.smanegeri3buru.my.id`.
- Pengaturan tersembunyi (ketuk logo 5×) → minta password pengawas → bisa ganti alamat server
  (mis. bila memakai IP LAN). Disimpan di SharedPreferences.

### Jalan keluar darurat
- Bila server tidak bisa dihubungi saat Keluar, atau password keluar belum diatur: aplikasi menampilkan
  petunjuk keluar lewat cara bawaan Android (lepas sematan layar dengan menahan tombol Back+Recent,
  lalu tutup aplikasi). Pengunci memang tidak mutlak — pelanggaran tetap tercatat bila siswa keluar saat ujian.

### Distribusi
- `build-apk.ps1` menghasilkan `public/Exambro-SMAN3-Buru.apk` (v1+v2+v3 signature, kunci baru).
- Nama aplikasi di HP: "Ujian CBT SMAN 3 Buru", ikon = logo sekolah.
- PANDUAN: cara pasang (izinkan "sumber tidak dikenal" sekali), cara pakai, kode masuk & password pengawas.

## Diserahkan ke pembuat
- Tata letak detail layar kode masuk (mengikuti warna logo: biru #27449b, kuning token #f9c80e).
- Cara deteksi keluar yang paling andal tanpa salah deteksi saat dialog Keluar/izin sistem muncul.
- Nama/struktur kelas Java, versionCode/versionName awal (mis. 2 / 2.0.0).
- Tes otomatis untuk endpoint server (node:test, TDD). Aplikasi Android diuji manual di emulator/HP.
