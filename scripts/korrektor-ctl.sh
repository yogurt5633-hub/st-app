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

# Вывод таверны. Из приложения скрипт работает фоновой командой Termux, без окна:
# тогда вывод идёт только в журнал (Termux не копит его в памяти). Руками — ещё и на экран.
st_output() {
    if [ -t 1 ]; then tee -a "$ST_LOG"; else cat >> "$ST_LOG"; fi
}

# Можно закрепить папку SillyTavern: echo 'ST_DIR=/путь' > ~/.korrektor-app.env
[ -f "$HOME/.korrektor-app.env" ] && source "$HOME/.korrektor-app.env"

source "$HERE/st-dir.sh"

# Вывод таверны для журнала: без цветовых кодов, только после метки последнего запуска
# и без длинных списков моделей, которые печатает SillyTavern.
clean_output() {
    sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\r//g' \
        | awk '/^== Корректор: запуск/{b="";next}{b=b $0 "\n"}END{printf "%s",b}' \
        | grep -vE "^[[:space:]]*\$|^[[:space:]]*['\"]|^[[:space:]]*[][{}][,;]?[[:space:]]*\$"
}

# Приложение по этому файлу видит, что Termux действительно начал выполнять команду.
# Метка в выводе таверны отделяет этот запуск от прошлых: приложение показывает только новое.
case "${1:-}" in
    start|stop|restart|update-korrektor|update-tavern) date +%s > "$HOME/.korrektor-ctl.seen" ;;
esac
case "${1:-}" in
    start|restart|update-korrektor|update-tavern)
        [ -z "$(running_pids 2>/dev/null)" ] || [ "${1:-}" != start ] && printf '\n== Корректор: запуск %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$ST_LOG"
        ;;
esac

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

# Один запуск за раз: два установщика сразу ломали друг другу файлы плагина.
# Блокировку снимает только тот, кто её взял (иначе старый запуск, завершаясь,
# снимал блокировку нового).
LOCK="$HOME/.korrektor-ctl.lock"
lock_owner() { cat "$LOCK/pid" 2>/dev/null; }
take_lock() {
    local pid
    if ! mkdir "$LOCK" 2>/dev/null; then
        pid="$(lock_owner)"
        if [ -n "$pid" ] && [ "$pid" != "$$" ] && kill -0 "$pid" 2>/dev/null; then
            # «Перезапуск» и «обновление» всё равно останавливают таверну: если она уже
            # работает, держатель блокировки — просто её запуск, блокировку можно забрать.
            [ "${1:-}" = "take-over" ] && [ -n "$(running_pids)" ] || return 1
            log "Забираю блокировку у запуска $pid: таверна будет перезапущена"
        fi
        rm -rf "$LOCK"
        mkdir "$LOCK" 2>/dev/null || return 1
    fi
    echo "$$" > "$LOCK/pid"
    trap 'drop_lock' EXIT
    return 0
}
drop_lock() { [ "$(lock_owner)" = "$$" ] && rm -rf "$LOCK"; return 0; }
# Ждёт, пока другой запуск закончит установку (до 3 минут), вместо того чтобы молча выйти.
wait_lock() {
    local i
    for i in $(seq 1 90); do
        take_lock "${1:-}" && return 0
        [ "$i" = 1 ] && say "Таверна ещё запускается: подожду, пока закончит"
        sleep 2
    done
    return 1
}

