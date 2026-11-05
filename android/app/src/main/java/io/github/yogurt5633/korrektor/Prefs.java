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

    String stUrl() {
        String url = sp.getString("stUrl", DEFAULT_URL);
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
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
}
