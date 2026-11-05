package io.github.yogurt5633.korrektor;

import android.content.Context;
import android.content.SharedPreferences;

/** Small settings of the app itself (SillyTavern address, update options). */
final class Prefs {
    static final String DEFAULT_URL = "http://127.0.0.1:8000";

    private final SharedPreferences sp;

    Prefs(Context context) {
        sp = context.getSharedPreferences("korrektor", Context.MODE_PRIVATE);
        Net.auth = auth();
    }

    /** Address of the tavern in use: the one on this phone, or the one on the PC. */
    String stUrl() {
        return onPc() ? pcUrl() : phoneUrl();
    }

    String phoneUrl() {
        String url = sp.getString("stUrl", DEFAULT_URL);
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    String pcUrl() {
        String url = sp.getString("pcUrl", "");
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    void setPcUrl(String url) {
        sp.edit().putString("pcUrl", url).apply();
    }

    /** The PC tavern is in use (it runs on the PC, so Termux does not start or stop it). */
    boolean onPc() {
        return "pc".equals(sp.getString("target", "phone")) && !sp.getString("pcUrl", "").isEmpty();
    }

    void setTarget(String target) {
        sp.edit().putString("target", "pc".equals(target) ? "pc" : "phone").apply();
    }

    void setStUrl(String url) {
        sp.edit().putString("stUrl", url).apply();
    }

    boolean flag(String key, boolean fallback) {
        return sp.getBoolean(key, fallback);
    }

    void setFlag(String key, boolean value) {
        sp.edit().putBoolean(key, value).apply();
    }

    long number(String key) {
        return sp.getLong(key, 0);
    }

    void setNumber(String key, long value) {
        sp.edit().putLong(key, value).apply();
    }

    String text(String key) {
        return sp.getString(key, "");
    }

    void setText(String key, String value) {
        sp.edit().putString(key, value).apply();
    }

    /** Number for the next Termux command: comes back with its result. Survives restarts. */
    int nextRun() {
        long next = number("runCounter") % 1_000_000 + 1;
        setNumber("runCounter", next);
        return (int) next;
    }

    /** Login and password when SillyTavern has basicAuth on. Kept only in this app's private storage. */
    String[] auth() {
        String user = sp.getString("authUser", "");
        return user.isEmpty() ? null : new String[]{user, sp.getString("authPass", "")};
    }

    void setAuth(String user, String pass) {
        sp.edit().putString("authUser", user).putString("authPass", pass).apply();
        Net.auth = auth();
    }

    // Option keys
    static final String AUTO_START = "autoStart";           // start SillyTavern when the app opens
    static final String AUTO_UPDATE = "autoUpdate";         // update Korrektor before starting SillyTavern
    static final String NOTIFY = "notify";                  // notifications about new cards and updates
    static final String LAST_TAB = "lastTab";
    static final String SHOW_SITES = "showSites";           // the "Sites" tab with AI providers' pages
    static final String START_CMD = "startCmd";             // the user's own command to start SillyTavern; empty = automatic
    static final String THEME = "theme";                    // dark | light | system
    static final String ACCENT = "accent";                  // amber | rose | mint | sky | lavender
    static final String SHOW_MODEL_BAR = "showModelBar";    // model and preset row above the tavern
    static final String KEEP_ALIVE = "keepAlive";           // «Таверна открыта» notification keeps the app loaded
    static final String ONBOARDING = "onboarding";          // version of the welcome screens already seen
    static final int ONBOARDING_VERSION = 1;

    /**
     * "start-update" only when a newer Korrektor is already known (from the update check);
     * otherwise a plain start that does not wait for GitHub.
     */
    String startAction() {
        if (!flag(AUTO_UPDATE, true)) return "start";
        String latest = text("korrektorLatest");
        String installed = text("korrektorInstalled");
        if (latest.isEmpty()) return "start";
        // Never seen the installed version: the ctl script compares versions itself.
        if (installed.isEmpty()) return "start-update";
        return Updater.compare(latest, installed) > 0 ? "start-update" : "start";
    }
}
