package io.github.yogurt5633.korrektor;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;

/** Colours of the native parts (tab bar, rows above pages), dark or light, with the chosen accent. */
final class Palette {
    final boolean light;
    final int bg;
    final int deep;
    final int card;
    final int raised;
    final int line;
    final int text;
    final int muted;
    final int accent;
    final int onPrimary;

    private Palette(boolean light, String accent) {
        this.light = light;
        bg = Color.parseColor(light ? "#f7f4ee" : "#161513");
        deep = Color.parseColor(light ? "#efe9df" : "#12110f");
        card = Color.parseColor(light ? "#fdfbf7" : "#1c1a18");
        raised = Color.parseColor(light ? "#e8e1d5" : "#262421");
        line = Color.parseColor(light ? "#ddd5c8" : "#2a2824");
        text = Color.parseColor(light ? "#1f1b16" : "#efe9de");
        muted = Color.parseColor(light ? "#7b7266" : "#8a847a");
        onPrimary = Color.parseColor(light ? "#fdfbf7" : "#161513");
        this.accent = Color.parseColor(accentHex(accent, light));
    }

    static String accentHex(String accent, boolean light) {
        switch (accent == null ? "" : accent) {
            case "rose": return light ? "#a8325a" : "#e58aa0";
            case "mint": return light ? "#0f7a55" : "#5fc9a0";
            case "sky": return light ? "#1d5f9e" : "#6aaee8";
            case "lavender": return light ? "#5b47b3" : "#a99be8";
            default: return light ? "#8a5200" : "#e3a54a";
        }
    }

    /** "dark" or "light": the chosen theme, or the system one for "system". */
    static String resolvedTheme(Context context, Prefs prefs) {
        String theme = prefs.text(Prefs.THEME);
        if ("light".equals(theme) || "dark".equals(theme)) return theme;
        if ("system".equals(theme)) {
            int night = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            return night == Configuration.UI_MODE_NIGHT_NO ? "light" : "dark";
        }
        return "dark";
    }

    static Palette of(Context context, Prefs prefs) {
        String accent = prefs.text(Prefs.ACCENT);
        return new Palette("light".equals(resolvedTheme(context, prefs)), accent.isEmpty() ? "amber" : accent);
    }
}
