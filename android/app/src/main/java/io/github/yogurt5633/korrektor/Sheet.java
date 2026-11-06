package io.github.yogurt5633.korrektor;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * A sheet that slides up from the bottom, in the app's colours: the same look for everything
 * opened from the row above the tavern (translation, model, preset, language).
 */
final class Sheet {
    interface Toggle {
        void on(boolean value);
    }

    interface Picked {
        void on(String value);
    }

    private final Activity activity;
    private final Palette palette;
    private final Dialog dialog;
    private final LinearLayout box;
    final LinearLayout body;

    Sheet(Activity activity, Palette palette, String title) {
        this.activity = activity;
        this.palette = palette;
        dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

        box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(10), dp(20), dp(20));
        GradientDrawable bg = new GradientDrawable();
        float r = dp(22);
        bg.setCornerRadii(new float[]{r, r, r, r, 0, 0, 0, 0});
        bg.setColor(palette.card);
        box.setBackground(bg);

        // The handle at the top, as on other sheets in Android.
        View handle = new View(activity);
        GradientDrawable hb = new GradientDrawable();
        hb.setCornerRadius(dp(2));
        hb.setColor(palette.line);
        handle.setBackground(hb);
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(dp(36), dp(4));
        hp.gravity = Gravity.CENTER_HORIZONTAL;
        hp.bottomMargin = dp(12);
        box.addView(handle, hp);

        TextView head = new TextView(activity);
        head.setText(title);
        head.setTextColor(palette.text);
        head.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        head.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        head.setPadding(0, 0, 0, dp(8));
        box.addView(head);

