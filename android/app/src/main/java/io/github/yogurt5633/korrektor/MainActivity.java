package io.github.yogurt5633.korrektor;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.text.InputType;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Three tabs: SillyTavern itself, Korrektor (the plugin's app) and "More"
 * (start/stop, updates, permissions). Both web tabs stay loaded, so switching
 * does not reload the chat. SillyTavern runs in Termux; this app starts it there.
 */
public class MainActivity extends Activity {
    static final String TAVERN = "tavern";
    static final String KORREKTOR = "korrektor";
    static final String HOME = "home";

    private static final int REQ_FILE = 1;
    private static final int REQ_TERMUX = 2;
    private static final int REQ_NOTIFY = 3;

    private static final int BG = Color.parseColor("#161513");
    private static final int DEEP = Color.parseColor("#12110f");
    private static final int LINE = Color.parseColor("#2a2824");
    private static final int TEXT = Color.parseColor("#efe9de");
    private static final int MUTED = Color.parseColor("#8a847a");

    // Back button: close what is open inside the page first (SillyTavern panels and popups, Korrektor dialogs).
    private static final String BACK_SCRIPT = "(function(){"
            + "var vis=function(e){return !!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));};"
            + "var kd=document.getElementById('dialog');if(kd&&!kd.hidden&&kd.querySelector('.dialog-box')){var c=kd.querySelector('.btn.secondary');if(c){c.click();return true;}}"
            + "var dl=[].slice.call(document.querySelectorAll('dialog[open]'));"
            + "if(dl.length){var d=dl[dl.length-1];var b=d.querySelector('.popup-button-cancel,.popup-button-close');"
            + "if(b){b.click();}else{d.dispatchEvent(new Event('cancel',{cancelable:true}));}return true;}"
            + "var legacy=['#character_popup','#select_chat_popup','#dialogue_popup'].map(function(s){return document.querySelector(s);}).filter(vis);"
            + "var dr=[].slice.call(document.querySelectorAll('.drawer-content.openDrawer')).filter(function(d){return !d.classList.contains('pinnedOpen');});"
            + "if(!legacy.length&&!dr.length)return false;"
            + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));"
            + "setTimeout(function(){[].slice.call(document.querySelectorAll('.drawer-content.openDrawer')).forEach(function(d){"
            + "if(d.classList.contains('pinnedOpen'))return;var t=d.parentElement&&d.parentElement.querySelector('.drawer-toggle');if(t)t.click();});},80);"
            + "return true;})()";

    Prefs prefs;
    volatile boolean stUp;
    volatile boolean starting;
    volatile String message = "";

    private WebView tavern;
    private WebView korrektor;
    private WebView home;
    private final Map<String, TextView> tabs = new LinkedHashMap<>();
    private String current = HOME;
    private boolean loaded;
    private boolean homeChosen;
    private ValueCallback<Uri[]> fileCallback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int waitToken;
    private String pendingTab;
    private final java.util.List<HttpAuthHandler> authWaiting = new java.util.ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        Notifier.createChannel(this);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(DEEP);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setFitsSystemWindows(true);

        FrameLayout frame = new FrameLayout(this);
        root.addView(frame, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        home = makeWebView(false);
        home.addJavascriptInterface(new ControlBridge(this), ControlBridge.NAME);
        tavern = makeWebView(true);
        korrektor = makeWebView(true);
        for (WebView view : new WebView[]{tavern, korrektor, home}) {
            frame.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        home.loadUrl("file:///android_asset/home.html");

        View line = new View(this);
        line.setBackgroundColor(LINE);
        root.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1));

        LinearLayout bar = new LinearLayout(this);
        bar.setBackgroundColor(DEEP);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56)));
        addTab(bar, TAVERN, "Таверна");
        addTab(bar, KORREKTOR, "Корректор");
        addTab(bar, HOME, "Ещё");

        setContentView(root);
        showTab(HOME);
        CheckJob.schedule(this);
        handleIntent(getIntent());
        checkServer(true);
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private void addTab(LinearLayout bar, String name, String label) {
        TextView view = new TextView(this);
        view.setText(label);
        view.setGravity(Gravity.CENTER);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        view.setTextColor(MUTED);
        view.setOnClickListener(v -> {
            if (HOME.equals(name)) homeChosen = true;
            showTab(name);
        });
        tabs.put(name, view);
        bar.addView(view, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
    }

    // ---------- web views ----------

    private WebView makeWebView(boolean pageTab) {
        WebView view = new WebView(this);
        view.setBackgroundColor(BG);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(!pageTab);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " KorrektorApp/" + Updater.appVersionName(this));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);

        view.setWebViewClient(new WebViewClient() {
            private int authTries;

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // The "More" page has the app's controls, so it never leaves its own file.
                if (!pageTab) {
                    String url = uri.toString();
                    if (url.startsWith("file:///android_asset/")) return false;
                    if (isLocal(uri)) {
                        showTab(TAVERN);
                        return true;
                    }
                } else if (isLocal(uri)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception e) {
                    toast("Не открылась ссылка: " + uri);
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (pageTab) v.evaluateJavascript(FilesBridge.HOOK, null);
                authTries = 0;
            }

            @Override
            public void onReceivedHttpAuthRequest(WebView v, HttpAuthHandler auth, String host, String realm) {
                // SillyTavern with basicAuth: the login goes only to SillyTavern's own address.
                if (!pageTab || !isLocal(Uri.parse("http://" + host + "/"))) {
                    auth.cancel();
                    return;
                }
                String[] saved = prefs.auth();
                if (saved != null && authTries++ == 0) {
                    auth.proceed(saved[0], saved[1]);
                    return;
                }
                askLogin(auth, saved != null);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (pageTab && request.isForMainFrame()) {
                    stUp = false;
                    loaded = false;
                    message = "SillyTavern не отвечает";
                    showTab(HOME);
                }
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                // Any file: SillyTavern's accept lists use extensions Android does not map well.
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(intent, "Выберите файл"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        if (pageTab) {
            view.addJavascriptInterface(new FilesBridge(this), FilesBridge.NAME);
            view.setDownloadListener((url, userAgent, disposition, mime, length) -> download(view, url, userAgent, disposition, mime));
        }
        return view;
    }

    private void askLogin(HttpAuthHandler auth, boolean failed) {
        // Both web tabs may ask at once: one dialog answers all of them.
        authWaiting.add(auth);
        if (authWaiting.size() > 1) return;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), 0);
        EditText user = new EditText(this);
        user.setHint("Логин");
        user.setSingleLine(true);
        EditText pass = new EditText(this);
        pass.setHint("Пароль");
        pass.setSingleLine(true);
        pass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        String[] saved = prefs.auth();
        if (saved != null) user.setText(saved[0]);
        box.addView(user);
        box.addView(pass);
        new AlertDialog.Builder(this)
                .setTitle("Вход в SillyTavern")
                .setMessage(failed ? "Логин или пароль не подошли. Это данные basicAuth из config.yaml" : "В SillyTavern включён basicAuth: введите логин и пароль из config.yaml")
                .setView(box)
                .setCancelable(false)
                .setPositiveButton("Войти", (d, w) -> {
                    String name = user.getText().toString();
                    String word = pass.getText().toString();
                    prefs.setAuth(name, word);
                    for (HttpAuthHandler h : authWaiting) h.proceed(name, word);
                    authWaiting.clear();
                })
                .setNegativeButton("Отмена", (d, w) -> {
                    for (HttpAuthHandler h : authWaiting) h.cancel();
                    authWaiting.clear();
                })
                .show();
    }

    private boolean isLocal(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) return true;
        switch (scheme) {
            case "file":
            case "about":
            case "blob":
            case "data":
            case "javascript":
                return true;
            case "http":
            case "https": {
                String host = uri.getHost();
                String own = Uri.parse(prefs.stUrl()).getHost();
                return host != null && (host.equals(own) || host.equals("127.0.0.1") || host.equals("localhost"));
            }
            default:
                return false;
        }
    }

    private void download(WebView view, String url, String userAgent, String disposition, String mime) {
        String name = FilesBridge.sanitize(URLUtil.guessFileName(url, disposition, mime));
        if (url.startsWith("blob:") || url.startsWith("data:")) {
            view.evaluateJavascript("window.__korrektorSave&&window.__korrektorSave(" + JSONObject.quote(url) + "," + JSONObject.quote(name) + ")", null);
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) request.addRequestHeader("Cookie", cookies);
            String[] login = prefs.auth();
            if (login != null && isLocal(Uri.parse(url))) {
                String pair = login[0] + ":" + login[1];
                request.addRequestHeader("Authorization", "Basic " + android.util.Base64.encodeToString(pair.getBytes(java.nio.charset.StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));
            }
            request.addRequestHeader("User-Agent", userAgent);
            request.setMimeType(mime);
            request.setTitle(name);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Korrektor/" + name);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
            toast("Скачиваю в Загрузки/Korrektor: " + name);
        } catch (Exception e) {
            toast("Не удалось скачать: " + e.getMessage());
        }
    }

    // ---------- tabs and server state ----------

    private WebView viewOf(String tab) {
        return TAVERN.equals(tab) ? tavern : KORREKTOR.equals(tab) ? korrektor : home;
    }

    void showTab(String name) {
        String tab = TAVERN.equals(name) || KORREKTOR.equals(name) ? name : HOME;
        if (!HOME.equals(tab) && !stUp) {
            message = starting ? message : "SillyTavern не запущен";
            tab = HOME;
        }
        current = tab;
        for (Map.Entry<String, TextView> e : tabs.entrySet()) {
            boolean on = e.getKey().equals(tab);
            e.getValue().setTextColor(on ? TEXT : MUTED);
            e.getValue().setTypeface(Typeface.DEFAULT, on ? Typeface.BOLD : Typeface.NORMAL);
        }
        tavern.setVisibility(TAVERN.equals(tab) ? View.VISIBLE : View.GONE);
        korrektor.setVisibility(KORREKTOR.equals(tab) ? View.VISIBLE : View.GONE);
        home.setVisibility(HOME.equals(tab) ? View.VISIBLE : View.GONE);
        if (!HOME.equals(tab)) prefs.setText(Prefs.LAST_TAB, tab);
        notifyHome();
    }

    /** Is SillyTavern up? Optionally start it when it is not. */
    void checkServer() {
        checkServer(false);
    }

    private void checkServer(boolean mayAutoStart) {
        new Thread(() -> {
            boolean up = Net.alive(prefs.stUrl());
            runOnUiThread(() -> onServerState(up, mayAutoStart));
        }).start();
    }

    private void onServerState(boolean up, boolean mayAutoStart) {
        stUp = up;
        if (up) {
            starting = false;
            message = "";
            if (!loaded) {
                tavern.loadUrl(prefs.stUrl() + "/");
                korrektor.loadUrl(prefs.stUrl() + "/api/plugins/korrektor/app/");
                loaded = true;
            }
            if (pendingTab != null) {
                showTab(pendingTab);
                pendingTab = null;
            } else if (HOME.equals(current) && !homeChosen) {
                String last = prefs.text(Prefs.LAST_TAB);
                showTab(KORREKTOR.equals(last) ? KORREKTOR : TAVERN);
            }
        } else {
            loaded = false;
            if (mayAutoStart && prefs.flag(Prefs.AUTO_START, true) && Termux.installed(this) && Termux.permitted(this)) {
                runAction(prefs.flag(Prefs.AUTO_UPDATE, true) ? "start-update" : "start");
                return;
            }
            showTab(HOME);
        }
        notifyHome();
    }

    void runAction(String action) {
        String error = Termux.run(this, action);
        if (error != null) {
            message = error;
            toast(error);
            showTab(HOME);
            return;
        }
        if ("stop".equals(action)) {
            waitToken++;
            starting = false;
            stUp = false;
            loaded = false;
            message = "SillyTavern остановлен";
            tavern.loadUrl("about:blank");
            korrektor.loadUrl("about:blank");
            showTab(HOME);
            return;
        }
        starting = true;
        boolean restart = !action.startsWith("start");
        message = "update-tavern".equals(action) ? "Обновляю SillyTavern, это может занять несколько минут"
                : "update-korrektor".equals(action) ? "Обновляю Корректор и перезапускаю SillyTavern"
                : "start-update".equals(action) ? "Проверяю обновление Корректора и запускаю SillyTavern"
                : restart ? "Перезапускаю SillyTavern" : "Запускаю SillyTavern";
        if (restart) {
            stUp = false;
            loaded = false;
        }
        homeChosen = false;
        showTab(HOME);
        waitForServer(restart ? 4000 : 1500, "update-tavern".equals(action) ? 600_000 : 240_000);
    }

    private void waitForServer(long firstDelay, long timeout) {
        final int token = ++waitToken;
        new Thread(() -> {
            long until = System.currentTimeMillis() + timeout;
            sleep(firstDelay);
            while (token == waitToken && System.currentTimeMillis() < until) {
                if (Net.alive(prefs.stUrl())) {
                    runOnUiThread(() -> {
                        if (token != waitToken) return;
                        if (pendingTab == null && !homeChosen) pendingTab = TAVERN;
                        onServerState(true, false);
                    });
                    return;
                }
                sleep(1500);
            }
            if (token != waitToken) return;
            starting = false;
            message = "SillyTavern не запустился. Проверьте шаги ниже и журнал в Termux: tail ~/.korrektor-ctl.log ~/.korrektor-st.log";
            notifyHome();
        }).start();
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    void notifyHome() {
        sendToHome("state", null);
    }

    void sendToHome(String type, JSONObject data) {
        String js = "window.onNative&&window.onNative(" + JSONObject.quote(type) + "," + (data == null ? "null" : data.toString()) + ")";
        runOnUiThread(() -> home.evaluateJavascript(js, null));
    }

    void toast(String text) {
        runOnUiThread(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show());
    }

    // ---------- permissions ----------

    void requestTermuxPermission() {
        if (!Termux.installed(this)) {
            toast("Сначала установите Termux");
            return;
        }
        requestPermissions(new String[]{Termux.PERMISSION}, REQ_TERMUX);
    }

    void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        } else {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(intent);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQ_TERMUX && granted && !stUp && !starting) {
            runAction(prefs.flag(Prefs.AUTO_UPDATE, true) ? "start-update" : "start");
        }
        notifyHome();
    }

    // ---------- system events ----------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri[] uris = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                uris = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) uris[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                uris = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(uris);
        fileCallback = null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        String tab = intent == null ? null : intent.getStringExtra("tab");
        if (tab == null) return;
        homeChosen = HOME.equals(tab);
        if (!HOME.equals(tab) && !stUp) pendingTab = tab;
        showTab(tab);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!starting) checkServer(false);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    public void onBackPressed() {
        WebView view = viewOf(current);
        if (view == home) {
            if (stUp) showTab(TAVERN);
            else moveTaskToBack(true);
            return;
        }
        view.evaluateJavascript(BACK_SCRIPT, value -> {
            if ("true".equals(value)) return;
            if (view.canGoBack()) view.goBack();
            else if (view != tavern) showTab(TAVERN);
            else moveTaskToBack(true);
        });
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        for (WebView view : new WebView[]{tavern, korrektor, home}) {
            if (view != null) view.destroy();
        }
        super.onDestroy();
    }
}
