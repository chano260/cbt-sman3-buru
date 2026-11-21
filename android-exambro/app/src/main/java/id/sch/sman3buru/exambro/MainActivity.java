package id.sch.sman3buru.exambro;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.io.File;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private static final int REQUEST_ESSAY_PHOTO = 1001;

    private LinearLayout setupLayout;
    private EditText serverUrlInput;
    private Button connectBtn;
    private WebView examWebView;
    private boolean isLockModeActive = false;

    // Pemilih file dari <input type="file"> di halaman ujian (foto lembar jawaban esai)
    private ValueCallback<Uri[]> pendingFileCallback;
    private boolean capturingPhoto = false;
    private boolean launchedCamera = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 1. Blokir Screenshot, Screen Record & Recent Apps Preview (FLAG_SECURE)
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_main);
        enableImmersiveFullscreen();

        setupLayout = findViewById(R.id.setupLayout);
        serverUrlInput = findViewById(R.id.serverUrlInput);
        connectBtn = findViewById(R.id.connectBtn);
        examWebView = findViewById(R.id.examWebView);

        final SharedPreferences prefs = getSharedPreferences("sman3buru_exambro", Context.MODE_PRIVATE);
        String savedUrl = prefs.getString("server_url", "http://192.168.110.13:8080");
        serverUrlInput.setText(savedUrl);

        WebSettings ws = examWebView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setUserAgentString(ws.getUserAgentString() + " SMAN3BURU-EXAMBRO-ANDROID/1.0");

        examWebView.addJavascriptInterface(new ExambroJsBridge(), "AndroidExambro");

        examWebView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return false;
                String targetUrl = request.getUrl().toString();
                String baseHost = serverUrlInput.getText().toString().trim();
                if (!targetUrl.startsWith(baseHost)) {
                    Toast.makeText(
                        MainActivity.this,
                        "Akses keluar ke internet diblokir oleh Exambro SMAN 3 Buru!",
                        Toast.LENGTH_SHORT
                    ).show();
                    return true;
                }
                return false;
            }
        });
        // Tanpa onShowFileChooser, WebView Android mengabaikan ketukan pada <input type="file">,
        // sehingga tombol "Buka Kamera & Foto Lembar Jawaban" tidak melakukan apa-apa.
        examWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                return openEssayPhotoChooser(filePathCallback, fileChooserParams);
            }
        });

        connectBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String rawUrl = serverUrlInput.getText().toString().trim();
                if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
                    rawUrl = "http://" + rawUrl;
                }
                while (rawUrl.endsWith("/")) {
                    rawUrl = rawUrl.substring(0, rawUrl.length() - 1);
                }
                prefs.edit().putString("server_url", rawUrl).apply();

                setupLayout.setVisibility(View.GONE);
                examWebView.setVisibility(View.VISIBLE);

                // Aktifkan Screen Pinning / LockTask Mode begitu masuk ujian
                enterExamLockTask();

                Map<String, String> headers = new HashMap<>();
                headers.put("X-Exambro-App", "SMAN3BURU-SECURE");
                examWebView.loadUrl(rawUrl + "/ujian.html", headers);
            }
        });
    }

    private void enterExamLockTask() {
        try {
            startLockTask();
            isLockModeActive = true;
            enableImmersiveFullscreen();
        } catch (Exception ignored) {
        }
    }

    private void exitExamLockTask() {
        try {
            stopLockTask();
            isLockModeActive = false;
        } catch (Exception ignored) {
        }
    }

    /**
     * Buka kamera untuk memotret lembar jawaban esai (atau galeri jika kamera tidak tersedia).
     * Kamera dibuka di task yang sama dengan Exambro (tanpa FLAG_ACTIVITY_NEW_TASK) agar tetap
     * diizinkan saat layar disematkan (screen pinning), dan dengan FLAG_ACTIVITY_NO_USER_ACTION
     * agar tidak dianggap siswa meninggalkan aplikasi.
     */
    private boolean openEssayPhotoChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
        }
        pendingFileCallback = callback;

        Intent intent = null;
        launchedCamera = false;
        Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (camera.resolveActivity(getPackageManager()) != null) {
            File target = PhotoProvider.photoFile(this);
            if (target.exists()) target.delete();
            Uri output = PhotoProvider.photoUri();
            camera.putExtra(MediaStore.EXTRA_OUTPUT, output);
            camera.setClipData(ClipData.newRawUri("", output));
            camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent = camera;
            launchedCamera = true;
        } else if (params != null) {
            intent = params.createIntent();
        }

        if (intent == null) {
            finishEssayPhotoChooser(null);
            Toast.makeText(this, "Kamera tidak ditemukan di HP ini.", Toast.LENGTH_LONG).show();
            return true;
        }

        intent.addFlags(Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        capturingPhoto = true;
        try {
            startActivityForResult(intent, REQUEST_ESSAY_PHOTO);
        } catch (ActivityNotFoundException | SecurityException e) {
            capturingPhoto = false;
            finishEssayPhotoChooser(null);
            Toast.makeText(this, "Kamera tidak dapat dibuka: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
        return true;
    }

    // Callback WebView WAJIB selalu dipanggil (juga saat batal); jika tidak, input file tidak bisa dipakai lagi.
    private void finishEssayPhotoChooser(Uri[] result) {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(result);
            pendingFileCallback = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_ESSAY_PHOTO) return;
        capturingPhoto = false;

        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            File photo = PhotoProvider.photoFile(this);
            if (launchedCamera && photo.exists() && photo.length() > 0) {
                result = new Uri[] { PhotoProvider.photoUri() };
            } else {
                result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
        }
        finishEssayPhotoChooser(result);
        enableImmersiveFullscreen();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Membuka kamera untuk foto esai adalah aksi resmi, bukan pelanggaran
        if (capturingPhoto) return;
        if (isLockModeActive && examWebView != null) {
            examWebView.evaluateJavascript(
                "window.onExambroViolationDetected && window.onExambroViolationDetected('Siswa menekan tombol Home / pindah aplikasi di Android');",
                null
            );
        }
    }

    @Override
    public void onMultiWindowModeChanged(boolean isInMultiWindowMode) {
        super.onMultiWindowModeChanged(isInMultiWindowMode);
        if (isInMultiWindowMode && isLockModeActive && examWebView != null) {
            examWebView.evaluateJavascript(
                "window.onExambroViolationDetected && window.onExambroViolationDetected('Siswa mencoba membuka Split-Screen / Layar Belah');",
                null
            );
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            Toast.makeText(
                this,
                "Tombol Kembali dikunci selama ujian berlangsung!",
                Toast.LENGTH_SHORT
            ).show();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void enableImmersiveFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            );
        }
    }

    public class ExambroJsBridge {
        @JavascriptInterface
        public void enterLockMode() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    enterExamLockTask();
                }
            });
        }

        @JavascriptInterface
        public void exitLockMode() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    exitExamLockTask();
                }
            });
        }
    }
}
