$ErrorActionPreference = "Stop"

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$buildTools = "$sdk\build-tools\35.0.0"
$androidJar = "$sdk\platforms\android-35\android.jar"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$appMain = "$root\android-exambro\app\src\main"
$outDir = "$root\android-exambro\build-out"

if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force -Path "$outDir\compiled_res", "$outDir\gen", "$outDir\classes", "$outDir\dex" | Out-Null

Write-Host "1. Mengompilasi resource layout XML dengan aapt2..."
& "$buildTools\aapt2.exe" compile --dir "$appMain\res" -o "$outDir\compiled_res\res.zip"

Write-Host "2. Membuat R.java dan base APK..."
& "$buildTools\aapt2.exe" link `
  -I $androidJar `
  --manifest "$appMain\AndroidManifest.xml" `
  --java "$outDir\gen" `
  --min-sdk-version 23 `
  --target-sdk-version 35 `
  --version-code 1 `
  --version-name "1.0.0" `
  -o "$outDir\unaligned.apk" `
  "$outDir\compiled_res\res.zip"

Write-Host "3. Mengompilasi kode Java Exambro dengan javac..."
& javac -source 1.8 -target 1.8 -encoding UTF-8 `
  -cp $androidJar `
  -d "$outDir\classes" `
  "$outDir\gen\id\sch\sman3buru\exambro\R.java" `
  "$appMain\java\id\sch\sman3buru\exambro\MainActivity.java"

Write-Host "4. Mengonversi bytecode ke classes.dex dengan d8..."
$classFiles = Get-ChildItem -Path "$outDir\classes" -Filter "*.class" -Recurse | Select-Object -ExpandProperty FullName
& "$buildTools\d8.bat" --lib $androidJar --min-api 23 --output "$outDir\dex" $classFiles

Write-Host "5. Memasukkan classes.dex ke dalam paket APK dengan jar..."
& jar -uf "$outDir\unaligned.apk" -C "$outDir\dex" classes.dex

Write-Host "6. Merapikan APK dengan zipalign..."
& "$buildTools\zipalign.exe" -f -p 4 "$outDir\unaligned.apk" "$outDir\aligned.apk"

$keystore = "$outDir\sman3buru-release.jks"
if (-not (Test-Path $keystore)) {
  Write-Host "7. Membuat sertifikat tanda tangan digital APK SMAN 3 Buru..."
  & keytool -genkeypair -v `
    -keystore $keystore `
    -alias sman3buru `
    -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass sman3buru123 -keypass sman3buru123 `
    -dname "CN=SMA Negeri 3 Buru, OU=Panitia CBT, O=SMAN 3 Buru, L=Buru, ST=Maluku, C=ID"
}

$finalApk = "$root\public\Exambro-SMAN3-Buru.apk"
Write-Host "8. Menandatangani APK resmi (v1 + v2 + v3 signature) dengan apksigner..."
& "$buildTools\apksigner.bat" sign `
  --ks $keystore `
  --ks-key-alias sman3buru `
  --ks-pass pass:sman3buru123 `
  --key-pass pass:sman3buru123 `
  --out $finalApk `
  "$outDir\aligned.apk"

& "$buildTools\apksigner.bat" verify --verbose $finalApk
Write-Host "SELESAI! File APK siap diinstal: $finalApk"
