#!/usr/bin/env bash
# Создаёт ключ подписи для приложения Корректор и кладёт его в секреты
# репозитория на GitHub. С ним каждая новая версия ставится поверх старой,
# и автообновление в приложении работает.
#
# Запуск в Termux: bash ~/korrektor-src/scripts/setup-signing.sh
#
# Ключ уходит только в секреты GitHub (их нельзя прочитать, только заменить)
# и в резервную копию ~/.korrektor-signing на этом телефоне.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$HOME/.korrektor-signing"

say() { printf '%s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }

# Репозиторий: из адреса этой копии кода, иначе основной.
if [ -z "${REPO:-}" ]; then
    url="$(git -C "$HERE/.." remote get-url origin 2>/dev/null || true)"
    REPO="$(printf '%s' "$url" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##; s#/$##')"
    case "$REPO" in */*) ;; *) REPO="yogurt5633-hub/st-app" ;; esac
fi
say "Репозиторий: $REPO"

if ! has gh || ! has openssl; then
    if has pkg; then
        say "Ставлю gh и openssl…"
        pkg install -y gh openssl-tool >/dev/null 2>&1 || pkg install -y gh openssl
    fi
    if ! has gh || ! has openssl; then
        say "Нужны программы gh и openssl. В Termux: pkg install gh openssl-tool"
        exit 1
    fi
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
    say ""
    say "Нужно войти в GitHub (один раз). gh покажет код из 8 символов:"
    say "скопируйте его, нажмите Enter, в браузере войдите и введите код."
    say "Если браузер не открылся: https://github.com/login/device"
    say ""
    has termux-open-url && export BROWSER=termux-open-url
    gh auth login -h github.com -p https -w
fi

if ! gh repo view "$REPO" >/dev/null 2>&1; then
    say "Нет доступа к $REPO. Войдите в GitHub под владельцем репозитория: gh auth login"
    exit 1
fi

umask 077
if [ -s "$DIR/release.p12" ] && [ -s "$DIR/password" ]; then
    say "Нашлась сохранённая копия ключа в $DIR, загружаю её"
else
    if gh secret list -R "$REPO" 2>/dev/null | grep -q '^KORREKTOR_KEYSTORE_BASE64'; then
        say ""
        say "В $REPO уже есть ключ подписи, а копии на этом телефоне нет."
        say "Если заменить ключ, приложение придётся один раз удалить и поставить заново."
        read -r -p "Заменить ключ? (y/N) " answer
        case "$answer" in y|Y|д|Д) ;; *) say "Ключ не менялся"; exit 0 ;; esac
    fi
    say "Создаю ключ…"
    mkdir -p "$DIR"
    PW="$(openssl rand -hex 24)"
    export PW
    openssl req -x509 -newkey rsa:4096 -sha256 -days 36500 -nodes -subj "/CN=Korrektor" \
        -keyout "$DIR/key.pem" -out "$DIR/cert.pem" 2>/dev/null
    openssl pkcs12 -export -inkey "$DIR/key.pem" -in "$DIR/cert.pem" -name korrektor \
        -out "$DIR/release.p12" -passout env:PW
    rm -f "$DIR/key.pem" "$DIR/cert.pem"
    printf '%s' "$PW" > "$DIR/password"
    unset PW
fi

say "Сохраняю ключ в секретах GitHub…"
base64 < "$DIR/release.p12" | tr -d '\n' | gh secret set KORREKTOR_KEYSTORE_BASE64 -R "$REPO"
gh secret set KORREKTOR_SIGNING_PASSWORD -R "$REPO" < "$DIR/password"

say ""
say "Готово. Копия ключа: $DIR (не удаляйте, она понадобится, если секреты пропадут)."
if gh workflow run android.yml -R "$REPO" --ref main >/dev/null 2>&1; then
    say "Сборка приложения запущена. Через 5–10 минут оно появится здесь:"
else
    say "Запустите сборку: GitHub → Actions → Android APK → Run workflow. Потом приложение появится здесь:"
fi
say "https://github.com/$REPO/releases/latest"
