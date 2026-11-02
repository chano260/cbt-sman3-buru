# Dokumen Rancangan Sistem (Design Spec): Aplikasi CBT Lokal & Android Exambro SMA Negeri 3 Buru

**Tanggal:** 2 November 2026  
**Target Pengguna:** SMA Negeri 3 Buru (Siswa, Pengawas Ruangan, Guru Mata Pelajaran, dan Operator Sekolah)  
**Ukuran Pekerjaan:** Proyek Penuh (1 Paket Terpadu: Server CBT Lokal + Aplikasi Android Exambro Native)

---

## 1. Tujuan & Latar Belakang (Intent & Why)
SMA Negeri 3 Buru membutuhkan sistem ujian berbasis komputer/HP (*Computer Based Test* / CBT) yang berjalan sepenuhnya di **jaringan lokal sekolah (Wi-Fi/LAN tanpa internet)** menggunakan komputer/laptop lokal sebagai server dan HP Android milik siswa sebagai perangkat ujian.

Tujuan utamanya:
1. **Mencegah kecurangan:** Siswa menggunakan aplikasi khusus **Exambro SMA N 3 Buru** yang mengunci layar HP (*Screen Pinning / Lock Task*), memblokir *screenshot*, mematikan *split-screen*, dan mengunci ujian siswa secara otomatis jika terdeteksi mencoba keluar aplikasi. Karena berjalan di Wi-Fi lokal tanpa internet, siswa juga mustahil mencari jawaban di Google atau AI.
2. **Sesuai alur ujian nyata di sekolah:**
   - **Soal Pilihan Ganda (PG):** Dijawab langsung di layar HP, dinilai otomatis oleh server, tetapi **nilai tidak ditampilkan ke siswa** saat selesai ujian (hanya tampil di Panel Guru & Operator).
   - **Soal Esai:** Naskah soal (dan gambar jika ada) tampil di layar HP siswa, namun **dijawab secara tertulis di lembar jawaban kertas** yang disediakan pengawas.
3. **Kemudahan bagi Guru, Pengawas, dan Operator:**
   - Pemisahan yang jelas antara **Panel Operator**, **Panel Guru Mapel**, dan **Panel Pengawas Ruangan** dengan antarmuka yang modern, bersih, dan enak dilihat.
   - Guru dapat mengimpor soal PG (beserta kunci jawaban) dan soal Esai sekaligus dari satu file **Microsoft Word (`.docx`)**.
   - Operator dapat mencetak **Daftar Hadir**, **Kartu Peserta**, **Kartu Login**, dan **Kartu Meja** langsung dari sistem.

---

## 2. Sasaran, Batasan & Anti-Sasaran (Goals, Non-Goals & Anti-Goals)

### Sasaran Utama (Goals)
- **Server CBT Lokal Satu-Klik:** Berjalan di PC/Laptop Windows operator tanpa instalasi database eksternal yang rumit (XAMPP/MySQL). Cukup jalankan skrip starter, server langsung aktif di jaringan LAN/Wi-Fi.
- **3 Panel Staf Terpisah + 1 Portal Ujian Siswa:**
  1. **Panel Operator (`/operator`):** Kelola kelas, ruang, siswa (termasuk import Excel/CSV), akun guru & pengawas, jadwal & sesi ujian, token ujian, serta **Pusat Cetak 4 Dokumen Administrasi** (Daftar Hadir zig-zag, Kartu Peserta, Kartu Login + QR, Kartu Meja).
  2. **Panel Guru Mapel (`/guru`):** Unduh template Word, **Import Soal Sekaligus dari Word (`.docx`)** (PG + Kunci Jawaban + Esai), pratinjau/edit soal di bank soal, pantau hasil nilai PG kelasnya, dan **Export Nilai PG ke Excel (`.xlsx`)**.
  3. **Panel Pengawas Ruangan (`/pengawas`):** Dioptimalkan untuk layar HP Pengawas di dalam kelas; melihat token aktif, memantau kehadiran & progres siswa per ruang, menerima peringatan merah *real-time* saat siswa keluar aplikasi, tombol **Buka Kunci (Unlock)** siswa yang terkunci, tombol **Reset Login** (jika siswa ganti HP/HP mati), dan pengisian Berita Acara singkat.
  4. **Portal Ujian Siswa (`/ujian` — diakses dari dalam Exambro):** Login dengan Nomor Peserta & Password + Token Ujian, pengerjaan soal PG (auto-save tiap klik) dan baca soal Esai (dengan banner instruksi jawab di kertas), penghitung waktu mundur (*countdown timer*), dan halaman selesai tanpa menampilkan skor.
