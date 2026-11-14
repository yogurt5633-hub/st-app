#!/usr/bin/env bash
# Reproducible packaging of the approved foreground; requires ImageMagick.
set -euo pipefail
cd "$(dirname "$0")/.."
source_image=docs/design/icon-foreground.png
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
    density=${pair%:*}; size=${pair#*:}; canvas=$((size * 108 / 48)); art=$((size * 76 / 48))
    convert "$source_image" -trim +repage -resize "${art}x${art}" -gravity center -background none -extent "${canvas}x${canvas}" "android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png"
done
convert "$source_image" -trim +repage -resize 460x460 -gravity center -background '#fff0d5' -extent 512x512 plugin/app/icons/maskable-512.png
