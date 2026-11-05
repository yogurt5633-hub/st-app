package io.github.yogurt5633.korrektor;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Saves files that SillyTavern and Korrektor offer for download (exports of
 * chats, cards, lorebooks). Those pages build the file in the browser (blob:),
 * which Android's download manager cannot fetch, so the page hands the bytes over.
 * This is the only thing pages in the Tavern and Korrektor tabs can ask of the app.
 */
final class FilesBridge {
    static final String NAME = "KorrektorFiles";

    // Injected into every page: intercepts <a download href="blob:..."> clicks.
    static final String HOOK = "(function(){"
            + "if(window.__korrektorFiles)return;window.__korrektorFiles=true;"
            + "var orig=HTMLAnchorElement.prototype.click;"
            + "function send(href,name){fetch(href).then(function(r){return r.blob();}).then(function(b){"
            + "return new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(fr.result);};fr.onerror=rej;fr.readAsDataURL(b);});"
            + "}).then(function(u){var i=String(u).indexOf(',');var meta=String(u).slice(0,i);var m=/data:([^;,]+)/.exec(meta);"
            + "KorrektorFiles.save(name||'download',m?m[1]:'application/octet-stream',String(u).slice(i+1));"
            + "}).catch(function(e){KorrektorFiles.failed(String(e));});}"
            + "window.__korrektorSave=send;"
            + "HTMLAnchorElement.prototype.click=function(){var h=this.href||'';"
            + "if(this.hasAttribute('download')&&/^(blob:|data:)/.test(h)){send(h,this.getAttribute('download'));return;}"
            + "return orig.apply(this,arguments);};"
            + "document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[download]'):null;"
            + "if(a&&/^(blob:|data:)/.test(a.href||'')){e.preventDefault();send(a.href,a.getAttribute('download'));}},true);"
            + "})();";

    private final Activity activity;

    FilesBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void save(String name, String mime, String base64) {
        String safe = sanitize(name);
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            write(safe, mime, data);
            toast("Сохранено: Загрузки/Korrektor/" + safe);
        } catch (Exception e) {
            toast("Не удалось сохранить файл: " + e.getMessage());
        }
    }

    /**
     * Opens Android's «Share» with a file and a text (Telegram puts the text under the file).
     * Used by «Предложить своё»: the preset goes to the catalog's author in a couple of taps.
     */
    @JavascriptInterface
    public void share(String name, String mime, String base64, String text) {
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            File dir = ShareProvider.folder(activity);
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();
            File file = new File(dir, sanitize(name));
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(data);
            }
            android.content.Intent send = new android.content.Intent(android.content.Intent.ACTION_SEND);
            send.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            Uri uri = ShareProvider.uriFor(activity, file);
            send.putExtra(android.content.Intent.EXTRA_STREAM, uri);
            if (text != null && !text.isEmpty()) send.putExtra(android.content.Intent.EXTRA_TEXT, text);
            send.setClipData(android.content.ClipData.newRawUri(file.getName(), uri));
            send.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            android.content.Intent chooser = android.content.Intent.createChooser(send, "Отправить автору каталога");
            chooser.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.runOnUiThread(() -> activity.startActivity(chooser));
        } catch (Exception e) {
            toast("Не удалось поделиться файлом: " + e.getMessage());
        }
    }

    @JavascriptInterface
    public void failed(String message) {
        toast("Не удалось сохранить файл: " + message);
    }

    private void write(String name, String mime, byte[] data) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = activity.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Korrektor");
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IllegalStateException("нет доступа к Загрузкам");
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IllegalStateException("нет доступа к Загрузкам");
                out.write(data);
            }
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Korrektor");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("нет доступа к Загрузкам");
            try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
                out.write(data);
            }
        }
    }

    static String sanitize(String name) {
        String value = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (value.isEmpty() || value.startsWith(".")) value = "download" + value;
        return value.length() > 120 ? value.substring(value.length() - 120) : value;
    }

    private void toast(String text) {
        activity.runOnUiThread(() -> Toast.makeText(activity, text, Toast.LENGTH_LONG).show());
    }
}
