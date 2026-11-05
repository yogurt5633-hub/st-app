package io.github.yogurt5633.korrektor;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * Runs fixed commands in Termux through its RUN_COMMAND service.
 * Needs "allow-external-apps = true" in ~/.termux/termux.properties and the
 * com.termux.permission.RUN_COMMAND permission granted to this app.
 * Only the commands below can be run: pages inside the app cannot pass their own.
 */
final class Termux {
    static final String PACKAGE = "com.termux";
    static final String PERMISSION = "com.termux.permission.RUN_COMMAND";
    static final String SETUP = "mkdir -p ~/.termux && echo 'allow-external-apps = true' >> ~/.termux/termux.properties && termux-reload-settings";

    private static final String BASH = "/data/data/com.termux/files/usr/bin/bash";
    private static final String HOME = "/data/data/com.termux/files/home";
    private static final String REPO = "https://github.com/yogurt5633-hub/st-app";

    // Make sure ~/korrektor-src exists (clone on first use).
    private static final String BOOT =
            "SRC=\"$HOME/korrektor-src\"; LOG=\"$HOME/.korrektor-ctl.log\"; "
            + "[ -d \"$SRC/.git\" ] || git clone -q " + REPO + " \"$SRC\" >> \"$LOG\" 2>&1; ";
    private static final String PULL = "git -C \"$SRC\" pull -q --ff-only >> \"$LOG\" 2>&1; ";
    private static final String ENSURE = "[ -f \"$SRC/scripts/korrektor-ctl.sh\" ] || git -C \"$SRC\" pull -q --ff-only >> \"$LOG\" 2>&1; ";
    private static final String CTL = "exec bash \"$SRC/scripts/korrektor-ctl.sh\" ";

    private Termux() {
    }

    static boolean installed(Context context) {
        try {
            context.getPackageManager().getPackageInfo(PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    static boolean permitted(Context context) {
        return context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Script for an action name coming from the app's own control page. */
    static String scriptFor(String action) {
        switch (action) {
            case "start":
                return BOOT + ENSURE + CTL + "start";
            case "start-update":
                return BOOT + PULL + CTL + "start --install";
            case "stop":
                return BOOT + ENSURE + CTL + "stop";
            case "restart":
                return BOOT + ENSURE + CTL + "restart";
            case "update-korrektor":
                return BOOT + PULL + CTL + "update-korrektor";
            case "update-tavern":
                return BOOT + ENSURE + CTL + "update-tavern";
            default:
                return null;
        }
    }

    /** @return null on success, otherwise a reason to show the user */
    static String run(Context context, String action) {
        if (!installed(context)) return "Termux не установлен";
        if (!permitted(context)) return "Нет разрешения запускать команды в Termux";
        String script = scriptFor(action);
        if (script == null) return "Неизвестное действие";
        Intent intent = new Intent();
        intent.setClassName(PACKAGE, "com.termux.app.RunCommandService");
        intent.setAction("com.termux.RUN_COMMAND");
        intent.putExtra("com.termux.RUN_COMMAND_PATH", BASH);
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c", script});
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME);
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        intent.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            return null;
        } catch (Exception e) {
            return "Termux не принял команду: " + e.getMessage();
        }
    }
}
