package io.github.yogurt5633.korrektor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * Termux reports here how a command ended: its output, exit code, or why it did
 * not run (for example "allow-external-apps" is off). Not exported: only the
 * PendingIntent this app hands to Termux can reach it.
 */
public class TermuxResult extends BroadcastReceiver {
    static final String ACTION = "korrektorAction";
    static final String RUN = "korrektorRun";

    /** Termux's code for "no error". */
    static final int NO_ERROR = -1;

    static final class Outcome {
        String action = "";
        int run;
        String stdout = "";
        String stderr = "";
        Integer exitCode;
        int err = NO_ERROR;
        String errmsg = "";

        boolean failedToRun() {
            return err != NO_ERROR;
        }

        String output() {
            String text = stdout.trim();
            if (!stderr.trim().isEmpty()) text = text.isEmpty() ? stderr.trim() : text + "\n" + stderr.trim();
            return text;
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        Outcome o = new Outcome();
        o.action = String.valueOf(intent.getStringExtra(ACTION));
        o.run = intent.getIntExtra(RUN, 0);
        Bundle result = intent.getBundleExtra("result");
        if (result != null) {
            o.stdout = text(result, "stdout");
            o.stderr = text(result, "stderr");
            if (result.containsKey("exitCode")) o.exitCode = result.getInt("exitCode");
            o.err = result.getInt("err", NO_ERROR);
            o.errmsg = text(result, "errmsg");
        }
        MainActivity activity = MainActivity.running;
        if (activity != null) activity.onTermuxResult(o);
    }

    private static String text(Bundle bundle, String key) {
        String value = bundle.getString(key);
        return value == null ? "" : value;
    }
}
