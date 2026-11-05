#!/usr/bin/env bash
# Устанавливает Корректор в SillyTavern (Android, Termux).
# Запуск: bash scripts/install-termux.sh
# Другая папка SillyTavern: ST_DIR=/путь/к/SillyTavern bash scripts/install-termux.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../plugin"

say() { printf '%s\n' "$*"; }

is_st() { [ -f "$1/server.js" ] && grep -qi '"name": *"sillytavern"' "$1/package.json" 2>/dev/null; }

# Папка SillyTavern: из ST_DIR, из обычных мест или поиском по домашней папке
# (лаунчеры кладут её глубже, например ~/SillyTavern-Launcher/SillyTavern).
if [ -z "${ST_DIR:-}" ]; then
    for dir in "$HOME/SillyTavern" "$HOME/SillyTavern-Launcher/SillyTavern" "$HOME/sillytavern" "$HOME/ST"; do
        if is_st "$dir"; then ST_DIR="$dir"; break; fi
    done
fi
if [ -z "${ST_DIR:-}" ]; then
    while IFS= read -r found; do
        dir="$(dirname "$found")"
        if is_st "$dir"; then ST_DIR="$dir"; break; fi
    done < <(find "$HOME" -maxdepth 4 -name server.js -not -path '*/node_modules/*' 2>/dev/null)
fi
if [ -z "${ST_DIR:-}" ] || ! is_st "$ST_DIR"; then
    say "Не нашёл папку SillyTavern${ST_DIR:+ в $ST_DIR}"
    say "Укажите её: ST_DIR=/путь/к/SillyTavern bash $0"
    exit 1
fi
say "SillyTavern: $ST_DIR"

# 1. Плагин
mkdir -p "$ST_DIR/plugins"
rm -rf "$ST_DIR/plugins/korrektor"
cp -r "$SRC" "$ST_DIR/plugins/korrektor"
say "Плагин скопирован в $ST_DIR/plugins/korrektor"

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
say "Готово. Перезапустите SillyTavern и откройте:"
say "  $URL"
say "В Chrome: меню ⋮ → «Добавить на главный экран» (или «Установить приложение»)"
say ""
say "Необязательно, для уведомлений Android: установите приложение Termux:API и выполните"
say "  pkg install termux-api"
