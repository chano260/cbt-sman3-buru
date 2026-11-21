# Arsip kode Android lama

`MainActivity.kt` adalah versi Kotlin lama dari activity Exambro. File ini dipindah ke sini
supaya tidak bentrok dengan `app/src/main/java/.../MainActivity.java` (dua class dengan nama
yang sama di satu package membuat build Gradle / Android Studio gagal).

Sumber resmi sekarang adalah **`MainActivity.java`**, karena versi Java inilah yang dikompilasi
oleh `build-apk.ps1` menjadi `public/Exambro-SMAN3-Buru.apk`.

File di folder ini tidak ikut dikompilasi. Hapus folder ini jika sudah tidak diperlukan.