- **Aplikasi Android Exambro Native (`android-exambro/`):** Proyek Android (Kotlin) siap bangun menjadi APK yang mengaktifkan *Screen Pinning* (`startLockTask()`), `FLAG_SECURE` (anti-screenshot/screen record), blokir *split-screen* (`resizeableActivity="false"`), input IP Server lokal / scan, dan deteksi kehilangan fokus layar (`onPause`/`onStop`/visibility change) yang langsung melapor ke server untuk mengunci sesi ujian siswa.

### Bukan Sasaran (Non-Goals)
- Penilaian otomatis soal Esai di aplikasi (karena jawaban esai ditulis di kertas fisik oleh siswa).
- Sinkronisasi cloud ke server pusat kementerian (sistem ini murni mandiri untuk ujian internal sekolah).

### Anti-Sasaran (Anti-Goals — Hal yang Tidak Boleh Terjadi)
- **Bocornya nilai atau kunci jawaban ke HP siswa:** API ujian siswa sama sekali tidak boleh mengirimkan field `kunci_jawaban` atau `skor` ke perangkat siswa, baik saat ujian berlangsung maupun saat ujian selesai.
- **Hilangnya jawaban siswa saat HP mati/lowbat:** Jawaban PG harus langsung tersimpan ke database server setiap kali siswa menyentuh pilihan A/B/C/D/E, bukan baru dikirim saat klik tombol "Selesai".
- **Tampilan rumit dan membingungkan:** Antarmuka harus bersih, modern (menggunakan tipografi jelas, warna kontras yang nyaman di mata), dan tombol di HP cukup besar agar tidak salah sentuh.

---

## 3. Batasan Teknis (Constraints)
- **Lingkungan Jaringan:** Berjalan 100% *offline* (tanpa internet) di jaringan LAN/Wi-Fi lokal sekolah. Semua aset tampilan (CSS, ikon, font/script) harus tersedia secara lokal di dalam server agar tampilan tetap bagus meski router Wi-Fi sekolah tidak terhubung ke internet.
- **Kapasitas & Performa:** Database lokal harus mampu menangani ratusan siswa yang menyimpan jawaban secara bersamaan tanpa *database locked* (menggunakan SQLite dalam mode `WAL` / *Write-Ahead Logging*).

---

## 4. Pendekatan Teknis yang Dipilih (Approaches)

### Pilihan A (Dipilih oleh Klien): Server Lokal All-in-One (Node.js + SQLite) + Aplikasi Android Native (Kotlin WebView LockTask)
- **Alasan Pemilihan:** Paling praktis untuk Operator SMA N 3 Buru (tidak perlu instal dan menyalakan XAMPP/MySQL yang rawan bentrok port), seluruh data tersimpan dalam satu file database lokal yang mudah di-backup, cepat menangani ratusan koneksi Wi-Fi lokal, serta aplikasi Android Native memberikan kontrol penuh atas penguncian layar (*LockTask*) dan pemblokiran *screenshot* (`FLAG_SECURE`).

### Pilihan B (Ditolak): PHP + MySQL (XAMPP) + Flutter
- **Alasan Ditolak:** Membutuhkan setup MySQL/Apache terpisah di komputer operator dan ukuran APK Flutter lebih besar untuk HP siswa spesifikasi rendah.

---

## 5. Rincian Desain Arsitektur & Alur Sistem (Bagian yang Telah Disepakati)

### A. Format Import Soal Microsoft Word (`.docx`) di Panel Guru
Agar guru sangat mudah mengetik soal di Microsoft Word tanpa tabel yang rumit, sistem menyediakan tombol **Unduh Template Word (`.docx`)** dan membaca format penanda sederhana berikut:
```text
[PG]
1. Perhatikan reaksi kimia berikut. Manakah pernyataan yang tepat mengenai pengaruh katalis terhadap laju reaksi?
A. Tidak bergantung pada konsentrasi
B. Menurunkan energi aktivasi reaksi
C. Memperkecil tumbukan efektif
D. Konsentrasi pereaksi selalu tetap
E. Mengubah entalpi reaksi akhir
KUNCI: B

[ESAI]
31. Jelaskan 3 faktor utama yang memengaruhi kesetimbangan kimia beserta contohnya di industri!
```
- Parser `.docx` (menggunakan `mammoth` di server) membaca teks beserta gambar yang disisipkan di dalam Word (gambar otomatis diekstrak menjadi base64/file lokal sehingga tampil di layar HP siswa).
- Selain import `.docx`, guru tetap bisa menambah/mengedit soal secara langsung melalui form di Panel Guru jika ada revisi mendadak.

