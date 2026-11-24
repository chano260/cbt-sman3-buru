package id.sch.sman3buru.ujian;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Aplikasi Ujian CBT SMA Negeri 3 Buru.
 *
 * Alur: layar kode masuk (tombol angka di layar, tanpa keyboard HP) → server mengecek kode →
 * halaman login ujian (ujian.html) di WebView yang terkunci → keluar hanya dengan password pengawas.
 * Tidak ada kode/password yang tertanam di APK: semuanya dicek server.
 */
public class MainActivity extends Activity {

    private static final String DEFAULT_SERVER = "https://cbt.smanegeri3buru.my.id";
    private static final String PREFS = "ujian_cbt_sman3buru";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_QUIT_HASH = "quit_hash";
    private static final int MAX_CODE_LEN = 8;
    private static final int MAX_WRONG_BEFORE_PAUSE = 5;
    private static final long WRONG_PAUSE_MS = 60_000;
    /** Abaikan hilang fokus sesaat setelah masuk (dialog sistem "sematkan aplikasi?"). */
    private static final long LOCK_PROMPT_GRACE_MS = 8_000;

    private static final int BLUE = 0xFF27449B;
    private static final int BLUE_SOFT = 0xFFEEF2FA;
    private static final int INK = 0xFF15181C;
    private static final int MUTED = 0xFF6B7280;
    private static final int RED = 0xFFD42A30;
    private static final int BG = 0xFFF5F6F8;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;

    private FrameLayout root;
    private LinearLayout codeScreen;
    private FrameLayout examScreen;
    private WebView web;
    private TextView dotsView;
    private TextView messageView;
    private Button enterBtn;

    private final StringBuilder code = new StringBuilder();
    private int wrongCount = 0;
    private long pausedUntil = 0;
    private int logoTaps = 0;
    private long firstLogoTapAt = 0;

    private boolean inExam = false;
    private boolean exiting = false;
    private boolean dialogOpen = false;
    private long examStartedAt = 0;
    /** true sejak ujian.html memanggil enterLockMode() (soal dimulai) sampai exitLockMode() (ujian selesai). */
    private volatile boolean examRunning = false;

    private ToneGenerator alarmTone;
    private int savedAlarmVolume = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Blokir screenshot, rekam layar & pratinjau di Recent Apps
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        codeScreen = buildCodeScreen();
        examScreen = buildExamScreen();
        examScreen.setVisibility(View.GONE);
        root.addView(codeScreen, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(examScreen, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        immersive();
    }

    // ------------------------------------------------------------------ layar kode masuk

    private LinearLayout buildCodeScreen() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(dp(24), dp(40), dp(24), dp(24));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.logo);
        logo.setAdjustViewBounds(true);
        logo.setOnClickListener(v -> onLogoTapped());
        box.addView(logo, new LinearLayout.LayoutParams(dp(88), dp(104)));

        TextView title = text("Ujian CBT", 22, INK, true);
        title.setPadding(0, dp(16), 0, 0);
        box.addView(title);
        box.addView(text("SMA Negeri 3 Buru", 15, MUTED, false));

        TextView prompt = text("Masukkan kode masuk dari pengawas", 15, INK, false);
        prompt.setPadding(0, dp(28), 0, dp(12));
        box.addView(prompt);

        dotsView = text("", 28, BLUE, true);
        dotsView.setLetterSpacing(0.3f);
        box.addView(dotsView);
        renderDots();

        messageView = text("", 14, RED, false);
        messageView.setPadding(0, dp(8), 0, dp(8));
        messageView.setMinHeight(dp(40));
        box.addView(messageView);