# «cd папка» только переходит в папку и сразу заканчивается: такую команду
# понимаем как «запустить таверну из этой папки».
cd_only_dir() {
    local dir
    [[ "$1" =~ ^[[:space:]]*cd[[:space:]]+([^\;\&\|]+)$ ]] || return 1
    dir="${BASH_REMATCH[1]}"
    dir="${dir%"${dir##*[![:space:]]}"}"
    dir="${dir%/}"
    dir="${dir/#\~/$HOME}"
    [[ "$dir" = /* ]] || dir="$HOME/$dir"
    printf '%s' "$dir"
}

# Зависимости SillyTavern ставятся только когда они поменялись: npm install на
# телефоне занимает от десятков секунд до минут при каждом запуске.
deps_stamp() { cat "$ST_DIR/package.json" "$ST_DIR/package-lock.json" 2>/dev/null | cksum | cut -d' ' -f1; }
DEPS_FILE="$HOME/.korrektor-st-deps"

# Ждёт в фоне, пока таверна начнёт отвечать: тогда снимает блокировку и
# запоминает, что зависимости в порядке.
watch_ready() {
    local from="$1" stamp="$2" i
    for i in $(seq 1 900); do
        sleep 2
        if tail -c +"$((from + 1))" "$ST_LOG" 2>/dev/null | grep -qE 'is listening|Go to:|listening on'; then
            [ -n "$stamp" ] && printf '%s' "$stamp" > "$DEPS_FILE"
            drop_lock
            return 0
        fi
    done
}

# SillyTavern работает в этой сессии Termux: пока он жив, Termux не засыпает.
# Вывод виден в сессии и пишется в ~/.korrektor-st.log.
run_st() {
    local code dir started from stamp
    termux-wake-lock >/dev/null 2>&1 || true
    trim_log "$ST_LOG"
    trim_log "$LOG"
    started=$SECONDS
    from=0
    [ -f "$ST_LOG" ] && from="$(wc -c < "$ST_LOG")"
    if [ -n "$START_CMD" ] && dir="$(cd_only_dir "$START_CMD")"; then
        if is_st "$dir"; then
            say "Команда «$START_CMD» только переходит в папку: запускаю таверну из $dir"
            ST_DIR="$dir"
            SEARCHED=1
            START_CMD=""
        else
            say "Команда «$START_CMD» переходит в папку, где нет SillyTavern. Исправьте поле «Команда запуска» на вкладке «Главная» или оставьте его пустым"
            return 3
        fi
    fi
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
        watch_ready "$from" "" &
        eval "$START_CMD" 2>&1 | st_output
        code=${PIPESTATUS[0]}
    else
        need_dir || return 1
        cd "$ST_DIR" || return 1
        watch_companion >/dev/null 2>&1 &
        stamp="$(deps_stamp)"
        export NODE_ENV=production
        if [ -d node_modules ] && [ "$(cat "$DEPS_FILE" 2>/dev/null)" = "$stamp" ] && command -v node >/dev/null; then
            say "Запускаю SillyTavern из $ST_DIR (зависимости не менялись, без npm install)"
            watch_ready "$from" "$stamp" &
            node server.js 2>&1 | st_output
            code=${PIPESTATUS[0]}
        else
            say "Запускаю SillyTavern из $ST_DIR. Сначала ставятся зависимости: в первый раз это может занять несколько минут"
            watch_ready "$from" "$stamp" &
            bash ./start.sh 2>&1 | st_output
            code=${PIPESTATUS[0]}
        fi
    fi
    # Команда закончилась сразу, а таверна так и не появилась: скорее всего,
    # в поле «Команда запуска» не та команда.
    if [ "$code" = 0 ] && [ $((SECONDS - started)) -lt 20 ] && [ -z "$(running_pids)" ]; then
        say "Команда запуска закончилась через $((SECONDS - started)) с, а SillyTavern так и не запустился."
        say "Проверьте поле «Команда запуска»: она должна запускать таверну, например: cd ~/SillyTavern && ./start.sh. Или оставьте поле пустым"
        code=3
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
        if ! take_lock; then
            say "SillyTavern уже запускается: второй запуск не нужен"
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
        wait_lock take-over || { say "Таверна запускается слишком долго: перезапуск отменён. Посмотрите журнал"; exit 1; }
        stop_st
        sleep 1
        run_st
        ;;
    update-korrektor)
        wait_lock take-over || { say "Таверна запускается слишком долго: обновление не поставлено. Нажмите «Обновить» ещё раз через минуту"; exit 1; }
        install_korrektor
        stop_st
        sleep 1
        run_st
        ;;
    update-tavern)
        need_dir || exit 1
        wait_lock take-over || { say "Таверна запускается слишком долго: обновление отменено"; exit 1; }
        say "Обновляю SillyTavern в $ST_DIR"
        git -C "$ST_DIR" pull --ff-only 2>&1 | tee -a "$LOG" || say "git pull в SillyTavern не удался"
        stop_st
        sleep 1
        run_st
        ;;
    progress)
        # Последняя содержательная строка этого запуска: показывается, пока таверна запускается.
        line="$(tail -n 600 "$ST_LOG" 2>/dev/null | clean_output | tail -n 1)"
        [ -n "$line" ] || line="$(tail -n 1 "$LOG" 2>/dev/null | cut -d' ' -f3-)"
        printf '%s\n' "$line"
        ;;
    status)
        echo "ctl=1"
        have_dir && echo "st_dir=$ST_DIR"
        if [ -n "$(running_pids)" ]; then echo "running=1"; else echo "running=0"; fi
        ;;
    logs)
        echo "— Корректор (~/.korrektor-ctl.log)"
        tail -n 25 "$LOG" 2>/dev/null
        echo
        echo "— SillyTavern, последний запуск (~/.korrektor-st.log)"
        tail -n 3000 "$ST_LOG" 2>/dev/null | clean_output | tail -n 40
        ;;
    *)
        echo "Использование: bash $0 start [--install] | stop | restart | update-korrektor | update-tavern | status | logs"
        exit 2
        ;;
esac
