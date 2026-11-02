package id.sch.sman3buru.exambro

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var setupLayout: LinearLayout
    private lateinit var serverUrlInput: EditText
    private lateinit var connectBtn: Button
    private lateinit var examWebView: WebView
    private var isLockModeActive: Boolean = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. Blokir Screenshot, Screen Recording & Tampilan di Recent Apps
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )
        // Jaga layar tetap menyala selama ujian berlangsung
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_main)
        enableImmersiveFullscreen()

        setupLayout = findViewById(R.id.setupLayout)
        serverUrlInput = findViewById(R.id.serverUrlInput)
        connectBtn = findViewById(R.id.connectBtn)
        examWebView = findViewById(R.id.examWebView)

        val prefs = getSharedPreferences("sman3buru_exambro", Context.MODE_PRIVATE)
        val savedUrl = prefs.getString("server_url", "http://192.168.1.100:8080") ?: "http://192.168.1.100:8080"
        serverUrlInput.setText(savedUrl)

        val ws = examWebView.settings
        ws.javaScriptEnabled = true
        ws.domStorageEnabled = true
        ws.setSupportZoom(false)
        ws.builtInZoomControls = false
        ws.displayZoomControls = false
        ws.userAgentString = ws.userAgentString + " SMAN3BURU-EXAMBRO-ANDROID/1.0"

        examWebView.addJavascriptInterface(ExambroJsBridge(), "AndroidExambro")

        examWebView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val targetUrl = request?.url?.toString() ?: return false
                val baseHost = serverUrlInput.text.toString().trim()
                // Blokir semua percobaan membuka link di luar IP Server Lokal Sekolah
                if (!targetUrl.startsWith(baseHost)) {
                    Toast.makeText(
                        this@MainActivity,
                        "Akses keluar diblokir oleh Exambro SMAN 3 Buru!",
                        Toast.LENGTH_SHORT
                    ).show()
                    return true
                }
                return false
            }
        }
        examWebView.webChromeClient = WebChromeClient()

        connectBtn.setOnClickListener {
            var rawUrl = serverUrlInput.text.toString().trim()
            if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
                rawUrl = "http://$rawUrl"
            }
            val cleanBase = rawUrl.trimEnd('/')
            prefs.edit().putString("server_url", cleanBase).apply()

            setupLayout.visibility = View.GONE
            examWebView.visibility = View.VISIBLE

            // Aktifkan Screen Pinning (LockTask Mode) begitu masuk ke halaman ujian
            enterExamLockTask()

            val headers = mapOf("X-Exambro-App" to "SMAN3BURU-SECURE")
            examWebView.loadUrl("$cleanBase/ujian.html", headers)
        }
    }

    private fun enterExamLockTask() {
        try {
            startLockTask()
            isLockModeActive = true
            enableImmersiveFullscreen()
        } catch (_: Exception) {
        }
    }

    private fun exitExamLockTask() {
        try {
            stopLockTask()
            isLockModeActive = false
        } catch (_: Exception) {
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (isLockModeActive) {
            examWebView.evaluateJavascript(
                "window.onExambroViolationDetected && window.onExambroViolationDetected('Siswa menekan tombol keluar / pindah aplikasi di Android');",
                null
            )
        }
    }

    override fun onMultiWindowModeChanged(isInMultiWindowMode: Boolean) {
        super.onMultiWindowModeChanged(isInMultiWindowMode)
        if (isInMultiWindowMode && isLockModeActive) {
            examWebView.evaluateJavascript(
                "window.onExambroViolationDetected && window.onExambroViolationDetected('Siswa mencoba membuka Split-Screen / Layar Belah');",
                null
            )
        }
    }

    // Matikan tombol Back selama ujian terkunci
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            Toast.makeText(
                this,
                "Tombol Kembali dikunci selama ujian berlangsung!",
                Toast.LENGTH_SHORT
            ).show()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun enableImmersiveFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                controller.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                )
        }
    }

    inner class ExambroJsBridge {
        @JavascriptInterface
        fun enterLockMode() {
            runOnUiThread { enterExamLockTask() }
        }

        @JavascriptInterface
        fun exitLockMode() {
            runOnUiThread { exitExamLockTask() }
        }
    }
}
