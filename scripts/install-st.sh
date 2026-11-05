#!/usr/bin/env bash
# Ставит SillyTavern в Termux (~/SillyTavern) вместе с Корректором и запускает его.
# Его запускает кнопка «Установить SillyTavern» в приложении Корректор, можно и руками:
#   bash ~/korrektor-src/scripts/install-st.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '\n== %s\n' "$*"; }
fail() {
    printf '\n%s\n' "$*"
    printf 'Окно можно закрыть и попробовать ещё раз из приложения. Журнал: ~/.korrektor-ctl.log\n'
    exit 1
}

source "$HERE/st-dir.sh"
find_st_dir

if [ -n "${ST_DIR:-}" ] && is_st "$ST_DIR"; then
    step "SillyTavern уже установлен: $ST_DIR"
else
    step "1/4 Обновляю пакеты Termux. Это может занять несколько минут"
    apt-get update || fail "Не удалось скачать список пакетов. Выполните termux-change-repo, выберите другое зеркало и повторите"
    apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade \
        || fail "Не удалось обновить пакеты Termux"

    step "2/4 Ставлю git и Node.js"
    command -v git >/dev/null || apt-get -y install git || fail "Не удалось поставить git"
    command -v node >/dev/null || apt-get -y install nodejs-lts || fail "Не удалось поставить Node.js"

    step "3/4 Скачиваю SillyTavern в ~/SillyTavern"
    git clone --depth 1 -b release https://github.com/SillyTavern/SillyTavern "$HOME/SillyTavern" \
        || fail "Не удалось скачать SillyTavern"
    ST_DIR="$HOME/SillyTavern"
fi

step "4/4 Ставлю Корректор"
ST_DIR="$ST_DIR" bash "$HERE/install-termux.sh" || fail "Не удалось поставить Корректор"

step "Запускаю SillyTavern. Первый запуск дольше обычного: ставятся зависимости"
printf 'Вернитесь в приложение Корректор: оно откроет таверну, когда та запустится.\n\n'
ST_DIR="$ST_DIR" exec bash "$HERE/korrektor-ctl.sh" start
