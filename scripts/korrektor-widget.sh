#!/data/data/com.termux/files/usr/bin/bash
# Ярлык Termux:Widget: запускает SillyTavern, если он ещё не работает, и открывает Корректор.
# install-termux.sh кладёт копию в ~/.shortcuts/Корректор и подставляет путь к SillyTavern.

ST_DIR="${ST_DIR:-__ST_DIR__}"
[ -d "$ST_DIR" ] || ST_DIR="$HOME/SillyTavern"

PORT="$(grep -E '^port:' "$ST_DIR/config.yaml" 2>/dev/null | head -n1 | awk '{print $2}' | tr -d '\r')"
PORT="${PORT:-8000}"
URL="http://127.0.0.1:$PORT/api/plugins/korrektor/app/"

is_up() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

if ! is_up; then
    # Не даём Android усыпить Termux, пока работает сервер.
    termux-wake-lock 2>/dev/null || true
    cd "$ST_DIR" || exit 1
    nohup ./start.sh > "$HOME/.korrektor-st.log" 2>&1 &
    for _ in $(seq 1 90); do
        is_up && break
        sleep 1
    done
fi

if ! is_up; then
    echo "SillyTavern не запустился, смотрите ~/.korrektor-st.log"
    exit 1
fi

termux-open-url "$URL" 2>/dev/null || am start -a android.intent.action.VIEW -d "$URL" >/dev/null 2>&1
