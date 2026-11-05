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

    // Session action of RUN_COMMAND: open Termux on the new session (only for the installer).
    private static final String SHOW_SESSION = "0";

    private static final String VARS = "SRC=\"$HOME/korrektor-src\"; LOG=\"$HOME/.korrektor-ctl.log\"; export KORREKTOR_START_CMD=\"$1\"; ";
    // Make sure ~/korrektor-src exists (clone on first use).
    private static final String BOOT = VARS
            + "if [ ! -d \"$SRC/.git\" ]; then command -v git >/dev/null || { echo 'В Termux нет git: нажмите «Установить SillyTavern» или выполните pkg install git'; exit 1; }; "
            + "git clone -q " + REPO + " \"$SRC\" 2>&1 | tee -a \"$LOG\"; fi; ";
    // ~/korrektor-src is the app's own copy of the code: it always follows main exactly.
    // A slow or blocked GitHub must not hang the start: 90 seconds at most, and the reason is shown.
    private static final String PULL = "T=; command -v timeout >/dev/null && T='timeout 90'; "
            + "{ $T git -C \"$SRC\" fetch -q --depth 1 origin main && git -C \"$SRC\" reset -q --hard origin/main "
            + "|| echo 'Не удалось скачать обновление с GitHub (нет интернета или GitHub недоступен): ставлю то, что уже скачано'; } 2>&1 | tee -a \"$LOG\"; ";
    private static final String ENSURE = "grep -q 'korrektor-ctl.seen' \"$SRC/scripts/korrektor-ctl.sh\" 2>/dev/null || " + PULL;
    // The very first thing a command does: the app sees that Termux really started it.
    private static final String SEEN = "date +%s > \"$HOME/.korrektor-ctl.seen\"; ";
    private static final String CTL = "exec bash \"$SRC/scripts/korrektor-ctl.sh\" ";
    // For the journal and the progress line: no colour codes, only this start's output
    // (after the ctl marker), and without the long model lists SillyTavern prints.
    private static final String STRIP = "sed 's/\\x1b\\[[0-9;]*[A-Za-z]//g; s/\\r//g'";
    private static final String SINCE_START = "awk '/^== Корректор: запуск/{b=\"\";next}{b=b $0 \"\\n\"}END{printf \"%s\",b}'";
    private static final String NOISE = "grep -vE \"^[[:space:]]*\\$|^[[:space:]]*['\\\"]|^[[:space:]]*[][{}][,;]?[[:space:]]*\\$\"";

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
                return SEEN + BOOT + ENSURE + CTL + "start";
            case "start-update":
                return SEEN + BOOT + PULL + CTL + "start --install";
            case "stop":
                return SEEN + BOOT + ENSURE + CTL + "stop";
            case "restart":
                return SEEN + BOOT + ENSURE + CTL + "restart";
            case "update-korrektor":
                return SEEN + BOOT + PULL + CTL + "update-korrektor";
            case "update-tavern":
                return SEEN + BOOT + ENSURE + CTL + "update-tavern";
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
                // First line: when ctl last started (the app sees whether Termux ran the command at all).
                // Then the latest meaningful line of this start: SillyTavern's output, or Korrektor's own step.
                return "S=\"$HOME/.korrektor-st.log\"; L=\"$HOME/.korrektor-ctl.log\"; "
                        + "echo \"seen=$(cat \"$HOME/.korrektor-ctl.seen\" 2>/dev/null || echo 0)\"; line=; "
                        + "[ -f \"$S\" ] && line=\"$(tail -n 600 \"$S\" | " + STRIP + " | " + SINCE_START + " | " + NOISE + " | tail -n 1)\"; "
                        + "[ -n \"$line\" ] || line=\"$(tail -n 1 \"$L\" 2>/dev/null | cut -d' ' -f3-)\"; "
                        + "echo \"$line\"; exit 0";
            case "logs":
                return "L=\"$HOME/.korrektor-ctl.log\"; S=\"$HOME/.korrektor-st.log\"; "
                        + "[ -f \"$L\" ] || [ -f \"$S\" ] || { echo 'Журналов пока нет: из приложения SillyTavern ещё не запускался'; exit 0; }; "
                        + "echo '— Корректор в Termux (~/.korrektor-ctl.log)'; tail -n 25 \"$L\" 2>/dev/null; echo; "
                        + "echo '— SillyTavern, последний запуск (~/.korrektor-st.log)'; "
                        + "tail -n 3000 \"$S\" 2>/dev/null | " + STRIP + " | " + SINCE_START + " | " + NOISE + " | tail -n 40";
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
        // Everything runs as a background command: it starts at once. A command in a new
        // Termux session would wait until Termux is opened (the session starts with its window).
        // Only the installer opens Termux, so its progress is visible there.
        boolean show = "install-tavern".equals(action);

        Intent intent = new Intent();
        intent.setClassName(PACKAGE, "com.termux.app.RunCommandService");
        intent.setAction("com.termux.RUN_COMMAND");
        intent.putExtra("com.termux.RUN_COMMAND_PATH", BASH);
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c", script, "korrektor", startCommand == null ? "" : startCommand});
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME);
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", !show);
        if (show) intent.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", SHOW_SESSION);
        intent.putExtra("com.termux.RUN_COMMAND_COMMAND_LABEL", runsTavern(action) ? "SillyTavern (Корректор)" : "Корректор: " + action);

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
