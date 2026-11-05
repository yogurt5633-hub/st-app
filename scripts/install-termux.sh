#!/usr/bin/env bash
# Устанавливает Корректор в SillyTavern (Android, Termux).
# Запуск: bash scripts/install-termux.sh
# Другая папка SillyTavern: ST_DIR=/путь/к/SillyTavern bash scripts/install-termux.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../plugin"

say() { printf '%s\n' "$*"; }

is_st() { [ -f "$1/server.js" ] && grep -qi '"name": *"sillytavern"' "$1/package.json" 2>/dev/null; }

# Папка SillyTavern, где она уже запущена (самый надёжный признак).
running_dir() {
    local proc cmd
    for proc in /proc/[0-9]*; do
        cmd="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
        case "$cmd" in
            *node*server.js*) readlink "$proc/cwd" 2>/dev/null && return 0 ;;
        esac
    done
    return 1
}
RUNNING_DIR="$(running_dir || true)"
if [ -n "$RUNNING_DIR" ] && ! is_st "$RUNNING_DIR"; then RUNNING_DIR=""; fi

# Все папки SillyTavern в домашней папке (лаунчеры кладут её глубже,
# например ~/SillyTavern-Launcher/SillyTavern).
CANDIDATES=()
for dir in "$HOME/SillyTavern" "$HOME/SillyTavern-Launcher/SillyTavern" "$HOME/sillytavern" "$HOME/ST"; do
    is_st "$dir" && CANDIDATES+=("$(cd "$dir" && pwd)")
done
while IFS= read -r found; do
    dir="$(cd "$(dirname "$found")" && pwd)"
    is_st "$dir" || continue
    case " ${CANDIDATES[*]:-} " in *" $dir "*) ;; *) CANDIDATES+=("$dir") ;; esac
done < <(find "$HOME" -maxdepth 4 -name server.js -not -path '*/node_modules/*' 2>/dev/null)

if [ -z "${ST_DIR:-}" ]; then
    if [ -n "$RUNNING_DIR" ]; then
        ST_DIR="$RUNNING_DIR"
    elif [ "${#CANDIDATES[@]}" -gt 0 ]; then
        ST_DIR="${CANDIDATES[0]}"
    fi
fi
if [ -z "${ST_DIR:-}" ] || ! is_st "$ST_DIR"; then
    say "Не нашёл папку SillyTavern${ST_DIR:+ в $ST_DIR}"
    say "Укажите её: ST_DIR=/путь/к/SillyTavern bash $0"
    exit 1
fi
if [ "${#CANDIDATES[@]}" -gt 1 ]; then
    say "Нашлось несколько папок SillyTavern:"
    for dir in "${CANDIDATES[@]}"; do say "  $dir"; done
    if [ -n "$RUNNING_DIR" ]; then which="в ту, которая сейчас запущена"; else which="в первую из списка"; fi
    say "Ставлю $which. Другую можно выбрать так: ST_DIR=/путь bash $0"
fi
say "SillyTavern: $ST_DIR"

# 1. Плагин
mkdir -p "$ST_DIR/plugins"
rm -rf "$ST_DIR/plugins/korrektor"
cp -r "$SRC" "$ST_DIR/plugins/korrektor"
VERSION="$(grep -m1 '"version"' "$SRC/package.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
say "Плагин Корректор $VERSION скопирован в $ST_DIR/plugins/korrektor"

# 2. Расширение-компаньон: обновляет открытый в SillyTavern чат после правки
EXT_SRC="$HERE/../st-extension"
installed_ext=0
for user_dir in "$ST_DIR"/data/*/; do
    [ -f "$user_dir/settings.json" ] || continue
    mkdir -p "$user_dir/extensions"
    rm -rf "$user_dir/extensions/korrektor-sync"
    cp -r "$EXT_SRC" "$user_dir/extensions/korrektor-sync"
    installed_ext=1
done
if [ "$installed_ext" = 1 ]; then
    say "Расширение «Корректор: синхронизация» установлено"
else
    say "Пользователей SillyTavern ещё нет. Запустите SillyTavern один раз и повторите установку, чтобы поставить расширение синхронизации"
fi

# 3. Включаем серверные плагины в config.yaml
CONFIG="$ST_DIR/config.yaml"
if [ ! -f "$CONFIG" ] && [ -f "$ST_DIR/default/config.yaml" ]; then
    cp "$ST_DIR/default/config.yaml" "$CONFIG"
fi
if [ -f "$CONFIG" ]; then
    if grep -qE '^enableServerPlugins:' "$CONFIG"; then
        sed -i 's/^enableServerPlugins:.*/enableServerPlugins: true/' "$CONFIG"
    else
        printf '\nenableServerPlugins: true\n' >> "$CONFIG"
    fi
    say "В config.yaml включено enableServerPlugins: true"
else
    say "config.yaml не найден. Запустите SillyTavern один раз и повторите установку"
    exit 1
fi

PORT="$(grep -E '^port:' "$CONFIG" | head -n1 | awk '{print $2}' | tr -d '\r')"
PORT="${PORT:-8000}"
URL="http://127.0.0.1:$PORT/api/plugins/korrektor/app/"

# 4. Кнопка на рабочем столе через Termux:Widget
if [ -d "$HOME" ]; then
    mkdir -p "$HOME/.shortcuts"
    sed "s#__ST_DIR__#$ST_DIR#" "$HERE/korrektor-widget.sh" > "$HOME/.shortcuts/Корректор"
    chmod +x "$HOME/.shortcuts/Корректор"
    say "Ярлык для Termux:Widget: ~/.shortcuts/Корректор"
fi

say ""
if [ -n "$RUNNING_DIR" ] && [ "$(cd "$RUNNING_DIR" && pwd)" != "$(cd "$ST_DIR" && pwd)" ]; then
    say "Внимание: сейчас запущен SillyTavern из $RUNNING_DIR, а Корректор поставлен в $ST_DIR"
    say "Запускайте SillyTavern из $ST_DIR или поставьте Корректор так: ST_DIR=$RUNNING_DIR bash $0"
    say ""
fi
if [ -n "$RUNNING_DIR" ]; then
    say "SillyTavern сейчас работает: остановите его (Ctrl+C в его окне Termux) и запустите снова, иначе останется старая версия"
fi
say "Готово. Версия $VERSION. Перезапустите SillyTavern и откройте:"
say "  $URL"
say "В Chrome: меню ⋮ → «Добавить на главный экран» (или «Установить приложение»)"
say ""
say "Необязательно, для уведомлений Android: установите приложение Termux:API и выполните"
say "  pkg install termux-api"
