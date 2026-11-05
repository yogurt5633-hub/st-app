package io.github.yogurt5633.korrektor;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * Home screen widget: is the tavern running, how many findings wait, and one
 * button — "Открыть" when it runs, "Запустить" when it does not.
 */
public class KorrektorWidget extends AppWidgetProvider {
    static final String ACTION_START = "io.github.yogurt5633.korrektor.WIDGET_START";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        refresh(context);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (!ACTION_START.equals(intent.getAction())) return;
        Prefs prefs = new Prefs(context);
        if (!Termux.installed(context) || !Termux.permitted(context)) {
            // The button shows "Настроить" then; this is only a stale widget.
            refresh(context);
            return;
        }
        int run = prefs.nextRun();
        prefs.setNumber("tavernRun", run);
        String error = Termux.run(context, prefs.startAction(), prefs.text(Prefs.START_CMD), run);
        show(context, error == null ? "Запускаю таверну…" : error, false);
        // Look again in a minute, when the tavern has had time to start.
        CheckJob.scheduleWidgetRefresh(context);
    }

    private static Intent openApp(Context context, String tab) {
        Intent open = new Intent(context, MainActivity.class);
        open.putExtra("tab", tab);
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return open;
    }

    /** Checks the tavern in the background and redraws every widget. */
    static void refresh(Context context) {
        Context app = context.getApplicationContext();
        new Thread(() -> {
            Prefs prefs = new Prefs(app);
            boolean up = Net.alive(prefs.stUrl());
            String text;
            if (up) {
                int open = -1;
                Net.Reply status = Net.get(prefs.stUrl() + "/api/plugins/korrektor/status", 6000, true);
                if (status.ok()) {
                    try {
                        open = new JSONObject(status.body).optInt("open", -1);
                    } catch (Exception ignored) {
                        // keep unknown
                    }
                }
                text = open > 0 ? "Таверна работает · замечаний: " + open : open == 0 ? "Таверна работает · замечаний нет" : "Таверна работает";
            } else {
                text = "Таверна выключена";
            }
            show(app, text, up);
        }).start();
    }

    static void show(Context context, String text, boolean up) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, KorrektorWidget.class));
        if (ids == null || ids.length == 0) return;
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget);
        views.setTextViewText(R.id.widget_status, text);
        boolean canStart = Termux.installed(context) && Termux.permitted(context);
        views.setTextViewText(R.id.widget_button, up ? "Открыть" : canStart ? "Запустить" : "Настроить");
        PendingIntent openIntent = PendingIntent.getActivity(context, 20, openApp(context, MainActivity.TAVERN),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, openIntent);
        if (up) {
            views.setOnClickPendingIntent(R.id.widget_button, openIntent);
        } else if (!canStart) {
            views.setOnClickPendingIntent(R.id.widget_button, PendingIntent.getActivity(context, 22, openApp(context, MainActivity.HOME),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        } else {
            Intent start = new Intent(context, KorrektorWidget.class).setAction(ACTION_START);
            views.setOnClickPendingIntent(R.id.widget_button, PendingIntent.getBroadcast(context, 21, start,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        manager.updateAppWidget(ids, views);
    }
}
