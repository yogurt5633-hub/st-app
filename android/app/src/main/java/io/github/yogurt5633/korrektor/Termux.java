package io.github.yogurt5633.korrektor;

import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * Runs fixed commands in Termux through its RUN_COMMAND service.
 * Needs "allow-external-apps = true" in ~/.termux/termux.properties and the
 * com.termux.permission.RUN_COMMAND permission granted to this app.
 * Only the commands below can be run. The one free-form value, the user's own
 * start command, is passed as an argument ($1), never pasted into the script.
 * Termux sends the outcome back to {@link TermuxResult}.
 */
final class Termux {
    static final String PACKAGE = "com.termux";
    static final String PERMISSION = "com.termux.permission.RUN_COMMAND";
    static final String SETUP = "mkdir -p ~/.termux && echo 'allow-external-apps = true' >> ~/.termux/termux.properties && termux-reload-settings";

    private static final String BASH = "/data/data/com.termux/files/usr/bin/bash";
    private static final String HOME = "/data/data/com.termux/files/home";
    private static final String REPO = "https://github.com/yogurt5633-hub/st-app";

    // Session actions of RUN_COMMAND: open Termux on the new session, or create it without opening Termux.
    private static final String SHOW_SESSION = "0";
    private static final String HIDDEN_SESSION = "2";

    private static final String VARS = "SRC=\"$HOME/korrektor-src\"; LOG=\"$HOME/.korrektor-ctl.log\"; export KORREKTOR_START_CMD=\"$1\"; ";
    // Make sure ~/korrektor-src exists (clone on first use).
    private static final String BOOT = VARS
            + "if [ ! -d \"$SRC/.git\" ]; then command -v git >/dev/null || { echo 'В Termux нет git: нажмите «Установить SillyTavern» или выполните pkg install git'; exit 1; }; "
            + "git clone -q " + REPO + " \"$SRC\" 2>&1 | tee -a \"$LOG\"; fi; ";
    // ~/korrektor-src is the app's own copy of the code: it always follows main exactly.
    private static final String PULL = "{ git -C \"$SRC\" fetch -q origin main && git -C \"$SRC\" reset -q --hard origin/main; } 2>&1 | tee -a \"$LOG\"; ";
    private static final String ENSURE = "grep -q 'cd_only_dir' \"$SRC/scripts/korrektor-ctl.sh\" 2>/dev/null || " + PULL;
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

    /** Actions that keep SillyTavern running in a Termux session until it stops. */
    static boolean runsTavern(String action) {
        switch (action) {
            case "start":
            case "start-update":
            case "restart":
            case "update-korrektor":
            case "update-tavern":
            case "install-tavern":
                return true;
            default:
                return false;
        }
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
            case "install-tavern":
                return VARS
                        + "echo '== Корректор: установка SillyTavern'; "
                        + "command -v git >/dev/null || { apt-get update && apt-get -y install git; } || { echo 'Не удалось поставить git'; exit 1; }; "
                        + "[ -d \"$SRC/.git\" ] || git clone -q " + REPO + " \"$SRC\" || exit 1; "
                        + PULL
                        + "exec bash \"$SRC/scripts/install-st.sh\"";
            case "status":
                // Quick check that Termux accepts commands, and what is there.
                return VARS + "echo termux=1; command -v git >/dev/null && echo git=1; "
                        + "[ -d \"$SRC/.git\" ] && echo src=1; "
                        + "[ -f \"$SRC/scripts/korrektor-ctl.sh\" ] && bash \"$SRC/scripts/korrektor-ctl.sh\" status; exit 0";
            case "progress":
                return "S=\"$HOME/.korrektor-st.log\"; [ -f \"$S\" ] && tail -n 30 \"$S\" | sed 's/\\x1b\\[[0-9;]*[A-Za-z]//g' | grep -v '^[[:space:]]*$' | tail -n 1; exit 0";
            case "logs":
                return "L=\"$HOME/.korrektor-ctl.log\"; S=\"$HOME/.korrektor-st.log\"; "
                        + "[ -f \"$L\" ] || [ -f \"$S\" ] || { echo 'Журналов пока нет: из приложения SillyTavern ещё не запускался'; exit 0; }; "
                        + "echo '— Корректор (~/.korrektor-ctl.log)'; tail -n 25 \"$L\" 2>/dev/null; echo; "
                        + "echo '— SillyTavern (~/.korrektor-st.log)'; tail -n 60 \"$S\" 2>/dev/null | sed 's/\\x1b\\[[0-9;]*[A-Za-z]//g'";
            default:
                return null;
        }
    }

    /**
     * @param startCommand the user's own start command, or empty for automatic
     * @param run          number of this run: comes back with the result
     * @return null on success, otherwise a reason to show the user
     */
    static String run(Context context, String action, String startCommand, int run) {
        if (!installed(context)) return "Termux не установлен";
        if (!permitted(context)) return "Нет разрешения запускать команды в Termux";
        String script = scriptFor(action);
        if (script == null) return "Неизвестное действие";
        boolean session = runsTavern(action);

        Intent intent = new Intent();
        intent.setClassName(PACKAGE, "com.termux.app.RunCommandService");
        intent.setAction("com.termux.RUN_COMMAND");
        intent.putExtra("com.termux.RUN_COMMAND_PATH", BASH);
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c", script, "korrektor", startCommand == null ? "" : startCommand});
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME);
        // SillyTavern runs in a Termux session: its output is visible there, like when started by hand.
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", !session);
        intent.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "install-tavern".equals(action) ? SHOW_SESSION : HIDDEN_SESSION);
        intent.putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", session ? "SillyTavern (Корректор)" : "Корректор: " + action);

        Intent reply = new Intent(context, TermuxResult.class);
        reply.putExtra(TermuxResult.ACTION, action);
        reply.putExtra(TermuxResult.RUN, run);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE; // Termux adds the result to it
        intent.putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", PendingIntent.getBroadcast(context, run, reply, flags));

        try {
            ComponentName started = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? context.startForegroundService(intent)
                    : context.startService(intent);
            if (started == null) return "Этот Termux не принимает команды от приложений. Нужен Termux из F-Droid или GitHub";
            return null;
        } catch (SecurityException e) {
            return "Termux не дал запустить команду: " + e.getMessage();
        } catch (Exception e) {
            return "Termux не принял команду: " + e.getMessage();
        }
    }
}
