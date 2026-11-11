package com.boardlink.tablet;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Locale;

/** BoardLink tablet app: runs the board server and shows the drawing UI full screen. */
public class MainActivity extends Activity {

    private static final int PICK_FILE = 42;
    private static final int MIC_PERMISSION = 7;
    private static BoardServer server; // one per app process (survives screen rotation)

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private String pendingLang;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemBars();

        startServer();

        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(0xFFF6F3EC);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) main.postDelayed(() -> web.loadUrl(appUrl()), 1000);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("image/*");
                    startActivityForResult(Intent.createChooser(i, "Choose an image"), PICK_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        tts = new TextToSpeech(this, status -> { });
        web.loadUrl(appUrl());
    }

    private String appUrl() { return "http://127.0.0.1:" + BoardServer.DEFAULT_PORT + "/tablet"; }

    private void startServer() {
        if (server != null) return;
        final Context ctx = getApplicationContext();
        final SharedPreferences prefs = ctx.getSharedPreferences("boardlink", MODE_PRIVATE);
        server = new BoardServer(BoardServer.DEFAULT_PORT,
            path -> {
                InputStream in = ctx.getAssets().open("web/" + path);
                try { return BoardServer.readAll(in); } finally { in.close(); }
            },
            new BoardServer.Store() {
                @Override public String get(String key, String def) { return prefs.getString(key, def); }
                @Override public void put(String key, String value) { prefs.edit().putString(key, value).apply(); }
            });
        try {
            server.start();
        } catch (IOException e) {
            server = null; // port busy: the page will keep retrying
        }
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_FILE && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) result = new Uri[]{data.getData()};
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        }
    }

    /* ----------------------------- voice ------------------------------ */

    private void emitSpeech(String type, String text) {
        final String js = "window.__blSpeech && window.__blSpeech(" + JSONObject.quote(type) + "," + JSONObject.quote(text == null ? "" : text) + ")";
        main.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    private void startListening(String lang) {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingLang = lang;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_PERMISSION);
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) { emitSpeech("error", "unavailable"); return; }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { emitSpeech("start", ""); }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float rmsdB) { }
                @Override public void onBufferReceived(byte[] buffer) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onError(int error) {
                    String e = error == SpeechRecognizer.ERROR_NETWORK || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT ? "network"
                        : error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "not-allowed"
                        : error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "no-speech" : "error " + error;
                    emitSpeech("error", e);
                    emitSpeech("end", "");
                }
                @Override public void onResults(Bundle results) {
                    ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    emitSpeech("final", list != null && !list.isEmpty() ? list.get(0) : "");
                    emitSpeech("end", "");
                }
                @Override public void onPartialResults(Bundle partial) {
                    ArrayList<String> list = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (list != null && !list.isEmpty()) emitSpeech("partial", list.get(0));
                }
                @Override public void onEvent(int eventType, Bundle params) { }
            });
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        recognizer.startListening(i);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != MIC_PERMISSION) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && pendingLang != null) startListening(pendingLang);
        else { emitSpeech("error", "not-allowed"); emitSpeech("end", ""); }
        pendingLang = null;
    }

    /** Functions the web page can call: window.AndroidBridge.xxx() */
    private final class Bridge {
        @JavascriptInterface public boolean isApp() { return true; }

        @JavascriptInterface public void listen(final String lang) { main.post(() -> startListening(lang)); }

        @JavascriptInterface public void stopListening() { main.post(() -> { if (recognizer != null) recognizer.stopListening(); }); }

        @JavascriptInterface public void speak(String text, String lang) {
            if (tts == null) return;
            try { tts.setLanguage(Locale.forLanguageTag(lang)); } catch (Exception ignored) { }
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "bl");
        }

        @JavascriptInterface public void stopSpeaking() { if (tts != null) tts.stop(); }
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) recognizer.destroy();
        if (tts != null) tts.shutdown();
        if (web != null) web.destroy();
        if (isFinishing() && server != null) { server.stop(); server = null; }
        super.onDestroy();
    }
}
