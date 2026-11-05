package io.github.yogurt5633.korrektor;

import android.app.AlertDialog;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.Switch;
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
    private final WebView tavern;
    private final LinearLayout root;
    private final LinearLayout chips;
    private Palette palette;
    private JSONObject state;

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
        chips.addView(chip("Обновить", true, v -> activity.reloadTavern()));
        if (state == null || !state.optBoolean("ok")) return;

        JSONObject tr = state.optJSONObject("translate");
        String mode = tr == null ? "none" : tr.optString("mode", "none");
        boolean on = "responses".equals(mode) || "both".equals(mode);
        chips.addView(chip(on ? "Перевод: " + tr.optString("langName") : "Перевод", false, v -> translateDialog()));

        if (state.optBoolean("gallery")) {
            chips.addView(chip("Фоны", false, v -> tavern.evaluateJavascript("window.korrektorGallery&&window.korrektorGallery.backgrounds()", null)));
            chips.addView(chip("Аватар", false, v -> tavern.evaluateJavascript("window.korrektorGallery&&window.korrektorGallery.avatar()", null)));
        }

        if (!activity.prefs.flag(Prefs.SHOW_MODEL_BAR, true)) return;
        if (!"openai".equals(state.optString("api"))) {
            chips.addView(chip("Модель — в настройках таверны (Text Completion)", true, null));
            return;
        }
        String model = state.optString("model");
        chips.addView(chip("Модель: " + (model.isEmpty() ? "не выбрана" : model), false, v -> pickModel()));
        JSONArray presets = state.optJSONArray("presets");
        if (presets != null && presets.length() > 0) {
            chips.addView(chip("Пресет: " + state.optString("preset"), false, v -> pickPreset()));
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
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), dp(4));

        Switch replies = new Switch(activity);
        replies.setText("Переводить новые ответы");
        replies.setChecked("responses".equals(mode) || "both".equals(mode));
        Switch mine = new Switch(activity);
        mine.setText("Мои сообщения — на английский перед отправкой");
        mine.setChecked("inputs".equals(mode) || "both".equals(mode));
        box.addView(replies, row());
        box.addView(mine, row());

        final String[] lang = {tr.optString("lang")};
        final String[] langName = {tr.optString("langName")};
        // Most people here read Russian: offer it instead of SillyTavern's default English.
        if ("en".equals(lang[0]) && !replies.isChecked()) {
            lang[0] = "ru";
            langName[0] = nameOf(tr, "ru", "Russian");
        }
        TextView language = text("Язык перевода: " + langName[0], true);
        language.setOnClickListener(v -> {
            JSONArray list = tr.optJSONArray("languages");
            List<String> names = new ArrayList<>();
            List<String> codes = new ArrayList<>();
            for (int i = 0; list != null && i < list.length(); i++) {
                JSONArray pair = list.optJSONArray(i);
                if (pair == null) continue;
                codes.add(pair.optString(0));
                names.add(pair.optString(1));
            }
            pick("Язык перевода", names, langName[0], picked -> {
                int at = names.indexOf(picked);
                if (at < 0) return;
                lang[0] = codes.get(at);
                langName[0] = picked;
                language.setText("Язык перевода: " + picked);
            });
        });
        box.addView(language, row());
        TextView note = text("Новые ответы переводит " + providerName(tr.optString("provider")) + " через саму таверну: перевод показывается вместо текста, а модель по-прежнему видит оригинал."
                + (ours ? " Уже написанные сообщения — кнопка «Старые сообщения»: по одному, с повтором при ошибке, можно моделью Корректора" : ""), false);
        note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        box.addView(note, row());

        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("Перевод чата")
                .setView(box)
                .setPositiveButton("Готово", (d, w) -> {
                    String next = replies.isChecked() && mine.isChecked() ? "both" : replies.isChecked() ? "responses" : mine.isChecked() ? "inputs" : "none";
                    run("(function(m,l){var $=window.jQuery;$('#translation_target_language').val(l).trigger('change');"
                            + "$('#translation_auto_mode').val(m).trigger('change');})(" + JSONObject.quote(next) + "," + JSONObject.quote(lang[0]) + ")");
                })
                .setNeutralButton(ours ? "Старые сообщения" : "Ещё", (d, w) -> {
                    if (ours) run("window.korrektorTranslate.open({lang:" + JSONObject.quote(lang[0]) + "})");
                    else moreDialog(lang[0]);
                })
                .setNegativeButton("Отмена", null)
                .create();
        dialog.show();
    }

    private void moreDialog(String lang) {
        new AlertDialog.Builder(activity)
                .setTitle("Перевод чата")
                .setItems(new String[]{"Перевести весь этот чат сейчас", "Показать оригинал (убрать переводы)"}, (d, which) -> {
                    if (which == 0) {
                        run("(function(l){var $=window.jQuery;$('#translation_target_language').val(l).trigger('change');$('#translate_chat').trigger('click');})(" + JSONObject.quote(lang) + ")");
                        activity.toast("Перевожу чат: длинный чат займёт время");
                    } else {
                        run("window.jQuery('#translation_clear').trigger('click')");
                    }
                })
                .show();
    }

    private static String nameOf(JSONObject tr, String code, String fallback) {
        JSONArray list = tr.optJSONArray("languages");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONArray pair = list.optJSONArray(i);
            if (pair != null && code.equals(pair.optString(0))) return pair.optString(1);
        }
        return fallback;
    }

    private static String providerName(String provider) {
        switch (provider == null ? "" : provider) {
            case "google": return "Google (бесплатно, без ключа)";
            case "deepl": return "DeepL";
            case "yandex": return "Яндекс";
            case "bing": return "Bing";
            case "libre": return "LibreTranslate";
            case "lingva": return "Lingva";
            default: return provider == null || provider.isEmpty() ? "переводчик таверны" : provider;
        }
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
        pick("Модель", items, state.optString("model"), value -> run(
                "(function(v){var $=window.jQuery;var id=" + JSONObject.quote(state.optString("select")) + ";"
                        + "if(id){$('#'+id).val(v).trigger('change');}"
                        + "if(" + JSONObject.quote(state.optString("source")) + "==='custom'){$('#custom_model_id').val(v).trigger('input');}"
                        + "})(" + JSONObject.quote(value) + ")"));
    }

    private void pickPreset() {
        JSONArray list = state.optJSONArray("presets");
        List<String> items = new ArrayList<>();
        for (int i = 0; list != null && i < list.length(); i++) items.add(list.optString(i));
        pick("Пресет", items, state.optString("preset"), value -> run(
                "(function(name){var ps=document.getElementById('settings_preset_openai');if(!ps)return;"
                        + "var o=[].find.call(ps.options,function(x){return x.textContent===name;});"
                        + "if(o)window.jQuery(ps).val(o.value).trigger('change');})(" + JSONObject.quote(value) + ")"));
    }

    private void run(String js) {
        tavern.evaluateJavascript(js, ignored -> activity.runOnUiThread(() -> tavern.postDelayed(this::refresh, 700)));
    }

    interface Picked {
        void on(String value);
    }

    /** A list with a search field: OpenRouter alone offers hundreds of models. */
    private void pick(String title, List<String> items, String current, Picked onPick) {
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), dp(8), dp(16), 0);
        EditText search = new EditText(activity);
        search.setHint("Поиск");
        search.setSingleLine(true);
        ListView listView = new ListView(activity);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(activity, android.R.layout.simple_list_item_single_choice, new ArrayList<>(items));
        listView.setAdapter(adapter);
        listView.setChoiceMode(ListView.CHOICE_MODE_SINGLE);
        int index = items.indexOf(current);
        if (index >= 0) {
            listView.setItemChecked(index, true);
            listView.setSelection(Math.max(0, index - 2));
        }
        box.addView(search);
        box.addView(listView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(360)));
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle(title).setView(box).setNegativeButton("Отмена", null).create();
        listView.setOnItemClickListener((parent, view, position, id) -> {
            onPick.on(adapter.getItem(position));
            dialog.dismiss();
        });
        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                String q = s.toString().toLowerCase();
                adapter.clear();
                for (String item : items) if (item.toLowerCase().contains(q)) adapter.add(item);
                listView.clearChoices();
                for (int i = 0; i < adapter.getCount(); i++) if (adapter.getItem(i).equals(current)) listView.setItemChecked(i, true);
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        });
        dialog.show();
    }

    // ---------- views ----------

    private LinearLayout.LayoutParams row() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(10);
        return lp;
    }

    private TextView text(String value, boolean link) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, link ? 15 : 13);
        if (link) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        view.setPadding(0, dp(4), 0, dp(4));
        return view;
    }

    private TextView chip(String text, boolean quiet, View.OnClickListener click) {
        TextView chip = new TextView(activity);
        chip.setText(text);
        chip.setSingleLine(true);
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        chip.setTextColor(quiet ? palette.muted : palette.text);
        chip.setPadding(dp(12), dp(6), dp(12), dp(6));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(14));
        bg.setColor(quiet ? palette.bg : palette.raised);
        bg.setStroke(1, palette.line);
        chip.setBackground(bg);
        if (click != null) chip.setOnClickListener(click);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMarginEnd(dp(8));
        chip.setLayoutParams(lp);
        return chip;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, activity.getResources().getDisplayMetrics()));
    }
}
