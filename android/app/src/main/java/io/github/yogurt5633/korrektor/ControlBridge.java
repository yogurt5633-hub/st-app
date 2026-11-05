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
            s.put("stUrl", prefs.phoneUrl());
            s.put("pcUrl", prefs.pcUrl());
            s.put("onPc", prefs.onPc());
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
            s.put("progress", activity.progress);
            s.put("termuxReady", activity.termuxReady == null ? JSONObject.NULL : activity.termuxReady);
            s.put("termuxError", activity.termuxError);
            s.put("termuxChecking", activity.termuxChecking);
            s.put("git", activity.gitInstalled);
            s.put("stDir", activity.stDir);
            s.put("startCmd", prefs.text(Prefs.START_CMD));
            s.put("permissionDenied", activity.permissionDenied);
            s.put("showSites", prefs.flag(Prefs.SHOW_SITES, true));
            s.put("showModelBar", prefs.flag(Prefs.SHOW_MODEL_BAR, true));
            s.put("theme", prefs.text(Prefs.THEME).isEmpty() ? "dark" : prefs.text(Prefs.THEME));
            s.put("resolvedTheme", Palette.resolvedTheme(activity, prefs));
            s.put("accent", prefs.text(Prefs.ACCENT).isEmpty() ? "amber" : prefs.text(Prefs.ACCENT));
            s.put("onboardingDone", prefs.number(Prefs.ONBOARDING) >= Prefs.ONBOARDING_VERSION);
            // While another tab is open the home page does not redraw at all.
            s.put("homeShown", activity.homeShown());
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
        activity.runOnUiThread(() -> activity.checkUpdates(true));
    }

    @JavascriptInterface
    public void reloadTavern() {
        activity.runOnUiThread(activity::reloadTavern);
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
            case "guide":
                url = "https://github.com/yogurt5633-hub/st-app/blob/main/docs/GUIDE.md";
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
        activity.runOnUiThread(() -> activity.switchTarget(activity.prefs.onPc() ? "pc" : "phone"));
    }

    /** Address of the tavern on a computer (same Wi-Fi or Tailscale); empty removes it. */
    @JavascriptInterface
    public void setPcUrl(String url) {
        String value = url == null ? "" : url.trim();
        if (!value.isEmpty() && !value.matches("^https?://[A-Za-z0-9.\\-\\[\\]:]+(:\\d+)?/?$")) {
            activity.toast("Адрес должен выглядеть так: http://192.168.1.10:8000");
            return;
        }
        activity.prefs.setPcUrl(value);
        if (value.isEmpty()) activity.prefs.setTarget("phone");
        activity.toast(value.isEmpty() ? "Адрес ПК убран" : "Адрес ПК сохранён");
        activity.runOnUiThread(() -> activity.switchTarget(activity.prefs.onPc() ? "pc" : "phone"));
    }

    /** "phone" or "pc": which tavern the app shows. */
    @JavascriptInterface
    public void setTarget(String target) {
        activity.runOnUiThread(() -> activity.switchTarget(target));
    }

    @JavascriptInterface
    public void setFlag(String key, boolean value) {
        if (Prefs.AUTO_START.equals(key) || Prefs.AUTO_UPDATE.equals(key) || Prefs.NOTIFY.equals(key) || Prefs.SHOW_SITES.equals(key) || Prefs.SHOW_MODEL_BAR.equals(key)) {
            activity.prefs.setFlag(key, value);
        }
        if (Prefs.SHOW_SITES.equals(key)) activity.runOnUiThread(() -> activity.setSitesVisible(value));
        if (Prefs.SHOW_MODEL_BAR.equals(key)) activity.runOnUiThread(activity::refreshModelBar);
    }

    @JavascriptInterface
    public void copy(String text) {
        activity.runOnUiThread(() -> {
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("Корректор", text));
            activity.toast("Скопировано");
        });
    }

    /** dark | light | system, and the accent colour. */
    @JavascriptInterface
    public void setTheme(String theme, String accent) {
        String t = "light".equals(theme) || "system".equals(theme) ? theme : "dark";
        String a = accent != null && accent.matches("amber|rose|mint|sky|lavender") ? accent : "amber";
        activity.prefs.setText(Prefs.THEME, t);
        activity.prefs.setText(Prefs.ACCENT, a);
        activity.runOnUiThread(activity::applyPalette);
    }

    /** Numbers for the home page; they arrive as onNative("dashboard", …). */
    @JavascriptInterface
    public void dashboard() {
        activity.runOnUiThread(activity::loadDashboard);
    }

    @JavascriptInterface
    public void openChat(String chatId) {
        if (chatId == null || !chatId.matches("^[cg]/.+")) return;
        activity.runOnUiThread(() -> activity.openChat(chatId));
    }

    /** Opens a screen of the Korrektor tab, for example "#tools/spend". */
    @JavascriptInterface
    public void openKorrektor(String hash) {
        if (hash == null || !hash.matches("^#[a-z/]*$")) return;
        activity.runOnUiThread(() -> activity.openKorrektor(hash));
    }

    @JavascriptInterface
    public void report() {
        activity.runOnUiThread(activity::reportProblem);
    }

    @JavascriptInterface
    public void finishOnboarding() {
        activity.runOnUiThread(activity::finishOnboarding);
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
