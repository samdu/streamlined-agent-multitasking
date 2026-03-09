#!/bin/bash
# setup.sh - Install cs-spawn and register the codeserver:// URL scheme
set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
APP_DIR="${HOME}/Applications/CodeServerSpawn.app"

mkdir -p "$INSTALL_DIR"

# --- Install scripts ---
cp cs-spawn.sh "$INSTALL_DIR/cs-spawn"
cp cs-stop.sh "$INSTALL_DIR/cs-stop"
cp cs-spawn-from-url.sh "$INSTALL_DIR/cs-spawn-from-url"
cp cs-api.py "$INSTALL_DIR/cs-api"
chmod +x "$INSTALL_DIR/cs-spawn" "$INSTALL_DIR/cs-stop" "$INSTALL_DIR/cs-spawn-from-url" "$INSTALL_DIR/cs-api"

# --- Ensure it's on PATH ---
if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
  echo ""
  echo "⚠  Add $INSTALL_DIR to your PATH if not already:"
  echo "   export PATH=\"$INSTALL_DIR:\$PATH\""
  echo ""
fi

# --- Install session API daemon (LaunchAgent) ---
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_LABEL="com.cs-spawn.api"
PLIST_PATH="${PLIST_DIR}/${PLIST_LABEL}.plist"
PIDDIR="${HOME}/.cs-spawn"
mkdir -p "$PLIST_DIR" "$PIDDIR"

# Unload existing if present (ignore errors if not loaded)
launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true

cat > "$PLIST_PATH" << APIPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>${INSTALL_DIR}/cs-api</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${PIDDIR}/api.log</string>
  <key>StandardErrorPath</key>
  <string>${PIDDIR}/api.log</string>
</dict>
</plist>
APIPLIST

launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

# --- Create macOS app bundle for codeserver:// URL scheme ---
# Must be a compiled AppleScript applet — macOS delivers custom URL schemes
# via Apple Events (kAEGetURL), which only AppleScript/Cocoa can receive.
# A plain bash script as CFBundleExecutable will never get the URL.
rm -rf "$APP_DIR"

ASCRIPT_SRC=$(mktemp /tmp/cs-spawn-handler.XXXXXX)
cat > "$ASCRIPT_SRC" << 'APPLESCRIPT'
on open location theURL
  set homePath to POSIX path of (path to home folder)
  set spawner to homePath & ".local/bin/cs-spawn-from-url"
  set logPath to homePath & ".cs-spawn/url-handler.log"
  do shell script spawner & " " & quoted form of theURL & " >> " & quoted form of logPath & " 2>&1 &"
end open location
APPLESCRIPT

osacompile -o "$APP_DIR" "$ASCRIPT_SRC"
rm -f "$ASCRIPT_SRC"

# Inject URL scheme registration and metadata into the applet's Info.plist
defaults write "$APP_DIR/Contents/Info" CFBundleIdentifier -string "zone.hexagon.codeserverspawn"
defaults write "$APP_DIR/Contents/Info" CFBundleURLTypes -array \
  '<dict><key>CFBundleURLName</key><string>Code Server Spawn</string><key>CFBundleURLSchemes</key><array><string>codeserver</string></array></dict>'
defaults write "$APP_DIR/Contents/Info" LSBackgroundOnly -bool true

# Re-register so LaunchServices picks up the URL scheme
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_DIR"

echo "✓ Installed cs-spawn, cs-stop, cs-api to $INSTALL_DIR/"
echo "✓ Registered codeserver:// URL scheme via $APP_DIR"
echo "✓ Session API daemon running on 127.0.0.1:19377"
echo ""
echo "Chrome bookmark URL format:"
echo "  codeserver://open?repo=/Users/sam/code/my-repo"
echo ""
echo "Test it:"
echo "  open 'codeserver://open?repo=/Users/sam/code/my-repo'"
