package io.github.yogurt5633.korrektor;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * What the app's own "More" page (assets/home.html) may ask for: start/stop
 * SillyTavern, updates, permissions, settings. Only that page gets this object;
 * SillyTavern and Korrektor pages do not.
 */
final class ControlBridge {
    static final String NAME = "KorrektorApp";

    private final MainActivity activity;

    ControlBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String state() {
        Prefs prefs = activity.prefs;
        JSONObject s = new JSONObject();
        try {
            s.put("appVersion", Updater.appVersionName(activity));
            s.put("appCode", Updater.appVersionCode(activity));
            s.put("stUrl", prefs.stUrl());
            s.put("stUp", activity.stUp);
            s.put("starting", activity.starting);
            s.put("termuxInstalled", Termux.installed(activity));
            s.put("termuxPermission", Termux.permitted(activity));
            s.put("termuxSetup", Termux.SETUP);
            s.put("notifications", Notifier.allowed(activity));
            s.put("canInstall", Updater.canInstall(activity));
            s.put("autoStart", prefs.flag(Prefs.AUTO_START, true));
            s.put("autoUpdate", prefs.flag(Prefs.AUTO_UPDATE, true));
            s.put("notify", prefs.flag(Prefs.NOTIFY, true));
            s.put("lastCheck", prefs.number("lastCheck"));
            s.put("message", activity.message);
            s.put("termuxReady", activity.termuxReady == null ? JSONObject.NULL : activity.termuxReady);
            s.put("termuxError", activity.termuxError);
            s.put("termuxChecking", activity.termuxChecking);
            s.put("git", activity.gitInstalled);
            s.put("stDir", activity.stDir);
            s.put("startCmd", prefs.text(Prefs.START_CMD));
            s.put("permissionDenied", activity.permissionDenied);
            s.put("showSites", prefs.flag(Prefs.SHOW_SITES, true));
        } catch (Exception ignored) {
            // all puts are simple values
        }
        return s.toString();
    }

    /** start | start-update | stop | restart | update-korrektor | update-tavern | install-tavern | logs */
    @JavascriptInterface
    public void action(String name) {
        activity.runOnUiThread(() -> activity.runAction(name));
    }

    @JavascriptInterface
    public void checkUpdates() {
        new Thread(() -> activity.sendToHome("updates", Updater.check(activity, activity.prefs))).start();
    }

    @JavascriptInterface
    public void installApp() {
        activity.runOnUiThread(() -> {
            String error = Updater.downloadAndInstall(activity, activity.prefs, () -> activity.toast("Скачиваю новую версию, потом откроется установка"));
            if (error != null) activity.toast(error);
        });
    }

    @JavascriptInterface
    public void requestTermux() {
        activity.runOnUiThread(activity::requestTermuxPermission);
    }

    @JavascriptInterface
    public void requestNotifications() {
        activity.runOnUiThread(activity::requestNotificationPermission);
    }

    @JavascriptInterface
    public void openInstallSettings() {
        activity.runOnUiThread(() -> Updater.openInstallSettings(activity));
    }

    @JavascriptInterface
    public void openTermux() {
        activity.runOnUiThread(activity::openTermux);
    }

    @JavascriptInterface
    public void openAppSettings() {
        activity.runOnUiThread(activity::openAppSettings);
    }

    /** Check again whether Termux accepts commands and what is installed. */
    @JavascriptInterface
    public void recheck() {
        activity.runOnUiThread(activity::checkTermux);
    }

    /** The user's own command that starts SillyTavern in Termux (for example st); empty = automatic. */
    @JavascriptInterface
    public void setStartCommand(String command) {
        String value = command == null ? "" : command.replaceAll("[\\r\\n]+", " ").trim();
        if (value.length() > 300) {
            activity.toast("Слишком длинная команда");
            return;
        }
        activity.prefs.setText(Prefs.START_CMD, value);
        activity.toast(value.isEmpty() ? "Команда запуска: автоматически" : "Команда запуска сохранена");
        activity.notifyHome();
    }

    /** Only a few known pages: where to get Termux and this project. */
    @JavascriptInterface
    public void openLink(String which) {
        String url;
        switch (which) {
            case "termux":
                url = "https://f-droid.org/packages/com.termux/";
                break;
            case "project":
                url = "https://github.com/yogurt5633-hub/st-app";
                break;
            default:
                return;
        }
        activity.runOnUiThread(() -> activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
    }

    @JavascriptInterface
    public void setUrl(String url) {
        String value = url == null ? "" : url.trim();
        if (!value.matches("^https?://[A-Za-z0-9.\\-\\[\\]:]+(:\\d+)?/?$")) {
            activity.toast("Адрес должен выглядеть так: http://127.0.0.1:8000");
            return;
        }
        activity.prefs.setStUrl(value);
        activity.runOnUiThread(activity::checkServer);
    }

    @JavascriptInterface
    public void setFlag(String key, boolean value) {
        if (Prefs.AUTO_START.equals(key) || Prefs.AUTO_UPDATE.equals(key) || Prefs.NOTIFY.equals(key) || Prefs.SHOW_SITES.equals(key)) {
            activity.prefs.setFlag(key, value);
        }
        if (Prefs.SHOW_SITES.equals(key)) activity.runOnUiThread(() -> activity.setSitesVisible(value));
    }

    @JavascriptInterface
    public void copy(String text) {
        activity.runOnUiThread(() -> {
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("Корректор", text));
            activity.toast("Скопировано");
        });
    }

    /** Provider sites for the "Sites" tab: [{name, url}]. */
    @JavascriptInterface
    public String sites() {
        return activity.sites.sites().toString();
    }

    @JavascriptInterface
    public void setSites(String json) {
        activity.runOnUiThread(() -> {
            String error = activity.sites.save(json);
            activity.toast(error == null ? "Список сайтов сохранён" : error);
            activity.notifyHome();
        });
    }

    @JavascriptInterface
    public void openSite(int index) {
        activity.runOnUiThread(() -> {
            activity.showTab(MainActivity.SITES);
            activity.sites.open(index);
        });
    }

    @JavascriptInterface
    public void showTab(String tab) {
        activity.runOnUiThread(() -> activity.showTab(tab));
    }
}