        body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(body);
        box.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        dialog.setContentView(box);

        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.setGravity(Gravity.BOTTOM);
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            window.setWindowAnimations(android.R.style.Animation_InputMethod);
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }
    }

    /** At most this share of the screen height, so the list scrolls inside. */
    private void limitHeight(float share) {
        int max = Math.round(activity.getResources().getDisplayMetrics().heightPixels * share);
        box.measure(View.MeasureSpec.makeMeasureSpec(activity.getResources().getDisplayMetrics().widthPixels, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        if (box.getMeasuredHeight() > max && dialog.getWindow() != null) {
            dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, max);
        }
    }

    void show() {
        limitHeight(0.82f);
        dialog.show();
    }

    void dismiss() {
        dialog.dismiss();
    }

    // ---------- rows ----------

    private LinearLayout rowBox() {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(14));
        bg.setColor(palette.raised);
        row.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        row.setLayoutParams(lp);
        return row;
    }

    private LinearLayout texts(String title, String hint) {
        LinearLayout col = new LinearLayout(activity);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView t = new TextView(activity);
        t.setText(title);
        t.setTextColor(palette.text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        col.addView(t);
        if (hint != null && !hint.isEmpty()) {
            TextView h = new TextView(activity);
            h.setText(hint);
            h.setTextColor(palette.muted);
            h.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            h.setPadding(0, dp(2), 0, 0);
            col.addView(h);
        }
        return col;
    }

    /** A row with a switch in the accent colour. */
    Switch toggle(String title, String hint, boolean on, Toggle change) {
        LinearLayout row = rowBox();
        row.addView(texts(title, hint), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Switch sw = new Switch(activity);
        sw.setChecked(on);
        int[][] states = {{android.R.attr.state_checked}, {}};
        sw.setThumbTintList(new ColorStateList(states, new int[]{palette.accent, palette.muted}));
        sw.setTrackTintList(new ColorStateList(states, new int[]{(palette.accent & 0x00ffffff) | 0x66000000, palette.line}));
        sw.setOnCheckedChangeListener((b, value) -> change.on(value));
        row.setOnClickListener(v -> sw.toggle());
        row.addView(sw);
        body.addView(row);
        return sw;
    }

    /** A row that shows a value and opens a choice; returns the value view to update it. */
    TextView choice(String title, String value, View.OnClickListener click) {
        LinearLayout row = rowBox();
        row.addView(texts(title, null), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView v = new TextView(activity);
        v.setText(value);
        v.setTextColor(palette.accent);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        v.setSingleLine(true);
        v.setEllipsize(TextUtils.TruncateAt.END);
        v.setMaxWidth(dp(190));
        v.setPadding(dp(8), 0, dp(6), 0);
        row.addView(v);
        TextView chevron = new TextView(activity);
        chevron.setText("›");
        chevron.setTextColor(palette.muted);
        chevron.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        row.addView(chevron);
        row.setOnClickListener(click);
        body.addView(row);
        return v;
    }

    void note(String text) {
        TextView t = new TextView(activity);
        t.setText(text);
        t.setTextColor(palette.muted);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        t.setPadding(dp(4), dp(12), dp(4), 0);
        body.addView(t);
    }

    /** Buttons at the bottom: the main one filled with the accent, the other quiet. */
    void buttons(String main, Runnable onMain, String other, Runnable onOther) {
        LinearLayout row = new LinearLayout(activity);
        row.setGravity(Gravity.CENTER);
        row.setPadding(0, dp(16), 0, 0);
        if (other != null) row.addView(button(other, false, onOther), new LinearLayout.LayoutParams(0, dp(46), 1f));
        if (other != null) {
            View gap = new View(activity);
            row.addView(gap, new LinearLayout.LayoutParams(dp(10), 1));
        }
        row.addView(button(main, true, onMain), new LinearLayout.LayoutParams(0, dp(46), 1f));
        box.addView(row);
    }

    private TextView button(String text, boolean main, Runnable click) {
        TextView b = new TextView(activity);
        b.setText(text);
        b.setGravity(Gravity.CENTER);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setTextColor(main ? palette.onPrimary : palette.text);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(14));
        bg.setColor(main ? palette.accent : palette.raised);
        b.setBackground(bg);
        b.setOnClickListener(v -> {
            dismiss();
            if (click != null) click.run();
        });
        return b;
    }

    // ---------- a list to choose from ----------

    /** A list with search (OpenRouter alone offers hundreds of models); the current one is marked. */
    static void pick(Activity activity, Palette palette, String title, List<String> items, String current, Picked onPick) {
        Sheet sheet = new Sheet(activity, palette, title);
        List<String> shown = new ArrayList<>(items);
        ListView list = new ListView(activity);
        list.setDivider(null);
        list.setSelector(new ColorDrawable(Color.TRANSPARENT));
        BaseAdapter adapter = new BaseAdapter() {
            @Override
            public int getCount() {
                return shown.size();
            }

            @Override
            public Object getItem(int position) {
                return shown.get(position);
            }

            @Override
            public long getItemId(int position) {
                return position;
            }

            @Override
            public View getView(int position, View convert, ViewGroup parent) {
                TextView row = convert instanceof TextView ? (TextView) convert : new TextView(activity);
                String item = shown.get(position);
                boolean on = item.equals(current);
                row.setText(on ? "✓  " + item : item);
                row.setTextColor(on ? palette.accent : palette.text);
                row.setTypeface(Typeface.DEFAULT, on ? Typeface.BOLD : Typeface.NORMAL);
                row.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
                row.setPadding(sheet.dp(14), sheet.dp(13), sheet.dp(14), sheet.dp(13));
                GradientDrawable bg = new GradientDrawable();
                bg.setCornerRadius(sheet.dp(12));
                bg.setColor(on ? ((palette.accent & 0x00ffffff) | 0x22000000) : Color.TRANSPARENT);
                row.setBackground(bg);
                return row;
            }
        };
        list.setAdapter(adapter);
        list.setOnItemClickListener((parent, view, position, id) -> {
            sheet.dismiss();
            onPick.on(shown.get(position));
        });
        if (items.size() > 10) {
            EditText search = new EditText(activity);
            search.setHint("Поиск");
            search.setSingleLine(true);
            search.setTextColor(palette.text);
            search.setHintTextColor(palette.muted);
            search.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            search.setPadding(sheet.dp(14), sheet.dp(10), sheet.dp(14), sheet.dp(10));
            GradientDrawable sb = new GradientDrawable();
            sb.setCornerRadius(sheet.dp(12));
            sb.setColor(palette.deep);
            sb.setStroke(1, palette.line);
            search.setBackground(sb);
            search.addTextChangedListener(new TextWatcher() {
                @Override
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {
                }

                @Override
                public void onTextChanged(CharSequence s, int start, int before, int count) {
                    String q = s.toString().toLowerCase();
                    shown.clear();
                    for (String item : items) if (item.toLowerCase().contains(q)) shown.add(item);
                    adapter.notifyDataSetChanged();
                }

                @Override
                public void afterTextChanged(Editable s) {
                }
            });
            LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            sp.bottomMargin = sheet.dp(8);
            sheet.box.addView(search, sheet.box.getChildCount() - 1, sp);
        }
        // The list scrolls on its own: it replaces the scrolling body.
        sheet.box.removeViewAt(sheet.box.getChildCount() - 1);
        sheet.box.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.min(sheet.dp(56) * Math.max(3, items.size()) + sheet.dp(8),
                Math.round(activity.getResources().getDisplayMetrics().heightPixels * 0.6f))));
        int index = items.indexOf(current);
        if (index > 2) list.setSelection(index - 2);
        sheet.show();
    }

    int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, activity.getResources().getDisplayMetrics()));
    }
}
