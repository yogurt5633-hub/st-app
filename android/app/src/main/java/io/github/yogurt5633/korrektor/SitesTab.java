package io.github.yogurt5633.korrektor;

import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "Sites" tab: pages of AI providers (OpenRouter and others) inside the app, so
 * keys and models can be changed without leaving it. A row of names on top
 * switches between them. These pages are third-party: their web view gets no
 * bridge to the app, no file access, and links to other apps open outside.
 */
final class SitesTab {
    static final String DEFAULT = "["
            + "{\"name\":\"OpenRouter\",\"url\":\"https://openrouter.ai/settings/keys\"},"
            + "{\"name\":\"Элизиум\",\"url\":\"https://elysiumai.garden/\"},"
            + "{\"name\":\"DDTokens\",\"url\":\"https://www.apiddt.com/\"}"
            + "]";
    static final int MAX_SITES = 20;


    private final MainActivity activity;
    private final LinearLayout root;
    private final LinearLayout chips;
    private WebView web;
    private final View line;
    private int selected = -1;
    private Palette palette;

    SitesTab(MainActivity activity) {
        this.activity = activity;
        this.palette = activity.palette;
        root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(palette.bg);

        HorizontalScrollView scroll = new HorizontalScrollView(activity);
        scroll.setHorizontalScrollBarEnabled(false);
        chips = new LinearLayout(activity);
        chips.setOrientation(LinearLayout.HORIZONTAL);
        chips.setPadding(dp(12), dp(8), dp(12), dp(8));
        scroll.addView(chips);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        line = new View(activity);
        line.setBackgroundColor(palette.line);
        root.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1));

        web = makeWeb();
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
    }

    private WebView makeWeb() {
        WebView web = new WebView(activity);
        web.setBackgroundColor(palette.bg);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false); // target=_blank opens here
        s.setTextZoom(100);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true); // sign-in pages need it
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (scheme.equals("http") || scheme.equals("https")) return false;
                openOutside(uri.toString());
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
                // Android stopped the page engine to free memory: a fresh page instead of a crash.
                v.post(() -> recover(v));
                return true;
            }
        });
        return web;
    }

    private void recover(WebView dead) {
        if (dead != web) return;
        String url = dead.getUrl();
        int index = root.indexOfChild(dead);
        root.removeView(dead);
        dead.destroy();
        web = makeWeb();
        root.addView(web, index, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        if (url != null && url.startsWith("http")) web.loadUrl(url);
    }

    View view() {
        return root;
    }

    void setPalette(Palette palette) {
        this.palette = palette;
        root.setBackgroundColor(palette.bg);
        line.setBackgroundColor(palette.line);
        web.setBackgroundColor(palette.bg);
        rebuild();
    }

    WebView webView() {
        return web;
    }

    /** Saved list, or the default one. */
    JSONArray sites() {
        String saved = activity.prefs.text("sites");
        try {
            return new JSONArray(saved.isEmpty() ? DEFAULT : saved);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /**
     * Keeps only valid entries: a name and an http(s) address.
     * @return null when saved, otherwise what is wrong
     */
    String save(String json) {
        JSONArray clean = new JSONArray();
        try {
            JSONArray list = new JSONArray(json);
            for (int i = 0; i < list.length() && clean.length() < MAX_SITES; i++) {
                JSONObject item = list.getJSONObject(i);
                String name = item.optString("name", "").trim();
                String url = item.optString("url", "").trim();
                if (!url.matches("(?i)^https?://.*")) url = "https://" + url;
                Uri uri = Uri.parse(url);
                if (name.isEmpty() || name.length() > 40) return "Название сайта: от 1 до 40 символов";
                if (uri.getHost() == null || !uri.getHost().contains(".") || url.length() > 500) return "Не похоже на адрес сайта: " + item.optString("url", "");
                clean.put(new JSONObject().put("name", name).put("url", url));
            }
        } catch (Exception e) {
            return "Список сайтов не сохранился";
        }
        activity.prefs.setText("sites", clean.toString());
        // Positions may have moved: open the remembered site again next time the tab is shown.
        selected = -1;
        rebuild();
        if (root.getVisibility() == View.VISIBLE) onShown();
        return null;
    }

    /** Draws the row of site names; opens the last one used when nothing is open yet. */
    void rebuild() {
        chips.removeAllViews();
        JSONArray list = sites();
        if (selected >= list.length()) selected = -1;
        for (int i = 0; i < list.length(); i++) {
            final int index = i;
            JSONObject item = list.optJSONObject(i);
            if (item == null) continue;
            chips.addView(chip(item.optString("name"), i == selected, false, v -> open(index)));
        }
        if (list.length() > 0) chips.addView(chip("В браузере", false, true, v -> {
            String url = web.getUrl();
            if (url != null && url.startsWith("http")) openOutside(url);
        }));
        chips.addView(chip(list.length() == 0 ? "Добавить сайт" : "Изменить список", false, true, v -> activity.showSitesSettings()));
    }

    /** Shows the tab; loads the last used site the first time. */
    void onShown() {
        if (selected < 0) {
            int last = (int) activity.prefs.number("siteIndex");
            JSONArray list = sites();
            if (list.length() > 0) open(Math.min(Math.max(last, 0), list.length() - 1));
            else rebuild();
        }
    }

    void open(int index) {
        JSONArray list = sites();
        JSONObject item = list.optJSONObject(index);
        if (item == null) return;
        selected = index;
        activity.prefs.setNumber("siteIndex", index);
        web.loadUrl(item.optString("url"));
        rebuild();
    }

    private void openOutside(String url) {
        try {
            Intent intent = url.startsWith("intent:") ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            intent.setSelector(null);
            activity.startActivity(intent);
        } catch (Exception e) {
            activity.toast("Нет приложения, чтобы открыть эту ссылку");
        }
    }

    private TextView chip(String text, boolean on, boolean quiet, View.OnClickListener click) {
        TextView chip = new TextView(activity);
        chip.setText(text);
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        chip.setTypeface(Typeface.DEFAULT, on ? Typeface.BOLD : Typeface.NORMAL);
        chip.setTextColor(on ? palette.onPrimary : quiet ? palette.muted : palette.text);
        chip.setPadding(dp(14), dp(8), dp(14), dp(8));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(18));
        bg.setColor(on ? palette.text : quiet ? palette.bg : palette.raised);
        if (quiet) bg.setStroke(1, palette.line);
        chip.setBackground(bg);
        chip.setOnClickListener(click);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMarginEnd(dp(8));
        chip.setLayoutParams(lp);
        return chip;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, activity.getResources().getDisplayMetrics()));
    }
}
