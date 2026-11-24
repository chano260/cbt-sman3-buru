# Membangun APK "Ujian CBT SMAN 3 Buru" tanpa Gradle (aapt2 + javac + d8 + apksigner).
# Password keystore TIDAK ditulis di file ini: isi $env:CBT_KEYSTORE_PASS, atau akan ditanyakan saat build.
# Keystore disimpan di android-exambro\keystore\ (diabaikan git, *.jks). SIMPAN CADANGANNYA: tanpa file ini
# pembaruan aplikasi berikutnya tidak bisa dipasang menimpa versi lama.
$ErrorActionPreference = "Stop"

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$buildTools = "$sdk\build-tools\35.0.0"
$androidJar = "$sdk\platforms\android-35\android.jar"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$appMain = "$root\android-exambro\app\src\main"
$outDir = "$root\android-exambro\build-out"
$keyDir = "$root\android-exambro\keystore"
$keystore = "$keyDir\ujian-release.jks"
$alias = "sman3buru-ujian"
$versionCode = 2
$versionName = "2.0.0"

if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force -Path "$outDir\compiled_res", "$outDir\gen", "$outDir\classes", "$outDir\dex", $keyDir | Out-Null

$pass = $env:CBT_KEYSTORE_PASS
if (-not $pass) {
  $sec = Read-Host -AsSecureString "Password keystore APK"
  $pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if ($pass.Length -lt 6) { throw "Password keystore minimal 6 karakter." }

Write-Host "1. Mengompilasi resource dengan aapt2..."
& "$buildTools\aapt2.exe" compile --dir "$appMain\res" -o "$outDir\compiled_res\res.zip"
if ($LASTEXITCODE) { throw "aapt2 compile gagal" }

Write-Host "2. Membuat R.java dan APK dasar..."
& "$buildTools\aapt2.exe" link `
  -I $androidJar `
  --manifest "$appMain\AndroidManifest.xml" `
  --java "$outDir\gen" `
  --min-sdk-version 23 `
  --target-sdk-version 35 `
  --version-code $versionCode `
  --version-name $versionName `
  -o "$outDir\unaligned.apk" `
  "$outDir\compiled_res\res.zip"
if ($LASTEXITCODE) { throw "aapt2 link gagal" }

Write-Host "3. Mengompilasi kode Java..."
$javaFiles = @(Get-ChildItem -Path "$outDir\gen", "$appMain\java" -Filter "*.java" -Recurse | Select-Object -ExpandProperty FullName)
& javac -source 1.8 -target 1.8 -encoding UTF-8 -Xlint:-options `
  -cp $androidJar `
  -d "$outDir\classes" `
  $javaFiles
if ($LASTEXITCODE) { throw "javac gagal" }

Write-Host "4. Mengonversi ke classes.dex dengan d8..."
$classFiles = Get-ChildItem -Path "$outDir\classes" -Filter "*.class" -Recurse | Select-Object -ExpandProperty FullName
& "$buildTools\d8.bat" --lib $androidJar --min-api 23 --release --output "$outDir\dex" $classFiles
if ($LASTEXITCODE) { throw "d8 gagal" }

Write-Host "5. Memasukkan classes.dex ke APK..."
Push-Location "$outDir\dex"
& jar -uf "$outDir\unaligned.apk" classes.dex
Pop-Location
if ($LASTEXITCODE) { throw "jar gagal" }

Write-Host "6. zipalign..."
& "$buildTools\zipalign.exe" -f -p 4 "$outDir\unaligned.apk" "$outDir\aligned.apk"
if ($LASTEXITCODE) { throw "zipalign gagal" }

if (-not (Test-Path $keystore)) {
  Write-Host "7. Membuat keystore baru (sekali saja)..."
  & keytool -genkeypair -v `
    -keystore $keystore -alias $alias `
    -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass $pass -keypass $pass `
    -dname "CN=SMA Negeri 3 Buru, OU=Panitia CBT, O=SMAN 3 Buru, L=Buru, ST=Maluku, C=ID"
  if ($LASTEXITCODE) { throw "keytool gagal" }
}

$finalApk = "$root\public\Exambro-SMAN3-Buru.apk"
Write-Host "8. Menandatangani APK (v1 + v2 + v3)..."
& "$buildTools\apksigner.bat" sign --ks $keystore --ks-key-alias $alias `
  --ks-pass "pass:$pass" --key-pass "pass:$pass" `
  --out $finalApk "$outDir\aligned.apk"
if ($LASTEXITCODE) { throw "apksigner gagal" }

& "$buildTools\apksigner.bat" verify --verbose $finalApk
Write-Host "SELESAI: $finalApk"
