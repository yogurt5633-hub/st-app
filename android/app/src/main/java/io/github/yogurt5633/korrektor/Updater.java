package io.github.yogurt5633.korrektor;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Looks for new versions on GitHub:
 *  - the app: the latest release "app-<versionCode>" with an .apk asset;
 *  - Korrektor (plugin): the version in plugin/package.json on main, compared
 *    with the version the running SillyTavern reports.
 */
final class Updater {
    static final String RELEASES = "https://api.github.com/repos/yogurt5633-hub/st-app/releases/latest";
    static final String PLUGIN_PACKAGE = "https://raw.githubusercontent.com/yogurt5633-hub/st-app/" + BuildConfig.SOURCE_BRANCH + "/plugin/package.json";

    private Updater() {
    }

    static long appVersionCode(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    static String appVersionName(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /** Compares dotted versions like 0.3.1 and 0.10.0. */
    static int compare(String a, String b) {
        String[] x = (a == null ? "" : a).split("\\.");
        String[] y = (b == null ? "" : b).split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? parse(x[i]) : 0;
            int q = i < y.length ? parse(y[i]) : 0;
            if (p != q) return Integer.compare(p, q);
        }
        return 0;
    }

    private static int parse(String s) {
        try {
            return Integer.parseInt(s.replaceAll("[^0-9]", ""));
        } catch (Exception e) {
            return 0;
        }
    }

    /** Reconcile saved release data after installing an APK, including while offline. */
    static JSONObject normalizeCached(JSONObject out, long current, String name) throws org.json.JSONException {
        JSONObject app = out.optJSONObject("app");
        if (app != null) {
            app.put("current", name);
            app.put("currentCode", current);
            app.put("available", app.optLong("latestCode") > current && !app.optString("url").isEmpty());
        }
        return out;
    }

    static JSONObject cached(Context context, Prefs prefs) {
        try {
            JSONObject out = normalizeCached(new JSONObject(prefs.text("updateResult")), appVersionCode(context), appVersionName(context));
            if (!BuildConfig.SOURCE_BRANCH.equals(out.optString("sourceBranch"))) out.remove("korrektor");
            return out;
        } catch (Exception ignored) { return new JSONObject(); }
    }

    /** Blocking: call from a background thread. Failed checks keep the last known release. */
    static synchronized JSONObject check(Context context, Prefs prefs) {
        JSONObject out = cached(context, prefs);
        boolean releaseOk = false;
        boolean packageOk = false;
        JSONObject app = out.optJSONObject("app");
        if (app == null) app = new JSONObject();
        try {
            Net.Reply release = Net.get(RELEASES, 15000, false);
            if (!release.ok()) throw new Exception(release.status == 404 ? "Выпусков приложения пока нет" : "GitHub не ответил. Показаны последние полученные данные");
            JSONObject json = new JSONObject(release.body);
            String tag = json.optString("tag_name", "");
            long code = tag.startsWith("app-") ? parseLong(tag.substring(4)) : 0;
            String apk = "";
            JSONArray assets = json.optJSONArray("assets");
            for (int i = 0; assets != null && i < assets.length(); i++) {
                JSONObject asset = assets.getJSONObject(i);
                if (asset.optString("name").endsWith(".apk")) {
                    apk = asset.optString("browser_download_url");
                    break;
                }
            }
            if (code <= 0 || apk.isEmpty()) throw new Exception("В выпуске GitHub пока нет APK. Попробуйте проверить позже");
            String title = json.optString("name", "").replaceFirst("^[^0-9]*", "");
            app.put("latest", title.isEmpty() ? tag : title);
            app.put("latestCode", code);
            app.put("notes", json.optString("body"));
            app.put("url", apk);
            app.remove("error");
            prefs.setText("apkUrl", apk);
            prefs.setNumber("apkCode", code);
            releaseOk = true;
        } catch (Exception e) {
            try { app.put("error", e.getMessage()); } catch (Exception ignored) { }
        }
        JSONObject korrektor = out.optJSONObject("korrektor");
        if (korrektor == null) korrektor = new JSONObject();
        try {
            Net.Reply pkg = Net.get(PLUGIN_PACKAGE, 15000, false);
            Net.Reply status = Net.get(prefs.stUrl() + "/api/plugins/korrektor/status", 8000, true);
            String latest = pkg.ok() ? new JSONObject(pkg.body).optString("version", "") : korrektor.optString("latest");
            String installed = status.ok() ? new JSONObject(status.body).optString("version", "") : "";
            korrektor.put("latest", latest);
            korrektor.put("current", installed);
            korrektor.put("available", !latest.isEmpty() && !installed.isEmpty() && compare(latest, installed) > 0);
            korrektor.put("stRunning", status.ok());
            korrektor.remove("error");
            if (!pkg.ok()) korrektor.put("error", "Не удалось проверить новую версию плагина. Показаны последние полученные данные");
            else if (!status.ok()) korrektor.put("error", "Нет связи с плагином в SillyTavern");
            prefs.setText("korrektorLatest", latest);
            packageOk = pkg.ok() && !latest.isEmpty();
        } catch (Exception e) {
            try { korrektor.put("error", "Не удалось прочитать версию плагина"); korrektor.put("available", false); } catch (Exception ignored) { }
        }
        try {
            out.remove("error");
            out.put("app", app);
            out.put("korrektor", korrektor);
            out.put("sourceBranch", BuildConfig.SOURCE_BRANCH);
            normalizeCached(out, appVersionCode(context), appVersionName(context));
            if (releaseOk && packageOk) prefs.setNumber("lastCheck", System.currentTimeMillis());
        } catch (Exception ignored) { }
        prefs.setText("updateResult", out.toString());
        return out;
    }

    private static long parseLong(String s) {
        try {
            return Long.parseLong(s.trim());
        } catch (Exception e) {
            return 0;
        }
    }

    static boolean canInstall(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.getPackageManager().canRequestPackageInstalls();
    }

    static void openInstallSettings(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        }
    }

    /**
     * Downloads the new APK and opens Android's installer; the user taps "Install".
     * @return null when the download started, otherwise a reason
     */
    static String downloadAndInstall(Context context, Prefs prefs, Runnable onStarted) {
        String url = prefs.text("apkUrl");
        if (url.isEmpty()) return "Нет ссылки на новую версию, проверьте обновления ещё раз";
        if (!canInstall(context)) {
            openInstallSettings(context);
            return "Разрешите Корректору устанавливать приложения и нажмите «Обновить» ещё раз";
        }
        DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        request.setTitle("Корректор: новая версия");
        request.setMimeType("application/vnd.android.package-archive");
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
        request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, "korrektor-" + prefs.number("apkCode") + ".apk");
        final long id = dm.enqueue(request);
        final Context app = context.getApplicationContext();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
                app.unregisterReceiver(this);
                Uri uri = dm.getUriForDownloadedFile(id);
                if (uri == null) {
                    Toast.makeText(app, "Не удалось скачать новую версию, попробуйте ещё раз", Toast.LENGTH_LONG).show();
                    return;
                }
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                // Android does not let a hidden app open screens: then the notification opens the installer.
                if (MainActivity.visible) app.startActivity(install);
                else Notifier.show(app, 12, "Новая версия скачана", "Нажмите, чтобы установить", install);
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            app.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            app.registerReceiver(receiver, filter);
        }
        if (onStarted != null) onStarted.run();
        return null;
    }
}
