#!/bin/zsh
# 从矢量源生成 macOS 多尺寸 AppIcon.icns。
# 只在图标源变化时手动运行；构建 App 时直接复用仓库里的 .icns。
set -eu
ROOT="${0:A:h:h}"
SOURCE="${1:-$ROOT/macos/AppIcon.svg}"
OUTPUT="${2:-$ROOT/macos/AppIcon.icns}"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/agents-calling-icon.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

[[ -f "$SOURCE" ]] || { print -u2 "Missing icon source: $SOURCE"; exit 1; }

# sips 直接栅格化 SVG，保留圆角外的透明通道；Quick Look 会额外铺一层不透明白底。
PNG="$TMP/AppIcon.png"
sips -s format png "$SOURCE" --out "$PNG" >/dev/null
[[ -f "$PNG" ]] || { print -u2 "sips did not render $SOURCE"; exit 1; }

ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUTPUT"
echo "Built: $OUTPUT"
