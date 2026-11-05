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
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * A thin row above the tavern: the model and the preset of SillyTavern's
 * current Chat Completion connection, changed with one tap. It works through
 * SillyTavern's own fields on the page (the same as choosing them in its menu),
 * so SillyTavern saves the choice itself.
 */
final class ModelBar {
    // Reads what is selected now. Model fields differ per source; the common
    // pattern is #model_<source>_select.
    private static final String READ = "(function(){try{"
            + "var $=window.jQuery;if(!$||!window.SillyTavern)return JSON.stringify({ok:false});"
            + "var api=$('#main_api').val();if(api!=='openai')return JSON.stringify({ok:true,api:api});"
            + "var source=$('#chat_completion_source').val();"
            + "var map={makersuite:'model_google_select',vertexai:'model_vertexai_select',custom:'model_custom_select'};"
            + "var id=map[source]||('model_'+source+'_select');var sel=document.getElementById(id);"
            + "var model='',models=[];if(sel){model=sel.value||'';models=[].map.call(sel.options,function(o){return o.value;}).filter(Boolean);}"
            + "if(source==='custom'){var inp=document.getElementById('custom_model_id');if(inp&&inp.value)model=inp.value;}"
            + "var ps=document.getElementById('settings_preset_openai');"
            + "var presets=ps?[].map.call(ps.options,function(o){return o.textContent;}):[];"
            + "var preset=ps&&ps.selectedOptions[0]?ps.selectedOptions[0].textContent:'';"
            + "return JSON.stringify({ok:true,api:api,source:source,select:sel?id:'',model:model,models:models.slice(0,1500),preset:preset,presets:presets});"
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
        root.setVisibility(View.GONE);
    }

    View view() {
        return root;
    }

    void setPalette(Palette palette) {
        this.palette = palette;
        draw();
    }

    /** Asks the tavern page what is selected; hides the row when it does not apply. */
    void refresh() {
        if (!activity.prefs.flag(Prefs.SHOW_MODEL_BAR, true)) {
            root.setVisibility(View.GONE);
            return;
        }
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
        boolean show = state != null && state.optBoolean("ok") && activity.prefs.flag(Prefs.SHOW_MODEL_BAR, true);
        root.setVisibility(show ? View.VISIBLE : View.GONE);
        if (!show) return;
        if (!"openai".equals(state.optString("api"))) {
            chips.addView(chip("Модель меняется в настройках таверны (Text Completion)", true, null));
            return;
        }
        String model = state.optString("model");
        chips.addView(chip("Модель: " + (model.isEmpty() ? "не выбрана" : model), false, v -> pickModel()));
        if (state.optJSONArray("presets") != null && state.optJSONArray("presets").length() > 0) {
            chips.addView(chip("Пресет: " + state.optString("preset"), false, v -> pickPreset()));
        }
    }

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
                int at = -1;
                for (int i = 0; i < adapter.getCount(); i++) if (adapter.getItem(i).equals(current)) at = i;
                if (at >= 0) listView.setItemChecked(at, true);
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        });
        dialog.show();
    }

    private TextView chip(String text, boolean quiet, View.OnClickListener click) {
        TextView chip = new TextView(activity);
        chip.setText(text);
        chip.setSingleLine(true);
        chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        chip.setTypeface(Typeface.DEFAULT, Typeface.NORMAL);
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
