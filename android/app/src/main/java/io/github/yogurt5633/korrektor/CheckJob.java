package io.github.yogurt5633.korrektor;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import org.json.JSONObject;

/**
 * Runs about once an hour in the background:
 *  - if SillyTavern is up, tells about new cards in Korrektor's feed;
 *  - once a day, checks for new versions of the app and of Korrektor.
 */
public class CheckJob extends JobService {
    private static final int JOB_ID = 1;
    private static final long DAY = 24L * 60 * 60 * 1000;

    static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        for (JobInfo job : scheduler.getAllPendingJobs()) {
            if (job.getId() == JOB_ID) return;
        }
        JobInfo info = new JobInfo.Builder(JOB_ID, new ComponentName(context, CheckJob.class))
                .setPeriodic(60L * 60 * 1000)
                .setPersisted(true)
                .build();
        scheduler.schedule(info);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                work(getApplicationContext());
            } finally {
                jobFinished(params, false);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }

    static void work(Context context) {
        Prefs prefs = new Prefs(context);
        if (!prefs.flag(Prefs.NOTIFY, true)) return;

        Net.Reply status = Net.get(prefs.stUrl() + "/api/plugins/korrektor/status", 8000, true);
        if (status.ok()) {
            try {
                int open = new JSONObject(status.body).optInt("open", 0);
                long seen = prefs.number("notifiedOpen");
                if (open > seen) {
                    int fresh = (int) (open - seen);
                    Notifier.show(context, 10, "Корректор", "Новых замечаний: " + fresh + ". Откройте, чтобы посмотреть", "korrektor");
                }
                prefs.setNumber("notifiedOpen", open);
            } catch (Exception ignored) {
                // a reply we do not understand: skip this round
            }
        }

        if (System.currentTimeMillis() - prefs.number("lastCheck") > DAY) {
            JSONObject found = Updater.check(context, prefs);
            boolean app = found.optJSONObject("app") != null && found.optJSONObject("app").optBoolean("available");
            boolean korrektor = found.optJSONObject("korrektor") != null && found.optJSONObject("korrektor").optBoolean("available");
            if (app || korrektor) {
                String what = app && korrektor ? "приложения и Корректора" : app ? "приложения" : "Корректора";
                Notifier.show(context, 11, "Есть обновление", "Новая версия " + what + ". Обновить можно на вкладке «Ещё»", "home");
            }
        }
    }
}
