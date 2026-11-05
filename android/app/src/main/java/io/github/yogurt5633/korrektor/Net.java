package io.github.yogurt5633.korrektor;

import android.util.Base64;
import android.webkit.CookieManager;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Tiny blocking HTTP GET. Call from a background thread only. */
final class Net {
    private Net() {
    }

    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }

        boolean ok() {
            return status >= 200 && status < 300;
        }
    }

    /** Login for SillyTavern's basicAuth, if the user gave one; null otherwise. */
    static volatile String[] auth;

    /**
     * @param withCookies send the WebView cookies and the saved login for this address (SillyTavern session)
     */
    static Reply get(String address, int timeoutMs, boolean withCookies) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(address).openConnection();
            connection.setConnectTimeout(timeoutMs);
            connection.setReadTimeout(timeoutMs);
            connection.setRequestProperty("User-Agent", "KorrektorApp");
            connection.setRequestProperty("Accept", "application/json, */*");
            if (withCookies) {
                String cookies = CookieManager.getInstance().getCookie(address);
                if (cookies != null) connection.setRequestProperty("Cookie", cookies);
                String[] login = auth;
                if (login != null) {
                    String pair = login[0] + ":" + login[1];
                    connection.setRequestProperty("Authorization", "Basic " + Base64.encodeToString(pair.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                }
            }
            int status = connection.getResponseCode();
            InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = "";
            if (in != null) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int n;
                int total = 0;
                while ((n = in.read(buffer)) > 0 && total < 4_000_000) {
                    out.write(buffer, 0, n);
                    total += n;
                }
                in.close();
                body = out.toString(StandardCharsets.UTF_8.name());
            }
            return new Reply(status, body);
        } catch (Exception e) {
            return new Reply(0, "");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Is SillyTavern answering at this address? */
    static boolean alive(String stUrl) {
        return get(stUrl + "/", 2500, false).status > 0;
    }
}
