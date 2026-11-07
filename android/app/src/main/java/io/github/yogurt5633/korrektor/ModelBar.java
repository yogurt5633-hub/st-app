package io.github.yogurt5633.korrektor;

import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The row above the tavern: reload the page, translation, backgrounds, the
 * avatar window, and the model and preset of the Chat Completion connection.
 * Everything works through SillyTavern's own fields and buttons on the page
 * (the same as choosing them in its menus), so SillyTavern saves the choice itself.
 */
final class ModelBar {
    // What is selected now. Model fields differ per source; the common pattern is #model_<source>_select.
    private static final String READ = "(function(){try{"
            + "var $=window.jQuery;if(!$||!window.SillyTavern)return JSON.stringify({ok:false});"
            + "var out={ok:true,gallery:!!window.korrektorGallery,translator:!!window.korrektorTranslate,api:$('#main_api').val()};"
            + "var tr=document.getElementById('translation_auto_mode'),tl=document.getElementById('translation_target_language');"
            + "if(tr&&tl&&document.getElementById('translate_chat')){out.translate={mode:tr.value,lang:tl.value,"
            + "langName:tl.selectedOptions[0]?tl.selectedOptions[0].textContent:'',provider:$('#translation_provider').val(),"
            + "languages:[].map.call(tl.options,function(o){return [o.value,o.textContent];})};}"
            + "if(window.korrektorTranslate&&window.korrektorTranslate.settings){var ks=window.korrektorTranslate.settings();"
            + "var km=window.korrektorTranslate.translateModel?window.korrektorTranslate.translateModel():{};"
            + "out.ours={auto:!!ks.auto,engine:ks.engine,lang:ks.lang,engines:window.korrektorTranslate.engines||[],model:km.model||'',modelSource:km.source||'',"
            + "key:km.key&&km.key.active?(km.key.label+' · '+km.key.model):'',keySheet:!!window.korrektorTranslate.keySheet,"
            + "guide:km.guide||'',guideSheet:!!window.korrektorTranslate.guide};}"
            + "if(out.api==='openai'){var source=$('#chat_completion_source').val();"
            + "var map={makersuite:'model_google_select',vertexai:'model_vertexai_select',custom:'model_custom_select'};"
            + "var id=map[source]||('model_'+source+'_select');var sel=document.getElementById(id);"
            + "var model='',models=[];if(sel){model=sel.value||'';models=[].map.call(sel.options,function(o){return o.value;}).filter(Boolean);}"
            + "if(source==='custom'){var inp=document.getElementById('custom_model_id');if(inp&&inp.value)model=inp.value;}"
            + "var ps=document.getElementById('settings_preset_openai');"
            + "out.source=source;out.select=sel?id:'';out.model=model;out.models=models.slice(0,1500);"
            + "out.presets=ps?[].map.call(ps.options,function(o){return o.textContent;}):[];"
            + "out.preset=ps&&ps.selectedOptions[0]?ps.selectedOptions[0].textContent:'';}"
            + "return JSON.stringify(out);"
            + "}catch(e){return JSON.stringify({ok:false});}})()";

    private final MainActivity activity;
    private WebView tavern;
    private final LinearLayout root;
    private final LinearLayout chips;
    private Palette palette;
    private JSONObject state;

    /** The tavern page was rebuilt (Android stopped its engine): read and change the new one. */
    void setTavern(WebView tavern) {
        this.tavern = tavern;
    }

    ModelBar(MainActivity activity, WebView tavern, Palette palette) {
        this.activity = activity;
        this.tavern = tavern;
        this.palette = palette;
        root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        HorizontalScrollView scroll = new HorizontalScrollView(activity);
        scroll.setHorizontalScrollBarEnabled(false);
        chips = new LinearLayout(activity);
        chips.setPadding(dp(10), dp(6), dp(10), dp(6));
        scroll.addView(chips);
        root.addView(scroll);
        draw();
    }

    View view() {
        return root;
    }

    void setPalette(Palette palette) {
        this.palette = palette;
        draw();
    }

    /** Asks the tavern page what is selected. */
    void refresh() {
        tavern.evaluateJavascript(READ, value -> {
            try {
                state = new JSONObject(new JSONArray("[" + value + "]").getString(0));
            } catch (Exception e) {
                state = null;
            }
            draw();
        });
    }

