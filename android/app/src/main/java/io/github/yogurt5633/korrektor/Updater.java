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
    static final String PLUGIN_PACKAGE = "https://raw.githubusercontent.com/yogurt5633-hub/st-app/main/plugin/package.json";

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

    /** Blocking: call from a background thread. Also stores what it found in prefs. */
    static JSONObject check(Context context, Prefs prefs) {
        JSONObject out = new JSONObject();
        try {
            long current = appVersionCode(context);
            JSONObject app = new JSONObject();
            app.put("current", appVersionName(context));
            app.put("currentCode", current);
            Net.Reply release = Net.get(RELEASES, 15000, false);
            if (release.ok()) {
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
                app.put("latest", json.optString("name", tag));
                app.put("latestCode", code);
                app.put("url", apk);
                app.put("available", code > current && !apk.isEmpty());
                prefs.setText("apkUrl", apk);
                prefs.setNumber("apkCode", code);
            } else {
                app.put("error", release.status == 404 ? "Выпусков приложения пока нет" : "GitHub не ответил");
            }
            out.put("app", app);

            JSONObject korrektor = new JSONObject();
            Net.Reply pkg = Net.get(PLUGIN_PACKAGE, 15000, false);
            String latest = pkg.ok() ? new JSONObject(pkg.body).optString("version", "") : "";
            Net.Reply status = Net.get(prefs.stUrl() + "/api/plugins/korrektor/status", 8000, true);
            String installed = status.ok() ? new JSONObject(status.body).optString("version", "") : "";
            korrektor.put("latest", latest);
            korrektor.put("current", installed);
            korrektor.put("available", !latest.isEmpty() && !installed.isEmpty() && compare(latest, installed) > 0);
            korrektor.put("stRunning", status.status > 0);
            out.put("korrektor", korrektor);
            prefs.setText("korrektorLatest", latest);
            prefs.setNumber("lastCheck", System.currentTimeMillis());
        } catch (Exception e) {
            try {
                out.put("error", e.getMessage());
            } catch (Exception ignored) {
                // nothing
            }
        }
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
