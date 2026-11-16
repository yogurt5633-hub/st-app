package io.github.yogurt5633.korrektor;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class UpdaterTest {
    @Test public void installedApkIsNotOfferedAgainFromCache() throws Exception {
        JSONObject out = new JSONObject("{\"app\":{\"latestCode\":150,\"available\":true,\"url\":\"https://example.org/app.apk\"}}");
        Updater.normalizeCached(out, 150, "1.0.50");
        assertFalse(out.getJSONObject("app").getBoolean("available"));
        assertEquals("1.0.50", out.getJSONObject("app").getString("current"));
        Updater.normalizeCached(out, 151, "1.0.51");
        assertFalse(out.getJSONObject("app").getBoolean("available"));
    }

    @Test public void newerReleaseRemainsUsableWhenOffline() throws Exception {
        JSONObject out = new JSONObject("{\"app\":{\"latestCode\":152,\"url\":\"https://example.org/app.apk\",\"error\":\"offline\"}}");
        Updater.normalizeCached(out, 151, "1.0.51");
        assertTrue(out.getJSONObject("app").getBoolean("available"));
        assertEquals("offline", out.getJSONObject("app").getString("error"));
        out.getJSONObject("app").remove("url");
        Updater.normalizeCached(out, 151, "1.0.51");
        assertFalse(out.getJSONObject("app").getBoolean("available"));
    }

    @Test public void versionsCompareNumerically() {
        assertTrue(Updater.compare("0.4.27", "0.4.9") > 0);
        assertEquals(0, Updater.compare("0.4.27", "0.4.27"));
        assertTrue(Updater.compare("0.4.26", "0.4.27") < 0);
    }

    @Test public void duplicateThemesMigrateAndDistinctOnesAreKept() {
        assertEquals("dark", Palette.migrate("black"));
        assertEquals("light", Palette.migrate("white"));
        assertEquals("midnight", Palette.migrate("midnight"));
        assertEquals("mist", Palette.migrate("mist"));
        assertTrue(Palette.isLight("light"));
        assertTrue(Palette.isLight("mist"));
        assertFalse(Palette.isLight("dark"));
        assertFalse(Palette.isLight("midnight"));
        assertFalse(Palette.isLight("brown"));
    }
}