    private void draw() {
        chips.removeAllViews();
        root.setBackgroundColor(palette.bg);
        chips.addView(chip(R.drawable.ic_bar_refresh, null, false, v -> activity.reloadTavern()));
        if (state == null || !state.optBoolean("ok")) return;

        JSONObject tr = state.optJSONObject("translate");
        JSONObject ours = state.optJSONObject("ours");
        String mode = tr == null ? "none" : tr.optString("mode", "none");
        boolean on = (ours != null && ours.optBoolean("auto")) || "responses".equals(mode) || "both".equals(mode);
        String lang = ours != null && !ours.optString("lang").isEmpty() ? ours.optString("lang") : tr == null ? "" : tr.optString("lang");
        chips.addView(chip(R.drawable.ic_bar_translate, on ? "Перевод · " + lang.toUpperCase(java.util.Locale.ROOT) : "Перевод", on, v -> translateDialog()));

        if (state.optBoolean("gallery")) {
            chips.addView(chip(R.drawable.ic_bar_image, "Фоны", false, v -> tavern.evaluateJavascript("window.korrektorGallery&&window.korrektorGallery.backgrounds()", null)));
            chips.addView(chip(R.drawable.ic_bar_avatar, "Аватар", false, v -> tavern.evaluateJavascript("window.korrektorGallery&&window.korrektorGallery.avatar()", null)));
        }

        if (!activity.prefs.flag(Prefs.SHOW_MODEL_BAR, true)) return;
        if (!"openai".equals(state.optString("api"))) {
            chips.addView(chip(R.drawable.ic_bar_model, "Модель — в настройках таверны", false, null));
            return;
        }
        String model = state.optString("model");
        chips.addView(chip(R.drawable.ic_bar_model, model.isEmpty() ? "Модель не выбрана" : model, false, v -> pickModel()));
        JSONArray presets = state.optJSONArray("presets");
        if (presets != null && presets.length() > 0) {
            chips.addView(chip(R.drawable.ic_bar_preset, state.optString("preset"), false, v -> pickPreset()));
        }
    }

    // ---------- translation (SillyTavern's built-in Chat Translation) ----------

