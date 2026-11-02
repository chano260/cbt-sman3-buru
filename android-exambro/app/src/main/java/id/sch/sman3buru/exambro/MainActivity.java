package id.sch.sman3buru.exambro;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private LinearLayout setupLayout;
    private EditText serverUrlInput;
    private Button connectBtn;
    private WebView examWebView;
    private boolean isLockModeActive = false;

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
        examWebView.setWebChromeClient(new WebChromeClient());

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

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
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
