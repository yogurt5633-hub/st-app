#!/usr/bin/env bash
# Управление SillyTavern и Корректором. Его вызывает приложение Корректор через Termux,
# но можно и руками:
#   bash korrektor-ctl.sh start [--install]   запустить SillyTavern (с --install сперва поставить новую версию Корректора из ~/korrektor-src)
#   bash korrektor-ctl.sh stop                остановить
#   bash korrektor-ctl.sh restart             перезапустить
#   bash korrektor-ctl.sh update-korrektor    поставить Корректор из ~/korrektor-src и перезапустить SillyTavern
#   bash korrektor-ctl.sh update-tavern       обновить SillyTavern (git pull) и перезапустить
#   bash korrektor-ctl.sh status              что найдено (для приложения)
#   bash korrektor-ctl.sh logs                последние строки журналов
# Своя команда запуска (например st): KORREKTOR_START_CMD='st' bash korrektor-ctl.sh start
# Журнал: ~/.korrektor-ctl.log, вывод SillyTavern: ~/.korrektor-st.log
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME/.korrektor-ctl.log"
ST_LOG="$HOME/.korrektor-st.log"
START_CMD="${KORREKTOR_START_CMD:-}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
say() { printf '%s\n' "$*"; log "$*"; }

# Можно закрепить папку SillyTavern: echo 'ST_DIR=/путь' > ~/.korrektor-app.env
[ -f "$HOME/.korrektor-app.env" ] && source "$HOME/.korrektor-app.env"

source "$HERE/st-dir.sh"

# Папку ищем только когда она нужна: журналам и остановке поиск не нужен.
SEARCHED=0
have_dir() {
    [ "$SEARCHED" = 1 ] || { find_st_dir; SEARCHED=1; }
    [ -n "${ST_DIR:-}" ] && is_st "$ST_DIR"
}

need_dir() {
    have_dir && return 0
    say "Не нашлась папка SillyTavern в $HOME."
    say "Установите SillyTavern кнопкой в приложении (вкладка «Ещё») или впишите там свою команду запуска."
    return 1
}

version_of() { grep -m1 '"version"' "$1" 2>/dev/null | sed 's/.*"version": *"\([^"]*\)".*/\1/'; }

# Журналы не растут бесконечно.
trim_log() { [ -f "$1" ] && [ "$(wc -c < "$1")" -gt 1000000 ] && tail -n 3000 "$1" > "$1.tmp" && mv "$1.tmp" "$1"; return 0; }

stop_st() {
    local pids pid i
    pids="$(running_pids)"
    [ -z "$pids" ] && return 0
    log "Останавливаю SillyTavern ($pids)"
    for pid in $pids; do kill "$pid" 2>/dev/null; done
    for i in $(seq 1 20); do
        [ -z "$(running_pids)" ] && break
        sleep 0.5
    done
    for pid in $(running_pids); do kill -9 "$pid" 2>/dev/null; done
    termux-wake-unlock >/dev/null 2>&1 || true
}

install_korrektor() {
    local src="$HOME/korrektor-src"
    if [ ! -f "$src/scripts/install-termux.sh" ]; then
        say "Нет ~/korrektor-src, Корректор не обновлён"
        return 1
    fi
    have_dir || { say "Папка SillyTavern не найдена, Корректор не обновлён"; return 1; }
    say "Ставлю Корректор $(version_of "$src/plugin/package.json") в $ST_DIR"
    ST_DIR="$ST_DIR" bash "$src/scripts/install-termux.sh" >> "$LOG" 2>&1 || say "Установщик Корректора завершился с ошибкой, подробности в ~/.korrektor-ctl.log"
}