    private void translateDialog() {
        JSONObject tr = state == null ? null : state.optJSONObject("translate");
        boolean ours = state != null && state.optBoolean("translator");
        if (tr == null) {
            // Without SillyTavern's Chat Translation there is no auto mode, but old messages can still be translated.
            if (ours) run("window.korrektorTranslate.open()");
            else activity.toast("Встроенный перевод в таверне выключен: включите расширение Chat Translation в меню расширений SillyTavern");
            return;
        }
        String mode = tr.optString("mode", "none");
        JSONObject oursState = state.optJSONObject("ours");
        Sheet sheet = new Sheet(activity, palette, "Перевод");

        final boolean[] replies = {oursState != null ? oursState.optBoolean("auto") || "responses".equals(mode) || "both".equals(mode)
                : "responses".equals(mode) || "both".equals(mode)};
        final boolean[] mine = {"inputs".equals(mode) || "both".equals(mode)};
        sheet.toggle("Переводить новые ответы", oursState != null ? "Когда ответ дописан. Модель видит оригинал" : "Перевод показывается вместо текста, модель видит оригинал", replies[0], v -> replies[0] = v);
        sheet.toggle("Мои сообщения — на английский", "Перед отправкой, переводчиком таверны", mine[0], v -> mine[0] = v);

        final String[] lang = {oursState != null && !oursState.optString("lang").isEmpty() ? oursState.optString("lang") : tr.optString("lang")};
        // Most people here read Russian: offer it instead of SillyTavern's default English.
        if ("en".equals(lang[0]) && !replies[0]) lang[0] = "ru";
        JSONArray langList = tr.optJSONArray("languages");
        List<String> langNames = new ArrayList<>();
        List<String> langCodes = new ArrayList<>();
        for (int i = 0; langList != null && i < langList.length(); i++) {
            JSONArray pair = langList.optJSONArray(i);
            if (pair == null) continue;
            langCodes.add(pair.optString(0));
            langNames.add(pair.optString(1));
        }
        final TextView[] langView = new TextView[1];
        langView[0] = sheet.choice("Язык", nameOf(tr, lang[0], lang[0]), v -> Sheet.pick(activity, palette, "Язык перевода", langNames, nameOf(tr, lang[0], lang[0]), picked -> {
            int at = langNames.indexOf(picked);
            if (at < 0) return;
            lang[0] = langCodes.get(at);
            langView[0].setText(picked);
        }));

        // Which translator and which model: Korrektor's own translation.
        final String[] engine = {oursState == null ? "" : oursState.optString("engine", "auto")};
        final String[] translateModel = {oursState == null ? "" : oursState.optString("model")};
        if (oursState != null) {
            JSONArray engines = oursState.optJSONArray("engines");
            List<String> keys = new ArrayList<>();
            List<String> labels = new ArrayList<>();
            for (int i = 0; engines != null && i < engines.length(); i++) {
                JSONArray pair = engines.optJSONArray(i);
                if (pair == null) continue;
                keys.add(pair.optString(0));
                labels.add(pair.optString(1));
            }
            final TextView[] engineView = new TextView[1];
            engineView[0] = sheet.choice("Переводчик", labelOf(keys, labels, engine[0]), v -> Sheet.pick(activity, palette, "Чем переводить", labels, labelOf(keys, labels, engine[0]), picked -> {
                int i = labels.indexOf(picked);
                if (i < 0) return;
                engine[0] = keys.get(i);
                engineView[0].setText(picked);
            }));
            String key = oursState.optString("key");
            final TextView[] modelView = new TextView[1];
            if (!key.isEmpty()) {
                // A key of its own just for translation: its model translates.
                sheet.choice("Модель для перевода", "свой ключ: " + key, v -> { sheet.dismiss(); run("window.korrektorTranslate.keySheet()"); });
            } else modelView[0] = sheet.choice("Модель для перевода", translateModel[0].isEmpty() ? "дешёвая Корректора" : translateModel[0], v -> {
                List<String> names = new ArrayList<>();
                names.add("Дешёвая модель Корректора");
                JSONArray list = state.optJSONArray("models");
                for (int i = 0; list != null && i < list.length(); i++) names.add(list.optString(i));
                Sheet.pick(activity, palette, "Модель для перевода", names, translateModel[0].isEmpty() ? names.get(0) : translateModel[0], picked -> {
                    boolean cheap = names.indexOf(picked) == 0;
                    translateModel[0] = cheap ? "" : picked;
                    modelView[0].setText(cheap ? "дешёвая Корректора" : picked);
                    run("window.korrektorTranslate.setModel(" + JSONObject.quote(cheap ? "" : state.optString("source")) + "," + JSONObject.quote(translateModel[0]) + ")");
                });
            });
            sheet.note("Модель для перевода — не та, что пишет ответы: ответы пишет модель таверны (кнопка с моделью в этой строке)");
            if (oursState.optBoolean("keySheet")) {
                sheet.choice("Свой ключ для перевода", key.isEmpty() ? "не задан" : key, v -> { sheet.dismiss(); run("window.korrektorTranslate.keySheet()"); });
                sheet.choice("Журнал перевода", "что происходило, скопировать", v -> { sheet.dismiss(); run("window.korrektorTranslate.log()"); });
            }
            if (oursState.optBoolean("guideSheet")) {
                String guide = oursState.optString("guide");
                sheet.choice("Указания и глоссарий", guide.isEmpty() ? "задать" : guide, v -> { sheet.dismiss(); run("window.korrektorTranslate.guide()"); });
            }
            sheet.note("Одно сообщение — кнопка с языком в меню сообщения (⋯)");
        }

        Runnable apply = () -> {
            if (oursState != null) {
                // New replies: Korrektor's translation; SillyTavern's own keeps only «my messages to English».
                String stMode = mine[0] ? "inputs" : "none";
                run("(function(on,l,e,m){var $=window.jQuery;window.korrektorTranslate.setAuto(on,{lang:l,engine:e});"
                        + "$('#translation_target_language').val(l).trigger('change');$('#translation_auto_mode').val(m).trigger('change');})("
                        + replies[0] + "," + JSONObject.quote(lang[0]) + "," + JSONObject.quote(engine[0]) + "," + JSONObject.quote(stMode) + ")");
                return;
            }
            String next = replies[0] && mine[0] ? "both" : replies[0] ? "responses" : mine[0] ? "inputs" : "none";
            run("(function(m,l){var $=window.jQuery;$('#translation_target_language').val(l).trigger('change');"
                    + "$('#translation_auto_mode').val(m).trigger('change');})(" + JSONObject.quote(next) + "," + JSONObject.quote(lang[0]) + ")");
        };
        sheet.buttons("Готово", apply, ours ? "Старые сообщения" : "Перевести чат", () -> {
            apply.run();
            if (ours) run("window.korrektorTranslate.open({lang:" + JSONObject.quote(lang[0]) + "})");
            else run("(function(l){var $=window.jQuery;$('#translation_target_language').val(l).trigger('change');$('#translate_chat').trigger('click');})(" + JSONObject.quote(lang[0]) + ")");
        });
        sheet.show();
    }