### B. Pusat Cetak 4 Dokumen Administrasi di Panel Operator
Operator dapat memilih **Kelas / Ruang Ujian / Jadwal** lalu menekan tombol cetak (otomatis terformat rapi siap *Print* / *Save as PDF* ukuran A4 lengkap dengan Kop **PEMERINTAH PROVINSI MALUKU — DINAS PENDIDIKAN DAN KEBUDAYAAN — SMA NEGERI 3 BURU**):
1. **Daftar Hadir Peserta:** Tabel berisi No, Nomor Peserta, Nama Siswa, Kelas, dan Kolom Tanda Tangan zig-zag (ganjil di kiri, genap di kanan), plus blok tanda tangan Pengawas Ruangan dan Berita Acara singkat di bawahnya.
2. **Kartu Peserta Ujian:** Kartu resmi siswa (8–10 kartu per halaman A4) berisi Kop Sekolah, Nama, Nomor Peserta/NISN, Kelas, Ruang, dan tempat foto/tanda tangan Kepala Sekolah.
3. **Kartu Login CBT:** Kartu berisi Nomor Peserta (Username), Password, Ruang, dan **QR Code / Info IP Server** untuk dibagikan kepada siswa.
4. **Kartu Meja:** Kartu berukuran besar (4 kartu per halaman A4) dengan ukuran huruf Nomor Peserta & Nama Siswa yang besar untuk ditempel di meja ujian siswa.

### C. Mekanisme Keamanan & Penguncian Kecurangan (Exambro + Pengawas)
1. **Di Aplikasi Android Exambro:**
   - Mengaktifkan `window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)` untuk memblokir *screenshot* dan perekaman layar.
   - Memanggil `startLockTask()` (*Screen Pinning*) saat masuk ke mode ujian dan menyembunyikan *system navigation bars* (*Immersive Sticky Mode*).
   - Mengirimkan header khusus `X-Exambro-App: SMAN3BURU-SECURE` agar siswa tidak bisa membuka halaman ujian menggunakan browser biasa (Chrome/Opera) di luar aplikasi Exambro (dengan opsi mode simulasi bagi guru/operator saat uji coba di laptop).
2. **Deteksi Pindah Aplikasi & Kunci Otomatis:**
   - Jika siswa memaksa keluar dari Pin Layar, berpindah aplikasi, atau membuka layar belah, event `visibilitychange` / `blur` / native callback `onUserLeaveHint` langsung memanggil endpoint `/api/ujian/pelanggaran`.
   - Status sesi ujian siswa di database langsung berubah menjadi `LOCKED` (`Terkunci`), layar HP siswa berubah menjadi **Layar Merah Peringatan Terkunci**, dan di **Panel Pengawas Ruangan** langsung muncul peringatan merah berbunyi/berkedip beserta tombol **"🔓 Buka Kunci"**.
   - Siswa hanya bisa melanjutkan ujian setelah Pengawas Ruangan menekan tombol **Buka Kunci** di HP Pengawas.

---

## 6. Keputusan Teknis oleh Builder (Left to the Builder)
Keputusan teknis berikut ditetapkan sebagai standar terbaik (*sensible defaults*) oleh pengembang agar sistem langsung siap pakai:
- **Stack Server:** Node.js + Express + `better-sqlite3` (atau SQLite native dengan pembungkus sinkron/asinkron yang stabil) + `mammoth` (baca `.docx` Word) + `xlsx` (import data siswa Excel & export nilai PG Excel).
- **Penyimpanan Aset Lokal (Offline-First):** Semua styling CSS modern, ikon SVG, dan skrip interaktif disajikan langsung dari folder `public/` server lokal tanpa bergantung pada CDN internet, sehingga dijamin 100% tampil sempurna saat Wi-Fi sekolah tidak memiliki koneksi internet.
- **Akun Bawaan (Default Seed Data):** Saat server pertama kali dijalankan, sistem otomatis menyediakan akun contoh **Operator**, **Guru Mapel**, **Pengawas Ruangan**, serta contoh **Data Siswa & Bank Soal SMA N 3 Buru** agar klien dapat langsung mencoba semua fitur detik itu juga.
- **Pembaruan Real-time (Polling Ringan / SSE):** Panel Pengawas dan Operator memperbarui status siswa dan peringatan pelanggaran secara otomatis setiap 2–3 detik.
