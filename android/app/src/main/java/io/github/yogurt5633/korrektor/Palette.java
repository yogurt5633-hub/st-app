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

    /** Themes the person can pick. Older black/white were near copies of dark/light and map to them. */
    static final String THEMES = "light|dark|brown|midnight|mist";

    private Palette(String theme, String accent) {
        boolean light = isLight(theme);
        this.light = light;
        // Order: background, deep, card, raised, border, text, muted, primary text.
        String[] colors;
        switch (theme) {
            case "midnight":
                colors = new String[]{"#121722", "#0d111a", "#192131", "#222c3f", "#2a3446", "#e6eaf2", "#95a0b4", "#121722"};
                break;
            case "mist":
                colors = new String[]{"#eef2f6", "#e3e9f0", "#f9fbfc", "#e2e8ef", "#d3dbe5", "#17202a", "#556274", "#f9fbfc"};
                break;
            case "brown":
                colors = new String[]{"#211b17", "#181412", "#2a231e", "#352c25", "#3c332b", "#f1e8dd", "#b6a694", "#211b17"};
                break;
            case "light":
                colors = new String[]{"#f7f4ee", "#efe9df", "#fdfbf7", "#e8e1d5", "#ddd5c8", "#1f1b16", "#6c6358", "#fdfbf7"};
                break;
            default:
                colors = new String[]{"#161513", "#12110f", "#1c1a18", "#262421", "#2a2824", "#efe9de", "#aaa398", "#161513"};
        }
        bg = Color.parseColor(colors[0]);
        deep = Color.parseColor(colors[1]);
        card = Color.parseColor(colors[2]);
        raised = Color.parseColor(colors[3]);
        line = Color.parseColor(colors[4]);
        text = Color.parseColor(colors[5]);
        muted = Color.parseColor(colors[6]);
        onPrimary = Color.parseColor(colors[7]);
        this.accent = Color.parseColor(accentHex(accent, light, "mist".equals(theme)));
    }

    static boolean isLight(String theme) {
        return "light".equals(theme) || "mist".equals(theme);
    }

    /** A saved theme name as it is now: black and white were removed. */
    static String migrate(String theme) {
        if ("black".equals(theme)) return "dark";
        if ("white".equals(theme)) return "light";
        return theme;
    }

    static String accentHex(String accent, boolean light) {
        return accentHex(accent, light, false);
    }

    /** Mist is a cooler paper: the default mint is under 4.5:1 on it, so it gets a deeper one. */
    static String accentHex(String accent, boolean light, boolean mist) {
        switch (accent == null ? "" : accent) {
            case "rose": return light ? "#a8325a" : "#e58aa0";
            case "mint": return light ? (mist ? "#0b6b4a" : "#0f7a55") : "#5fc9a0";
            case "sky": return light ? "#1d5f9e" : "#6aaee8";
            case "lavender": return light ? "#5b47b3" : "#a99be8";
            default: return light ? "#8a5200" : "#e3a54a";
        }
    }

    /** The chosen theme, or the system one (light or dark) for "system". */
    static String resolvedTheme(Context context, Prefs prefs) {
        String theme = migrate(prefs.text(Prefs.THEME));
        if (theme != null && theme.matches(THEMES)) return theme;
        if ("system".equals(theme)) {
            int night = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            return night == Configuration.UI_MODE_NIGHT_NO ? "light" : "dark";
        }
        return "dark";
    }

    static Palette of(Context context, Prefs prefs) {
        String accent = prefs.text(Prefs.ACCENT);
        return new Palette(resolvedTheme(context, prefs), accent.isEmpty() ? "amber" : accent);
    }
}