        GridLayout pad = new GridLayout(this);
        pad.setColumnCount(3);
        String[] keys = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "Masuk"};
        for (String k : keys) {
            Button b = new Button(this);
            b.setText(k);
            b.setAllCaps(false);
            b.setTextSize(TypedValue.COMPLEX_UNIT_SP, k.length() > 1 ? 16 : 24);
            boolean primary = "Masuk".equals(k);
            b.setTextColor(primary ? Color.WHITE : INK);
            b.setBackground(rounded(primary ? BLUE : Color.WHITE, dp(14), primary ? 0 : 0x1F15181C));
            b.setOnClickListener(v -> onKey(k));
            if (primary) enterBtn = b;
            GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
            lp.width = dp(92);
            lp.height = dp(64);
            lp.setMargins(dp(6), dp(6), dp(6), dp(6));
            pad.addView(b, lp);
        }
        box.addView(pad, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView foot = text("Tanpa aplikasi keyboard tambahan. Jawaban PG cukup diketuk.", 12, MUTED, false);
        foot.setPadding(0, dp(20), 0, 0);
        box.addView(foot);
        return box;
    }

    private void onKey(String k) {
        if (System.currentTimeMillis() < pausedUntil) return;
        if ("⌫".equals(k)) {
            if (code.length() > 0) code.deleteCharAt(code.length() - 1);
        } else if ("Masuk".equals(k)) {
            submitCode();
            return;
        } else if (code.length() < MAX_CODE_LEN) {
            code.append(k);
        }
        messageView.setText("");
        renderDots();
    }

    private void renderDots() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.max(4, code.length()); i++) sb.append(i < code.length() ? "●" : "○");
        dotsView.setText(sb.toString());
    }

    private void submitCode() {
        if (code.length() < 4) {
            messageView.setText("Kode masuk minimal 4 angka.");
            return;
        }
        final String entered = code.toString();
        enterBtn.setEnabled(false);
        messageView.setTextColor(MUTED);
        messageView.setText("Memeriksa kode...");
        new Thread(() -> {
            HttpResult r = post("/api/app/verify-code", "{\"code\":\"" + entered + "\"}");
            ui.post(() -> {
                enterBtn.setEnabled(true);
                messageView.setTextColor(RED);
                if (r.status == 200) {
                    String ticket = r.json != null ? r.json.optString("ticket", "") : "";
                    code.setLength(0);
                    renderDots();
                    messageView.setText("");
                    wrongCount = 0;
                    enterExam(ticket);
                } else if (r.status == 401) {
                    wrongCount++;
                    code.setLength(0);
                    renderDots();
                    if (wrongCount >= MAX_WRONG_BEFORE_PAUSE) {
                        wrongCount = 0;
                        startPause();
                    } else {
                        messageView.setText("Kode masuk salah. Tanyakan kode ke pengawas.");
                    }
                } else if (r.status == 404) {
                    messageView.setText("Kode masuk belum diatur operator.");
                } else if (r.status == 429) {
                    messageView.setText("Terlalu banyak percobaan. Tunggu beberapa menit.");
                } else {
                    messageView.setText("Tidak bisa terhubung ke server ujian. Periksa internet / Wi-Fi.");
                }
            });
        }).start();
    }

    private void startPause() {
        pausedUntil = System.currentTimeMillis() + WRONG_PAUSE_MS;
        tickPause();
    }

    private void tickPause() {
        long left = pausedUntil - System.currentTimeMillis();
        if (left <= 0) {
            messageView.setText("");
            return;
        }
        messageView.setText("Kode salah 5 kali. Coba lagi dalam " + ((left + 999) / 1000) + " detik.");
        ui.postDelayed(this::tickPause, 1000);
    }

    private void onLogoTapped() {
        long now = System.currentTimeMillis();
        if (now - firstLogoTapAt > 3000) {
            firstLogoTapAt = now;
            logoTaps = 0;
        }
        if (++logoTaps >= 5) {
            logoTaps = 0;
            askSupervisorPassword("Pengaturan", "Masukkan password pengawas untuk membuka pengaturan.", this::showServerSettings);
        }
    }

    private void showServerSettings() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(serverUrl());
        dialogOpen = true;
        new AlertDialog.Builder(this)
            .setTitle("Alamat server ujian")
            .setMessage("Bawaan: " + DEFAULT_SERVER)
            .setView(wrapPadding(input))
            .setPositiveButton("Simpan", (d, w) -> {
                String v = normalizeUrl(input.getText().toString());
                prefs.edit().putString(KEY_SERVER, v.isEmpty() ? DEFAULT_SERVER : v).apply();
                Toast.makeText(this, "Alamat server disimpan", Toast.LENGTH_SHORT).show();
            })
            .setNeutralButton("Pakai bawaan", (d, w) -> prefs.edit().remove(KEY_SERVER).apply())
            .setNegativeButton("Batal", null)
            .setOnDismissListener(d -> { dialogOpen = false; immersive(); })
            .show();
    }

    // ------------------------------------------------------------------ layar ujian

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private FrameLayout buildExamScreen() {
        FrameLayout frame = new FrameLayout(this);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        frame.addView(column, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web = new WebView(this);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setUserAgentString(ws.getUserAgentString() + " SMAN3BURU-UJIAN-ANDROID/2.0");

        // Matikan tekan-lama (seleksi teks / salin-tempel)
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        web.setOnLongClickListener(v -> true);

        web.addJavascriptInterface(new Bridge(), "AndroidExambro");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return blockForeign(request.getUrl().toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return blockForeign(url);
            }
        });
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(BLUE);
        bar.setPadding(dp(12), 0, dp(6), 0);
        TextView barTitle = new TextView(this);
        barTitle.setText("Ujian CBT · SMA Negeri 3 Buru");
        barTitle.setTextColor(Color.WHITE);
        barTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        bar.addView(barTitle, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button exit = new Button(this);
        exit.setText("Keluar");
        exit.setAllCaps(false);
        exit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        exit.setTextColor(Color.WHITE);
        exit.setBackground(rounded(0x33FFFFFF, dp(14), 0));
        exit.setPadding(dp(14), 0, dp(14), 0);
        exit.setMinHeight(0);
        exit.setMinimumHeight(0);
        exit.setOnClickListener(v -> askSupervisorPassword("Keluar dari aplikasi ujian",
            "Hanya pengawas. Masukkan password pengawas untuk keluar.", this::exitApp));
        bar.addView(exit, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(28)));
        column.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(36)));
        column.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        return frame;
    }

    private boolean blockForeign(String url) {
        String host = hostOf(serverUrl());
        if (url != null && host != null && host.equalsIgnoreCase(hostOf(url))) return false;
        Toast.makeText(this, "Halaman di luar server ujian diblokir.", Toast.LENGTH_SHORT).show();
        return true;
    }

    private void enterExam(String ticket) {
        String server = serverUrl();
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (ticket != null && !ticket.isEmpty()) {
            cm.setCookie(server, "cbt_app=" + ticket + "; Path=/");
            cm.flush();
        }
        codeScreen.setVisibility(View.GONE);
        examScreen.setVisibility(View.VISIBLE);
        inExam = true;
        exiting = false;
        examStartedAt = System.currentTimeMillis();
        try {
            startLockTask();
        } catch (Exception ignored) {
            // HP tidak mendukung penyematan layar: ujian tetap berjalan dengan pengaman lain
        }
        immersive();
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        if (ticket != null && !ticket.isEmpty()) headers.put("X-App-Ticket", ticket);
        web.loadUrl(server + "/ujian.html", headers);
    }

    private void exitApp() {
        exiting = true;
        stopLeaveAlarm();
        try {
            web.evaluateJavascript("window.cbtSupervisorExit && window.cbtSupervisorExit()", null);
        } catch (Exception ignored) {
        }
        ui.postDelayed(() -> {
            try {
                stopLockTask();
            } catch (Exception ignored) {
            }
            CookieManager.getInstance().removeAllCookies(null);
            finishAndRemoveTask();
        }, 1500);
    }

    // ------------------------------------------------------------------ password pengawas

    private void askSupervisorPassword(String title, String message, Runnable onOk) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        input.setHint("Password pengawas");
        dialogOpen = true;
        new AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setView(wrapPadding(input))
            .setPositiveButton("Lanjut", (d, w) -> verifySupervisor(input.getText().toString(), onOk))
            .setNegativeButton("Batal", null)
            .setOnDismissListener(d -> { dialogOpen = false; immersive(); })
            .show();
    }

    private void verifySupervisor(String password, Runnable onOk) {
        final String pw = password.trim();
        new Thread(() -> {
            JSONObject body = new JSONObject();
            try { body.put("password", pw); } catch (Exception ignored) { }
            HttpResult r = post("/api/app/verify-quit", body.toString());
            ui.post(() -> {
                if (r.status == 200) {
                    String hash = r.json != null ? r.json.optString("hash", "") : "";
                    if (!hash.isEmpty()) prefs.edit().putString(KEY_QUIT_HASH, hash).apply();
                    onOk.run();
                } else if (r.status == 401) {
                    Toast.makeText(this, "Password pengawas salah.", Toast.LENGTH_LONG).show();
                } else {
                    // Server tak terjangkau / belum diatur: pakai hash yang pernah dicek benar di HP ini
                    String saved = prefs.getString(KEY_QUIT_HASH, "");
                    if (!saved.isEmpty() && saved.equalsIgnoreCase(sha256(pw))) {
                        onOk.run();
                    } else if (saved.isEmpty()) {
                        showEmergencyHelp(r.status == 404);
                    } else {
                        Toast.makeText(this, "Password pengawas salah.", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }).start();
    }

    private void showEmergencyHelp(boolean notConfigured) {
        dialogOpen = true;
        new AlertDialog.Builder(this)
            .setTitle(notConfigured ? "Password pengawas belum diatur" : "Server tidak bisa dihubungi")
            .setMessage((notConfigured
                ? "Operator belum mengatur password pengawas (password keluar SEB) di Panel Operator.\n\n"
                : "Password pengawas tidak bisa dicek karena server tidak terjangkau.\n\n")
                + "Keluar darurat: tekan dan tahan tombol Kembali + Ikhtisar (Recent) bersamaan untuk melepas "
                + "sematan layar, lalu tutup aplikasi. Bila siswa keluar di tengah ujian, tetap tercatat sebagai pelanggaran.")
            .setPositiveButton("Mengerti", null)
            .setOnDismissListener(d -> { dialogOpen = false; immersive(); })
            .show();
    }

    // ------------------------------------------------------------------ deteksi keluar

    private void reportLeave(String reason) {
        if (!inExam || exiting || dialogOpen) return;
        if (System.currentTimeMillis() - examStartedAt < LOCK_PROMPT_GRACE_MS) return;
        if (examRunning) startLeaveAlarm();
        String js = "window.onExambroViolationDetected && window.onExambroViolationDetected(" + JSONObject.quote(reason) + ")";
        try {
            web.evaluateJavascript(js, null);
        } catch (Exception ignored) {
        }
    }

    /**
     * Alarm keluar: HP siswa berbunyi keras dan bergetar sampai siswa kembali ke layar ujian,
     * supaya pengawas di ruangan langsung tahu HP mana yang keluar. Memakai stream alarm sehingga
     * tetap berbunyi saat HP dalam mode senyap/getar (kecuali "Jangan Ganggu" total).
     */
    private void startLeaveAlarm() {
        if (alarmTone != null) return;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am != null) {
            try {
                savedAlarmVolume = am.getStreamVolume(AudioManager.STREAM_ALARM);
                am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
            } catch (Exception ignored) {
                // Mode "Jangan Ganggu" bisa menolak perubahan volume: bunyi tetap dicoba
            }
        }
        try {
            alarmTone = new ToneGenerator(AudioManager.STREAM_ALARM, ToneGenerator.MAX_VOLUME);
            alarmTone.startTone(ToneGenerator.TONE_CDMA_EMERGENCY_RINGBACK);
        } catch (Exception e) {
            alarmTone = null;
        }
        Vibrator vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator != null && vibrator.hasVibrator()) {
            long[] pattern = {0, 700, 300};
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            } else {
                vibrator.vibrate(pattern, 0);
            }
        }
    }

    private void stopLeaveAlarm() {
        if (alarmTone != null) {
            try {
                alarmTone.stopTone();
                alarmTone.release();
            } catch (Exception ignored) {
            }
            alarmTone = null;
        }
        Vibrator vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator != null) vibrator.cancel();
        if (savedAlarmVolume >= 0) {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            try {
                if (am != null) am.setStreamVolume(AudioManager.STREAM_ALARM, savedAlarmVolume, 0);
            } catch (Exception ignored) {
            }
            savedAlarmVolume = -1;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        stopLeaveAlarm();
    }

    @Override
    protected void onDestroy() {
        stopLeaveAlarm();
        super.onDestroy();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        reportLeave("Siswa menekan tombol Home / pindah aplikasi di Android");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            stopLeaveAlarm();
            immersive();
        } else {
            reportLeave("Siswa membuka panel notifikasi / keluar dari layar ujian");
        }
    }

    @Override
    public void onMultiWindowModeChanged(boolean isInMultiWindowMode) {
        super.onMultiWindowModeChanged(isInMultiWindowMode);
        if (isInMultiWindowMode) reportLeave("Siswa mencoba membuka layar belah (split screen)");
    }

    @Override
    public void onBackPressed() {
        if (!inExam) super.onBackPressed();
        // Saat ujian tombol Kembali tidak berfungsi
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (inExam && keyCode == KeyEvent.KEYCODE_BACK) return true;
        return super.onKeyDown(keyCode, event);
    }

    private class Bridge {
        /** Dipanggil ujian.html saat soal mulai dikerjakan: sejak ini keluar aplikasi membunyikan alarm. */
        @JavascriptInterface
        public void enterLockMode() {
            ui.post(() -> {
                examRunning = true;
                // Prompt "sematkan aplikasi?" bisa muncul lagi: beri masa tenggang yang sama seperti saat masuk
                examStartedAt = System.currentTimeMillis();
                try {
                    startLockTask();
                } catch (Exception ignored) {
                }
            });
        }

        /** Dipanggil ujian.html setelah ujian selesai: lepaskan sematan layar. */
        @JavascriptInterface
        public void exitLockMode() {
            ui.post(() -> {
                examRunning = false;
                stopLeaveAlarm();
                try {
                    stopLockTask();
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public String appVersion() {
            return "2.0.0";
        }
    }

    // ------------------------------------------------------------------ utilitas

    private static class HttpResult {
        int status;
        JSONObject json;
    }

    private HttpResult post(String path, String jsonBody) {
        HttpResult r = new HttpResult();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(serverUrl() + path).openConnection();
            c.setConnectTimeout(10_000);
            c.setReadTimeout(15_000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("User-Agent", "SMAN3BURU-UJIAN-ANDROID/2.0");
            try (OutputStream os = c.getOutputStream()) {
                os.write(jsonBody.getBytes("UTF-8"));
            }
            r.status = c.getResponseCode();
            InputStream is = r.status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (is != null) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] b = new byte[4096];
                int n;
                while ((n = is.read(b)) > 0) buf.write(b, 0, n);
                is.close();
                try { r.json = new JSONObject(buf.toString("UTF-8")); } catch (Exception ignored) { }
            }
        } catch (Exception e) {
            r.status = 0; // tidak terhubung
        } finally {
            if (c != null) c.disconnect();
        }
        return r;
    }

    private String serverUrl() {
        String v = prefs.getString(KEY_SERVER, DEFAULT_SERVER);
        return v == null || v.isEmpty() ? DEFAULT_SERVER : v;
    }

    private static String normalizeUrl(String raw) {
        String v = raw == null ? "" : raw.trim();
        if (v.isEmpty()) return "";
        if (!v.startsWith("http://") && !v.startsWith("https://")) v = "https://" + v;
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        if (v.endsWith("/ujian.html")) v = v.substring(0, v.length() - "/ujian.html".length());
        return v;
    }

    private static String hostOf(String url) {
        try {
            return new URL(url).getHost();
        } catch (Exception e) {
            return null;
        }
    }

    private static String sha256(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte x : d) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private GradientDrawable rounded(int fill, int radius, int strokeColor) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(radius);
        if (strokeColor != 0) g.setStroke(dp(1), strokeColor);
        return g;
    }

    private View wrapPadding(View v) {
        FrameLayout f = new FrameLayout(this);
        f.setPadding(dp(20), dp(8), dp(20), 0);
        f.addView(v);
        return f;
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
