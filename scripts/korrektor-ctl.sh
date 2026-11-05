#!/usr/bin/env bash
# Управление SillyTavern и Корректором. Его вызывает приложение Корректор через Termux,
# но можно и руками:
#   bash korrektor-ctl.sh start [--install]   запустить SillyTavern (с --install сперва поставить новую версию Корректора из ~/korrektor-src)
#   bash korrektor-ctl.sh stop                остановить
#   bash korrektor-ctl.sh restart             перезапустить
#   bash korrektor-ctl.sh update-korrektor    поставить Корректор из ~/korrektor-src и перезапустить SillyTavern
#   bash korrektor-ctl.sh update-tavern       обновить SillyTavern (git pull) и перезапустить
# Журнал: ~/.korrektor-ctl.log, вывод SillyTavern: ~/.korrektor-st.log
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME/.korrektor-ctl.log"
ST_LOG="$HOME/.korrektor-st.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# Можно закрепить папку SillyTavern: echo 'ST_DIR=/путь' > ~/.korrektor-app.env
[ -f "$HOME/.korrektor-app.env" ] && source "$HOME/.korrektor-app.env"

source "$HERE/st-dir.sh"
find_st_dir
if [ -z "${ST_DIR:-}" ] || ! is_st "$ST_DIR"; then
    log "Не нашёл папку SillyTavern. Укажите её: echo 'ST_DIR=/путь' > ~/.korrektor-app.env"
    exit 1
fi

version_of() { grep -m1 '"version"' "$1" 2>/dev/null | sed 's/.*"version": *"\([^"]*\)".*/\1/'; }

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
        log "Нет ~/korrektor-src, пропускаю установку Корректора"
        return 1
    fi
    log "Ставлю Корректор $(version_of "$src/plugin/package.json") в $ST_DIR"
    ST_DIR="$ST_DIR" bash "$src/scripts/install-termux.sh" >> "$LOG" 2>&1 || log "Установщик завершился с ошибкой"
}

# SillyTavern работает в этой задаче Termux: пока он жив, Termux не засыпает.
run_st() {
    termux-wake-lock >/dev/null 2>&1 || true
    cd "$ST_DIR" || exit 1
    log "Запускаю SillyTavern из $ST_DIR"
    exec bash ./start.sh >> "$ST_LOG" 2>&1
}

case "${1:-}" in
    start)
        if [ -n "$(running_pids)" ]; then
            log "SillyTavern уже работает"
            exit 0
        fi
        if [ "${2:-}" = "--install" ]; then
            new="$(version_of "$HOME/korrektor-src/plugin/package.json")"
            old="$(version_of "$ST_DIR/plugins/korrektor/package.json")"
            if [ -n "$new" ] && [ "$new" != "$old" ]; then install_korrektor; fi
        fi
        run_st
        ;;
    stop)
        stop_st
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
        log "Обновляю SillyTavern в $ST_DIR"
        git -C "$ST_DIR" pull --ff-only >> "$LOG" 2>&1 || log "git pull в SillyTavern не удался"
        stop_st
        sleep 1
        run_st
        ;;
    *)
        echo "Использование: bash $0 start [--install] | stop | restart | update-korrektor | update-tavern"
        exit 2
        ;;
esac
