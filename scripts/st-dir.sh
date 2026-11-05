# Общие функции: где SillyTavern. Подключается из install-termux.sh и korrektor-ctl.sh.

is_st() { [ -f "$1/server.js" ] && grep -qi '"name": *"sillytavern"' "$1/package.json" 2>/dev/null; }

# Это процесс SillyTavern? Сам node (не оболочка, где просто встречаются эти слова) с аргументом server.js.
is_st_process() {
    local -a args=()
    local arg
    [ -r "$1/cmdline" ] || return 1
    while IFS= read -r -d '' arg; do args+=("$arg"); done < "$1/cmdline"
    [ "${#args[@]}" -ge 2 ] || return 1
    case "$(basename "${args[0]}")" in node|nodejs) ;; *) return 1 ;; esac
    for arg in "${args[@]:1}"; do
        case "$arg" in server.js|*/server.js) return 0 ;; esac
    done
    return 1
}

# PID запущенных SillyTavern.
running_pids() {
    local proc
    for proc in /proc/[0-9]*; do
        is_st_process "$proc" && printf '%s\n' "${proc#/proc/}"
    done
}

# Папка SillyTavern, который запущен прямо сейчас (самый надёжный признак).
running_dir() {
    local pid dir
    for pid in $(running_pids); do
        dir="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
        if [ -n "$dir" ] && is_st "$dir"; then printf '%s\n' "$dir"; return 0; fi
    done
    return 1
}

# Заполняет RUNNING_DIR, CANDIDATES и, если не задан, ST_DIR.
find_st_dir() {
    RUNNING_DIR="$(running_dir || true)"
    CANDIDATES=()
    local dir found
    for dir in "$HOME/SillyTavern" "$HOME/SillyTavern-Launcher/SillyTavern" "$HOME/sillytavern" "$HOME/ST"; do
        is_st "$dir" && CANDIDATES+=("$(cd "$dir" && pwd)")
    done
    while IFS= read -r found; do
        dir="$(cd "$(dirname "$found")" && pwd)"
        is_st "$dir" || continue
        case " ${CANDIDATES[*]:-} " in *" $dir "*) ;; *) CANDIDATES+=("$dir") ;; esac
    done < <(find "$HOME" -maxdepth 4 \( -name node_modules -o -path "$HOME/.*" \) -prune -o -name server.js -type f -print 2>/dev/null)
    if [ -z "${ST_DIR:-}" ]; then
        if [ -n "$RUNNING_DIR" ]; then
            ST_DIR="$RUNNING_DIR"
        elif [ "${#CANDIDATES[@]}" -gt 0 ]; then
            ST_DIR="${CANDIDATES[0]}"
        fi
    fi
}