# Расширение синхронизации ставится в папку пользователя SillyTavern, а она появляется
# только при первом запуске. Поэтому после старта ждём её и докладываем расширение.
companion_missing() {
    local user_dir
    for user_dir in "$ST_DIR"/data/*/; do
        [ -f "$user_dir/settings.json" ] && [ ! -d "$user_dir/extensions/korrektor-sync" ] && return 0
    done
    return 1
}

watch_companion() {
    local ext="$HOME/korrektor-src/st-extension" i user_dir
    [ -d "$ext" ] && [ -d "$ST_DIR/plugins/korrektor" ] || return 0
    for i in $(seq 1 120); do
        if ls "$ST_DIR"/data/*/settings.json >/dev/null 2>&1; then
            companion_missing || return 0
            for user_dir in "$ST_DIR"/data/*/; do
                [ -f "$user_dir/settings.json" ] || continue
                mkdir -p "$user_dir/extensions"
                [ -d "$user_dir/extensions/korrektor-sync" ] || cp -r "$ext" "$user_dir/extensions/korrektor-sync"
            done
            log "Расширение синхронизации установлено, оно включится после обновления страницы таверны"
            return 0
        fi
        sleep 2
    done
}

# SillyTavern работает в этой сессии Termux: пока он жив, Termux не засыпает.
# Вывод виден в сессии и пишется в ~/.korrektor-st.log.
run_st() {
    local code
    termux-wake-lock >/dev/null 2>&1 || true
    trim_log "$ST_LOG"
    trim_log "$LOG"
    if [ -n "$START_CMD" ]; then
        say "Запускаю SillyTavern командой: $START_CMD"
        have_dir && { watch_companion >/dev/null 2>&1 & }
        cd "$HOME" || true
        set +u
        # Своя команда может быть alias или функцией из ~/.bashrc (так часто устроена команда st).
        if ! type "${START_CMD%% *}" >/dev/null 2>&1 && [ -f "$HOME/.bashrc" ]; then
            source "$HOME/.bashrc" >/dev/null 2>&1
        fi
        shopt -s expand_aliases
        eval "$START_CMD" 2>&1 | tee -a "$ST_LOG"
        code=${PIPESTATUS[0]}
    else
        need_dir || return 1
        cd "$ST_DIR" || return 1
        say "Запускаю SillyTavern из $ST_DIR"
        watch_companion >/dev/null 2>&1 &
        bash ./start.sh 2>&1 | tee -a "$ST_LOG"
        code=${PIPESTATUS[0]}
    fi
    say "SillyTavern остановился (код $code)"
    termux-wake-unlock >/dev/null 2>&1 || true
    return "$code"
}

case "${1:-}" in
    start)
        if [ -n "$(running_pids)" ]; then
            say "SillyTavern уже работает"
            exit 0
        fi
        if [ "${2:-}" = "--install" ] && have_dir; then
            new="$(version_of "$HOME/korrektor-src/plugin/package.json")"
            old="$(version_of "$ST_DIR/plugins/korrektor/package.json")"
            if [ -n "$new" ] && [ "$new" != "$old" ]; then install_korrektor; fi
        fi
        run_st
        ;;
    stop)
        stop_st
        say "SillyTavern остановлен"
        ;;
    restart)
        stop_st
        sleep 1
        run_st
        ;;
    update-korrektor)
        install_korrektor
        stop_st
        sleep 1
        run_st
        ;;
    update-tavern)
        need_dir || exit 1
        say "Обновляю SillyTavern в $ST_DIR"
        git -C "$ST_DIR" pull --ff-only 2>&1 | tee -a "$LOG" || say "git pull в SillyTavern не удался"
        stop_st
        sleep 1
        run_st
        ;;
    status)
        echo "ctl=1"
        have_dir && echo "st_dir=$ST_DIR"
        if [ -n "$(running_pids)" ]; then echo "running=1"; else echo "running=0"; fi
        ;;
    logs)
        strip() { sed 's/\x1b\[[0-9;]*[A-Za-z]//g'; }
        echo "— Корректор (~/.korrektor-ctl.log)"
        tail -n 25 "$LOG" 2>/dev/null | strip
        echo
        echo "— SillyTavern (~/.korrektor-st.log)"
        tail -n 60 "$ST_LOG" 2>/dev/null | strip
        ;;
    *)
        echo "Использование: bash $0 start [--install] | stop | restart | update-korrektor | update-tavern | status | logs"
        exit 2
        ;;
esac
