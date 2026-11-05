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
    static final String SITES = "sites";

    private static final int REQ_FILE = 1;
    private static final int REQ_TERMUX = 2;
    private static final int REQ_NOTIFY = 3;

    // Colours of the native parts; they follow the theme chosen on the home page.
    Palette palette;

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

    /** Is the app on screen? Updater uses it: a hidden app may not open the installer. */
    static volatile boolean visible;
    /** The open window, for Termux results. */
    static volatile MainActivity running;

    Prefs prefs;
    volatile boolean stUp;
    volatile boolean starting;
    volatile String message = "";

    // What the last check in Termux found (null: not checked yet).
    Boolean termuxReady;
    String termuxError = "";
    boolean termuxChecking;
    boolean gitInstalled;
    String stDir = "";
    boolean permissionDenied;
    private int statusRun;
    private String pendingAction;
    private boolean startAfterCheck;

    private WebView tavern;
    private WebView korrektor;
    private WebView home;
    SitesTab sites;
    private ModelBar modelBar;
    private LinearLayout tavernBox;
    private LinearLayout root;
    private LinearLayout bar;
    private View barLine;
    private String pendingImport;
    private boolean reportPending;
    private boolean korrektorLoaded;
    /** The latest line SillyTavern printed while starting: shown on the home page. */
    String progress = "";
    private View updateBar;
    private TextView updateText;
    private TextView updateButton;
    private JSONObject updates;
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
        running = this;
        prefs = new Prefs(this);
        palette = Palette.of(this, prefs);
        Notifier.createChannel(this);

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFitsSystemWindows(true);

        FrameLayout frame = new FrameLayout(this);
        root.addView(frame, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        home = makeWebView(false);
        home.addJavascriptInterface(new ControlBridge(this), ControlBridge.NAME);
        tavern = makeWebView(true);
        korrektor = makeWebView(true);
        // The tavern tab: the model/preset row above SillyTavern itself.
        tavernBox = new LinearLayout(this);
        tavernBox.setOrientation(LinearLayout.VERTICAL);
        modelBar = new ModelBar(this, tavern, palette);
        tavernBox.addView(modelBar.view(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        tavernBox.addView(tavern, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        frame.addView(tavernBox, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        for (WebView view : new WebView[]{korrektor, home}) {
            frame.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        home.loadUrl("file:///android_asset/home.html");
        sites = new SitesTab(this);
        frame.addView(sites.view(), new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(makeUpdateBar(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        barLine = new View(this);
        root.addView(barLine, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1));

        bar = new LinearLayout(this);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(60)));
        addTab(bar, HOME, "Главная", R.drawable.ic_tab_home);
        addTab(bar, TAVERN, "Таверна", R.drawable.ic_tab_tavern);
        addTab(bar, KORREKTOR, "Корректор", R.drawable.ic_tab_korrektor);
        addTab(bar, SITES, "Сайты", R.drawable.ic_tab_sites);
        setSitesVisible(prefs.flag(Prefs.SHOW_SITES, true));

        setContentView(root);
        applyPalette();
        // Everyone sees the welcome screens once, also after an update: stay on the home tab for them.
        if (prefs.number(Prefs.ONBOARDING) < Prefs.ONBOARDING_VERSION) homeChosen = true;
        showTab(HOME);
        CheckJob.schedule(this);
        handleIntent(getIntent());
        checkServer(true);
        checkTermux();
        checkUpdates(false);
        // While the app is open, look for new versions every half hour.
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                checkUpdates(false);
                handler.postDelayed(this, 30 * 60_000);
            }
        }, 30 * 60_000);
    }

    // ---------- updates ----------

    private View makeUpdateBar() {
        LinearLayout box = new LinearLayout(this);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(16), dp(8), dp(8), dp(8));
        updateText = new TextView(this);
        updateText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        box.addView(updateText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        updateButton = new TextView(this);
        updateButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        updateButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        updateButton.setPadding(dp(14), dp(8), dp(14), dp(8));
        box.addView(updateButton);
        TextView later = new TextView(this);
        later.setText("Позже");
        later.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        later.setPadding(dp(12), dp(8), dp(8), dp(8));
        later.setOnClickListener(v -> dismissUpdate());
        later.setTag("later");
        box.addView(later);
        box.setVisibility(View.GONE);
        updateBar = box;
        return box;
    }

    /**
     * Looks for new versions of the app and of Korrektor. Without force, not more
     * often than every 20 minutes (GitHub limits anonymous requests).
     */
    void checkUpdates(boolean force) {
        if (!force && System.currentTimeMillis() - prefs.number("lastCheck") < 20 * 60_000) {
            showUpdateBar();
            return;
        }
        new Thread(() -> {
            JSONObject found = Updater.check(this, prefs);
            runOnUiThread(() -> {
                updates = found;
                showUpdateBar();
                sendToHome("updates", found);
            });
        }).start();
    }

    private void showUpdateBar() {
        long current = Updater.appVersionCode(this);
        long apkCode = prefs.number("apkCode");
        JSONObject k = updates == null ? null : updates.optJSONObject("korrektor");
        boolean app = apkCode > current && !prefs.text("apkUrl").isEmpty() && prefs.number("dismissedApp") != apkCode;
        boolean plugin = !app && k != null && k.optBoolean("available") && stUp && !k.optString("latest").equals(prefs.text("dismissedKorrektor"));
        if (!app && !plugin) {
            updateBar.setVisibility(View.GONE);
            return;
        }
        paintUpdateBar();
        if (app) {
            updateText.setText("Вышла новая версия приложения. Данные сохранятся");
            updateButton.setText("Обновить");
            updateButton.setOnClickListener(v -> {
                String error = Updater.downloadAndInstall(this, prefs, () -> toast("Скачиваю новую версию, потом откроется установка"));
                if (error != null) toast(error);
            });
        } else {
            updateText.setText("Новая версия Корректора " + k.optString("latest") + " для таверны");
            updateButton.setText("Обновить");
            updateButton.setOnClickListener(v -> new android.app.AlertDialog.Builder(this)
                    .setTitle("Обновить Корректор?")
                    .setMessage("Таверна перезапустится: это займёт около минуты")
                    .setPositiveButton("Обновить", (d, w) -> {
                        updateBar.setVisibility(View.GONE);
                        runAction("update-korrektor");
                    })
                    .setNegativeButton("Отмена", null)
                    .show());
        }
        updateBar.setVisibility(View.VISIBLE);
    }

    private void dismissUpdate() {
        long apkCode = prefs.number("apkCode");
        if (apkCode > Updater.appVersionCode(this)) prefs.setNumber("dismissedApp", apkCode);
        JSONObject k = updates == null ? null : updates.optJSONObject("korrektor");
        if (k != null) prefs.setText("dismissedKorrektor", k.optString("latest"));
        updateBar.setVisibility(View.GONE);
    }

    private void paintUpdateBar() {
        if (updateBar == null) return;
        updateBar.setBackgroundColor(palette.card);
        updateText.setTextColor(palette.text);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setCornerRadius(dp(10));
        bg.setColor(palette.text);
        updateButton.setBackground(bg);
        updateButton.setTextColor(palette.onPrimary);
        View later = updateBar.findViewWithTag("later");
        if (later instanceof TextView) ((TextView) later).setTextColor(palette.muted);
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private void addTab(LinearLayout bar, String name, String label, int iconRes) {
        TextView view = new TextView(this);
        view.setText(label);
        view.setGravity(Gravity.CENTER);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        view.setCompoundDrawablesWithIntrinsicBounds(null, getDrawable(iconRes), null, null);
        view.setCompoundDrawablePadding(dp(2));
        view.setPadding(0, dp(8), 0, dp(6));
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
        view.setBackgroundColor(palette.bg);
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
                if (v == korrektor) {
                    passTheme();
                    if (pendingImport != null && stUp) deliverImport();
                }
                // SillyTavern fills its menus a little after the page loads.
                if (v == tavern) handler.postDelayed(modelBar::refresh, 4000);
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
        return TAVERN.equals(tab) ? tavern : KORREKTOR.equals(tab) ? korrektor : SITES.equals(tab) ? sites.webView() : home;
    }

    void showTab(String name) {
        String tab = TAVERN.equals(name) || KORREKTOR.equals(name) || SITES.equals(name) ? name : HOME;
        // Provider sites work without SillyTavern; the other tabs need it running.
        if (!HOME.equals(tab) && !SITES.equals(tab) && !stUp) {
            message = starting ? message : "SillyTavern не запущен";
            tab = HOME;
        }
        current = tab;
        paintTabs();
        tavernBox.setVisibility(TAVERN.equals(tab) ? View.VISIBLE : View.GONE);
        if (TAVERN.equals(tab)) modelBar.refresh();
        if (KORREKTOR.equals(tab) && loaded && !korrektorLoaded) loadKorrektor();
        korrektor.setVisibility(KORREKTOR.equals(tab) ? View.VISIBLE : View.GONE);
        home.setVisibility(HOME.equals(tab) ? View.VISIBLE : View.GONE);
        sites.view().setVisibility(SITES.equals(tab) ? View.VISIBLE : View.GONE);
        if (SITES.equals(tab)) sites.onShown();
        if (TAVERN.equals(tab) || KORREKTOR.equals(tab)) prefs.setText(Prefs.LAST_TAB, tab);
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
        if (up != stUp) KorrektorWidget.refresh(this);
        stUp = up;
        if (up) {
            starting = false;
            message = "";
            if (!loaded) {
                tavern.loadUrl(prefs.stUrl() + "/");
                // The Korrektor page loads on first visit: the phone has less work while the tavern starts.
                korrektorLoaded = false;
                if (KORREKTOR.equals(current)) loadKorrektor();
                loaded = true;
            }
            progress = "";
            if (pendingImport != null && loaded) deliverImport();
            if (pendingTab != null) {
                showTab(pendingTab);
                pendingTab = null;
            } else if (HOME.equals(current) && !homeChosen) {
                String last = prefs.text(Prefs.LAST_TAB);
                showTab(KORREKTOR.equals(last) ? KORREKTOR : TAVERN);
            }
        } else {
            loaded = false;
            if (prefs.onPc()) {
                message = "Таверна на ПК не отвечает: проверьте, что компьютер включён, таверна запущена и адрес верный";
            } else if (mayAutoStart && prefs.flag(Prefs.AUTO_START, true) && Termux.installed(this) && Termux.permitted(this)) {
                // Start once Termux has answered the check and SillyTavern is known to be there.
                boolean known = !stDir.isEmpty() || !prefs.text(Prefs.START_CMD).isEmpty();
                if (termuxReady == Boolean.TRUE && !termuxChecking) {
                    if (known) {
                        runAction(prefs.flag(Prefs.AUTO_UPDATE, true) ? "start-update" : "start");
                        return;
                    }
                } else {
                    startAfterCheck = true;
                    if (!termuxChecking) checkTermux();
                }
            }
            showTab(HOME);
        }
        notifyHome();
    }

    void runAction(String action) {
        if ("logs".equals(action) || "status".equals(action)) {
            runQuiet(action);
            return;
        }
        if (prefs.onPc() && !"install-tavern".equals(action)) {
            message = "Сейчас открыта таверна на ПК: её запускают и обновляют на самом компьютере. Переключитесь на «Телефон», чтобы управлять таверной в Termux";
            toast("Таверна на ПК управляется с компьютера");
            notifyHome();
            return;
        }
        if (!Termux.installed(this)) {
            message = "Сначала установите Termux (шаг 1 ниже)";
            showTab(HOME);
            return;
        }
        if (!Termux.permitted(this)) {
            pendingAction = action;
            message = "Нужно разрешение запускать команды в Termux (шаг 3 ниже)";
            requestTermuxPermission();
            showTab(HOME);
            return;
        }
        int run = nextRun();
        if (Termux.runsTavern(action)) setTavernRun(run);
        else if ("stop".equals(action)) setTavernRun(0);
        String error = Termux.run(this, action, prefs.text(Prefs.START_CMD), run);
        if (error != null) {
            message = error;
            toast(error);
            showTab(HOME);
            return;
        }
        if ("install-tavern".equals(action)) {
            starting = true;
            message = "Идёт установка SillyTavern в Termux. Когда таверна запустится, приложение откроет её само";
            homeChosen = false;
            showTab(HOME);
            // Termux in the background may not be allowed to show itself: open it from here.
            handler.postDelayed(this::openTermux, 1200);
            waitForServer(10_000, 45 * 60_000);
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
            korrektorLoaded = false;
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
        // The first start installs dependencies: on a phone that can take many minutes.
        waitForServer(restart ? 4000 : 1500, 20 * 60_000);
    }

    private int nextRun() {
        return prefs.nextRun();
    }

    private void setTavernRun(int run) {
        prefs.setNumber("tavernRun", run);
    }

    /** Commands that only report something: no change to what the screen shows. */
    private void runQuiet(String action) {
        if (!Termux.installed(this) || !Termux.permitted(this)) {
            if ("logs".equals(action)) sendLogs("Журналы читаются через Termux: сначала пройдите шаги первой настройки");
            return;
        }
        int run = nextRun();
        String error = Termux.run(this, action, prefs.text(Prefs.START_CMD), run);
        if ("status".equals(action)) {
            if (error != null) {
                termuxChecking = false;
                termuxReady = false;
                termuxError = error;
            } else {
                termuxChecking = true;
                statusRun = run;
                handler.postDelayed(() -> {
                    if (statusRun != run || !termuxChecking) return;
                    termuxChecking = false;
                    termuxReady = false;
                    termuxError = "Termux не ответил. Выполните в Termux команду из шага 2 и нажмите «Проверить». "
                            + "Если не помогает, откройте Termux: там может быть уведомление с причиной";
                    notifyHome();
                }, 12_000);
            }
            notifyHome();
        } else if (error != null) {
            sendLogs(error);
        }
    }

    /** Asks Termux whether it accepts commands and what is installed. */
    void checkTermux() {
        if (Termux.installed(this) && Termux.permitted(this)) runQuiet("status");
    }

    private void sendLogs(String text) {
        try {
            JSONObject data = new JSONObject();
            data.put("text", text);
            sendToHome("logs", data);
        } catch (Exception ignored) {
            // a plain string always fits
        }
    }

    /** Termux finished a command (or could not run it). Called on the main thread. */
    void onTermuxResult(TermuxResult.Outcome o) {
        if (o.failedToRun()) {
            termuxReady = false;
            termuxError = o.errmsg.isEmpty() ? "Termux отказался выполнить команду" : o.errmsg.trim();
        } else {
            termuxReady = true;
            termuxError = "";
        }
        switch (o.action) {
            case "status":
                if (o.run == statusRun) termuxChecking = false;
                if (!o.failedToRun()) readStatus(o.stdout);
                if (startAfterCheck) {
                    startAfterCheck = false;
                    boolean known = !stDir.isEmpty() || !prefs.text(Prefs.START_CMD).isEmpty();
                    if (!o.failedToRun() && known && !stUp && !starting) {
                        runAction(prefs.flag(Prefs.AUTO_UPDATE, true) ? "start-update" : "start");
                    }
                }
                break;
            case "progress":
                if (starting && !o.failedToRun()) {
                    String line = o.stdout.trim();
                    if (line.length() > 160) line = line.substring(0, 160) + "…";
                    progress = line;
                }
                break;
            case "logs":
                if (reportPending) shareReport(o.failedToRun() ? termuxError : o.output());
                else sendLogs(o.failedToRun() ? termuxError : o.output().isEmpty() ? "Журналы пусты" : o.output());
                break;
            case "stop":
                if (o.failedToRun()) message = "Не удалось остановить: " + termuxError;
                break;
            default:
                if (Termux.runsTavern(o.action)) onTavernEnded(o);
                break;
        }
        notifyHome();
    }

    private void readStatus(String stdout) {
        gitInstalled = false;
        stDir = "";
        for (String line : stdout.split("\n")) {
            line = line.trim();
            if (line.equals("git=1")) gitInstalled = true;
            else if (line.startsWith("st_dir=")) stDir = line.substring(7);
        }
    }

    /** The Termux session that ran SillyTavern ended. */
    private void onTavernEnded(TermuxResult.Outcome o) {
        if (o.run != prefs.number("tavernRun")) return; // an older session we already replaced or stopped
        setTavernRun(0);
        int code = o.exitCode == null ? 0 : o.exitCode;
        boolean byHand = code == 130 || code == 143; // Ctrl+C or a stop signal
        if (!o.failedToRun() && (code == 0 || byHand) && starting) {
            // The command may have started SillyTavern in the background and returned: keep waiting.
            return;
        }
        if (o.failedToRun() || (code != 0 && !byHand)) {
            waitToken++;
            starting = false;
            message = o.failedToRun() ? "Termux не выполнил команду: " + termuxError
                    : "SillyTavern не запустился или упал (код " + code + "). Журнал ниже";
            runQuiet("logs");
            checkServer(false);
            return;
        }
        // Ended normally, for example stopped in Termux: check whether it is really down.
        new Thread(() -> {
            boolean up = Net.alive(prefs.stUrl());
            runOnUiThread(() -> {
                if (up) return;
                message = "SillyTavern остановлен";
                onServerState(false, false);
            });
        }).start();
    }

    /** Switches between the tavern on this phone and the one on the PC. */
    void switchTarget(String target) {
        prefs.setTarget(target);
        waitToken++;
        starting = false;
        stUp = false;
        loaded = false;
        korrektorLoaded = false;
        progress = "";
        message = prefs.onPc() ? "Подключаюсь к таверне на ПК…" : "";
        tavern.loadUrl("about:blank");
        korrektor.loadUrl("about:blank");
        modelBar.refresh();
        homeChosen = true;
        showTab(HOME);
        checkServer(!prefs.onPc());
    }

    void openKorrektor(String hash) {
        homeChosen = false;
        if (stUp && !korrektorLoaded) {
            // Not opened yet: load it straight on the wanted screen.
            korrektorLoaded = true;
            korrektor.loadUrl(prefs.stUrl() + "/api/plugins/korrektor/app/" + hash);
        }
        showTab(KORREKTOR);
        if (KORREKTOR.equals(current)) korrektor.evaluateJavascript("location.hash=" + JSONObject.quote(hash), null);
    }

    void refreshModelBar() {
        modelBar.refresh();
    }

    void finishOnboarding() {
        prefs.setNumber(Prefs.ONBOARDING, Prefs.ONBOARDING_VERSION);
        homeChosen = false;
        if (stUp) showTab(TAVERN);
        else if (termuxReady == Boolean.TRUE && (!stDir.isEmpty() || !prefs.text(Prefs.START_CMD).isEmpty()) && !starting) {
            runAction(prefs.flag(Prefs.AUTO_UPDATE, true) ? "start-update" : "start");
        } else notifyHome();
    }

    /** "Edit list" in the Sites tab: the list is edited on the More page. */
    void showSitesSettings() {
        homeChosen = true;
        showTab(HOME);
        try {
            sendToHome("focus", new JSONObject().put("section", "sites"));
        } catch (Exception ignored) {
            // a plain string always fits
        }
    }

    void setSitesVisible(boolean on) {
        TextView tab = tabs.get(SITES);
        if (tab != null) tab.setVisibility(on ? View.VISIBLE : View.GONE);
        if (!on && SITES.equals(current)) showTab(HOME);
    }

    void openTermux() {
        Intent intent = getPackageManager().getLaunchIntentForPackage(Termux.PACKAGE);
        if (intent != null) startActivity(intent);
        else toast("Termux не установлен");
    }

    void openAppSettings() {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }

    private void waitForServer(long firstDelay, long timeout) {
        final int token = ++waitToken;
        new Thread(() -> {
            long until = System.currentTimeMillis() + timeout;
            sleep(firstDelay);
            long nextProgress = 0;
            while (token == waitToken && System.currentTimeMillis() < until) {
                // What SillyTavern is doing right now, from its output in Termux.
                if (System.currentTimeMillis() > nextProgress) {
                    nextProgress = System.currentTimeMillis() + 8000;
                    runOnUiThread(() -> runQuiet("progress"));
                }
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
            message = "SillyTavern так и не ответил за 20 минут. Нажмите «Журнал», чтобы увидеть, на чём он остановился";
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

    // ---------- look ----------

    void applyPalette() {
        palette = Palette.of(this, prefs);
        getWindow().setStatusBarColor(palette.bg);
        getWindow().setNavigationBarColor(palette.deep);
        int flags = getWindow().getDecorView().getSystemUiVisibility();
        if (palette.light) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        else flags &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        getWindow().getDecorView().setSystemUiVisibility(flags);
        root.setBackgroundColor(palette.bg);
        barLine.setBackgroundColor(palette.line);
        bar.setBackgroundColor(palette.deep);
        for (WebView view : new WebView[]{tavern, korrektor, home}) view.setBackgroundColor(palette.bg);
        modelBar.setPalette(palette);
        sites.setPalette(palette);
        paintTabs();
        paintUpdateBar();
        passTheme();
        notifyHome();
    }

    private void paintTabs() {
        for (Map.Entry<String, TextView> e : tabs.entrySet()) {
            boolean on = e.getKey().equals(current);
            int color = on ? palette.text : palette.muted;
            e.getValue().setTextColor(color);
            e.getValue().setCompoundDrawableTintList(android.content.res.ColorStateList.valueOf(on ? palette.accent : palette.muted));
            e.getValue().setTypeface(Typeface.DEFAULT, on ? Typeface.BOLD : Typeface.NORMAL);
        }
    }

    /** The Korrektor page draws itself in the same theme and accent. */
    private void passTheme() {
        String theme = Palette.resolvedTheme(this, prefs);
        String accent = prefs.text(Prefs.ACCENT);
        korrektor.evaluateJavascript("window.korrektorTheme&&window.korrektorTheme(" + JSONObject.quote(theme) + "," + JSONObject.quote(accent) + ")", null);
    }

    // ---------- links shared to the app ----------

    private void loadKorrektor() {
        korrektorLoaded = true;
        korrektor.loadUrl(prefs.stUrl() + "/api/plugins/korrektor/app/");
    }

    /** Reloads SillyTavern's page (the tavern tab). */
    void reloadTavern() {
        if (!stUp) {
            checkServer();
            return;
        }
        String url = tavern.getUrl();
        if (url != null && url.startsWith(prefs.stUrl())) tavern.reload();
        else tavern.loadUrl(prefs.stUrl() + "/");
        toast("Обновляю страницу таверны");
    }

    private void deliverImport() {
        String url = pendingImport;
        if (url == null) return;
        pendingImport = null;
        homeChosen = false;
        showTab(KORREKTOR);
        korrektor.evaluateJavascript("window.korrektorImport?window.korrektorImport(" + JSONObject.quote(url) + "):'missing'", value -> {
            if ("\"missing\"".equals(value)) {
                // The page is still loading: try once more when it is ready.
                pendingImport = url;
            }
        });
    }

    // ---------- home page: dashboard, continue a chat, problem report ----------

    /** Numbers for the home page: last chat, findings, key check, tokens today. */
    void loadDashboard() {
        if (!stUp) {
            sendToHome("dashboard", null);
            return;
        }
        String base = prefs.stUrl() + "/api/plugins/korrektor";
        new Thread(() -> {
            JSONObject out = new JSONObject();
            try {
                Net.Reply status = Net.get(base + "/status", 8000, true);
                if (status.ok()) {
                    JSONObject st = new JSONObject(status.body);
                    out.put("status", st);
                    prefs.setText("korrektorInstalled", st.optString("version"));
                }
                out.put("korrektorLatest", prefs.text("korrektorLatest"));
                Net.Reply chats = Net.get(base + "/chats?limit=1", 8000, true);
                if (chats.ok()) {
                    org.json.JSONArray items = new JSONObject(chats.body).optJSONArray("items");
                    if (items != null && items.length() > 0) out.put("lastChat", items.getJSONObject(0));
                }
                Net.Reply usage = Net.get(base + "/usage?days=1", 8000, true);
                if (usage.ok()) {
                    JSONObject u = new JSONObject(usage.body);
                    org.json.JSONArray days = u.optJSONArray("byDay");
                    if (days != null && days.length() > 0) out.put("today", days.getJSONObject(days.length() - 1));
                }
                out.put("needsLogin", status.status == 401 || status.status == 403);
            } catch (Exception ignored) {
                // partial numbers are fine
            }
            sendToHome("dashboard", out);
        }).start();
    }

    /** Opens a chat in the tavern tab, as if chosen in SillyTavern's list. */
    void openChat(String chatId) {
        homeChosen = false;
        showTab(TAVERN);
        String js = "(async function(id){try{var ctx=SillyTavern.getContext();var parts=id.split('/');"
                + "if(parts[0]!=='c')return 'group';var avatar=parts[1]+'.png';var file=parts.slice(2).join('/');"
                + "var index=ctx.characters.findIndex(function(c){return c.avatar===avatar;});if(index<0)return 'nochar';"
                + "if(String(ctx.characterId)!==String(index))await ctx.selectCharacterById(String(index));"
                + "if(ctx.getCurrentChatId&&ctx.getCurrentChatId()!==file)await ctx.openCharacterChat(file);return 'ok';"
                + "}catch(e){return 'error';}})(" + JSONObject.quote(chatId) + ")";
        tavern.evaluateJavascript(js, null);
    }

    /** Collects what helps to find a problem and offers to send it (logs come from Termux). */
    void reportProblem() {
        if (Termux.installed(this) && Termux.permitted(this)) {
            reportPending = true;
            runQuiet("logs");
            handler.postDelayed(() -> {
                if (reportPending) shareReport("(журнал из Termux не пришёл)");
            }, 8000);
        } else {
            shareReport("(Termux не настроен: журнала нет)");
        }
    }

    private void shareReport(String logs) {
        reportPending = false;
        new Thread(() -> {
            String plugin = "?";
            Net.Reply status = stUp ? Net.get(prefs.stUrl() + "/api/plugins/korrektor/status", 6000, true) : null;
            if (status != null && status.ok()) {
                try {
                    plugin = new JSONObject(status.body).optString("version", "?");
                } catch (Exception ignored) {
                    // keep "?"
                }
            }
            String text = "Корректор: отчёт о проблеме\n"
                    + "Приложение: " + Updater.appVersionName(this) + " (" + Updater.appVersionCode(this) + ")\n"
                    + "Android: " + android.os.Build.VERSION.RELEASE + " (API " + android.os.Build.VERSION.SDK_INT + "), " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL + "\n"
                    + "SillyTavern: " + (stUp ? "работает" : "не отвечает") + ", " + prefs.stUrl() + "\n"
                    + "Корректор в таверне: " + plugin + "\n"
                    + "Termux: " + (Termux.installed(this) ? "установлен" : "нет") + ", разрешение: " + (Termux.permitted(this) ? "да" : "нет")
                    + ", приём команд: " + (termuxReady == null ? "не проверен" : termuxReady ? "да" : "нет: " + termuxError) + "\n"
                    + "Команда запуска: " + (prefs.text(Prefs.START_CMD).isEmpty() ? "автоматически" : prefs.text(Prefs.START_CMD)) + "\n"
                    + "Папка таверны: " + (stDir.isEmpty() ? "не найдена" : stDir) + "\n"
                    + "Сообщение на экране: " + (message.isEmpty() ? "—" : message) + "\n\n"
                    + "Журнал:\n" + logs;
            runOnUiThread(() -> {
                android.content.ClipboardManager clipboard = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Отчёт Корректора", text));
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(send, "Отчёт скопирован. Отправить в…"));
            });
        }).start();
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
        if (requestCode == REQ_TERMUX) {
            if (granted) {
                permissionDenied = false;
                message = "";
                String action = pendingAction;
                pendingAction = null;
                // Pressed "Start" before: do it now. Otherwise start on our own only once
                // Termux has answered and SillyTavern is known to be there.
                startAfterCheck = action == null && prefs.flag(Prefs.AUTO_START, true);
                checkTermux();
                if (action != null) runAction(action);
            } else {
                permissionDenied = true;
                pendingAction = null;
                // No dialog any more (denied before): only the app's settings can grant it.
                if (!shouldShowRequestPermissionRationale(Termux.PERMISSION)) {
                    toast("Включите: Разрешения → Дополнительные разрешения → «Выполнять команды в среде Termux»");
                    openAppSettings();
                }
            }
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
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            // A link shared to the app: import the card or lorebook through Korrektor.
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("https?://\\S+").matcher(text == null ? "" : text);
            if (m.find()) {
                pendingImport = m.group();
                homeChosen = false;
                if (stUp) deliverImport();
                else {
                    message = "Ссылка получена: импорт начнётся, когда SillyTavern запустится";
                    pendingTab = KORREKTOR;
                    showTab(HOME);
                }
            } else {
                toast("В том, чем поделились, нет ссылки");
            }
            return;
        }
        String tab = intent == null ? null : intent.getStringExtra("tab");
        if (tab == null) return;
        homeChosen = HOME.equals(tab);
        if (!HOME.equals(tab) && !stUp) pendingTab = tab;
        showTab(tab);
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        if (!starting) checkServer(false);
        checkUpdates(false);
        if (termuxReady != Boolean.TRUE && !termuxChecking) checkTermux();
    }

    @Override
    protected void onPause() {
        super.onPause();
        visible = false;
        CookieManager.getInstance().flush();
    }

    @Override
    public void onBackPressed() {
        if (SITES.equals(current)) {
            WebView site = sites.webView();
            if (site.canGoBack()) site.goBack();
            else showTab(stUp ? TAVERN : HOME);
            return;
        }
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
        if (running == this) running = null;
        handler.removeCallbacksAndMessages(null);
        KorrektorWidget.refresh(this);
        for (WebView view : new WebView[]{tavern, korrektor, home, sites == null ? null : sites.webView()}) {
            if (view != null) view.destroy();
        }
        super.onDestroy();
    }
}