    private static String labelOf(List<String> keys, List<String> labels, String key) {
        int i = keys.indexOf(key);
        return i >= 0 ? labels.get(i) : key;
    }

    private static String nameOf(JSONObject tr, String code, String fallback) {
        JSONArray list = tr.optJSONArray("languages");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONArray pair = list.optJSONArray(i);
            if (pair != null && code.equals(pair.optString(0))) return pair.optString(1);
        }
        return fallback;
    }

    // ---------- model and preset ----------

    private void pickModel() {
        JSONArray list = state.optJSONArray("models");
        List<String> items = new ArrayList<>();
        for (int i = 0; list != null && i < list.length(); i++) items.add(list.optString(i));
        if (items.isEmpty()) {
            activity.toast("Список моделей пуст: подключитесь к API в настройках таверны, и он появится");
            return;
        }
        Sheet.pick(activity, palette, "Модель для ответов", items, state.optString("model"), value -> run(
                "(function(v){var $=window.jQuery;var id=" + JSONObject.quote(state.optString("select")) + ";"
                        + "if(id){$('#'+id).val(v).trigger('change');}"
                        + "if(" + JSONObject.quote(state.optString("source")) + "==='custom'){$('#custom_model_id').val(v).trigger('input');}"
                        + "})(" + JSONObject.quote(value) + ")"));
    }

    private void pickPreset() {
        JSONArray list = state.optJSONArray("presets");
        List<String> items = new ArrayList<>();
        for (int i = 0; list != null && i < list.length(); i++) items.add(list.optString(i));
        Sheet.pick(activity, palette, "Пресет", items, state.optString("preset"), value -> run(
                "(function(name){var ps=document.getElementById('settings_preset_openai');if(!ps)return;"
                        + "var o=[].find.call(ps.options,function(x){return x.textContent===name;});"
                        + "if(o)window.jQuery(ps).val(o.value).trigger('change');})(" + JSONObject.quote(value) + ")"));
    }

    private void run(String js) {
        tavern.evaluateJavascript(js, ignored -> activity.runOnUiThread(() -> tavern.postDelayed(this::refresh, 700)));
    }

    // ---------- views ----------

    /** A rounded button of the row: an icon, a short text, the accent when something is on. */
    private TextView chip(int icon, String text, boolean on, View.OnClickListener click) {
        TextView chip = new TextView(activity);
        chip.setText(text == null ? "" : text);
        chip.setSingleLine(true);
        chip.setEllipsize(android.text.TextUtils.TruncateAt.END);
        chip.setMaxWidth(dp(200));
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        int color = on ? palette.accent : palette.text;
        chip.setTextColor(color);
        chip.setGravity(android.view.Gravity.CENTER_VERTICAL);
        chip.setCompoundDrawablesRelativeWithIntrinsicBounds(icon, 0, 0, 0);
        chip.setCompoundDrawableTintList(android.content.res.ColorStateList.valueOf(on ? palette.accent : palette.muted));
        chip.setCompoundDrawablePadding(text == null ? 0 : dp(6));
        chip.setPadding(text == null ? dp(9) : dp(11), dp(7), text == null ? dp(9) : dp(13), dp(7));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(18));
        bg.setColor(on ? ((palette.accent & 0x00ffffff) | 0x1f000000) : palette.raised);
        bg.setStroke(dp(1), on ? ((palette.accent & 0x00ffffff) | 0x80000000) : palette.line);
        chip.setBackground(bg);
        if (click != null) chip.setOnClickListener(click);
        else chip.setAlpha(0.7f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMarginEnd(dp(8));
        chip.setLayoutParams(lp);
        return chip;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, activity.getResources().getDisplayMetrics()));
    }
}
