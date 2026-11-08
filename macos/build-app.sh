#!/bin/zsh
# 构建 macOS .app：校验 Node 运行时、编译 Swift 外壳、复制分层源码并做临时签名。
# 产物必须保持 Contents/Resources/src/... 结构，因为控制面和 MCP 配置依赖相对路径。
set -eu
ROOT="${0:A:h:h}"
cd -- "$ROOT"
APP_DIR="${1:-dist/Agents Calling.app}"
NODE_BIN="${2:-${AI_BRIDGE_NODE:-$(command -v node)}}"
SOURCE_FILES=(package.json)
for source_file in macos/Desktop.swift Node-LICENSE "${SOURCE_FILES[@]}"; do
  [[ -f "$source_file" ]] || { print -u2 "Missing required resource: $source_file"; exit 1; }
done
[[ -d src ]] || { print -u2 "Missing required resource: src"; exit 1; }
[[ -f macos/AppIcon.icns ]] || { print -u2 "Missing required resource: macos/AppIcon.icns"; exit 1; }
[[ -x "$NODE_BIN" ]] || { print -u2 "Node executable not found: $NODE_BIN"; exit 1; }
# A Homebrew runtime may work in place but fail when copied into the App.
xcrun lipo "$NODE_BIN" -verify_arch arm64 >/dev/null 2>&1 || { print -u2 "Use a standalone macOS arm64 Node.js binary (AI_BRIDGE_NODE or second argument)."; exit 1; }
if /usr/bin/otool -L "$NODE_BIN" | /usr/bin/awk 'NR > 1 && $1 !~ /^\/(usr\/lib|System\/Library)\// { bad=1 } END { exit !bad }'; then
  print -u2 "Use a standalone Node.js binary: external dylibs cannot be bundled by this script. Set AI_BRIDGE_NODE or pass the binary as the second argument."
  exit 1
fi
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 26) { console.error("Node.js >=26 required"); process.exit(1); }'
VERSION=$("$NODE_BIN" -p "require('./package.json').version")
[[ -n "$VERSION" ]] || { print -u2 "package.json version is required"; exit 1; }
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
xcrun swiftc macos/Desktop.swift -target arm64-apple-macosx13.5 -framework Cocoa -framework WebKit -O -o "$APP_DIR/Contents/MacOS/Agents Calling"
cp -L "$NODE_BIN" "$APP_DIR/Contents/Resources/node"
cp macos/AppIcon.icns "$APP_DIR/Contents/Resources/AppIcon.icns"
rm -rf "$APP_DIR/Contents/Resources/src"
cp -R src "$APP_DIR/Contents/Resources/src"
for source_file in "${SOURCE_FILES[@]}"; do
  cp "$source_file" "$APP_DIR/Contents/Resources/$source_file"
done
cp Node-LICENSE "$APP_DIR/Contents/Resources/Node-LICENSE"
cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Agents Calling</string>
<key>CFBundleIdentifier</key><string>local.team.aibridge</string>
<key>CFBundleName</key><string>Agents Calling</string>
<key>CFBundleDisplayName</key><string>Agents Calling</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
<key>CFBundleVersion</key><string>${VERSION}</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSLocalNetworkUsageDescription</key><string>连接同事电脑上的 AI 协作桥接服务。</string>
<key>NSAppleEventsUsageDescription</key><string>选择本机项目文件夹。</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$APP_DIR/Contents/Resources/node"
codesign --force --sign - "$APP_DIR"
"$APP_DIR/Contents/Resources/node" --version
codesign --verify --deep --strict "$APP_DIR"
echo "Built: $APP_DIR"
