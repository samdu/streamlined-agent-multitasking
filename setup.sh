#!/bin/bash
# setup.sh - Install cs-spawn and register the codeserver:// URL scheme
set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
APP_DIR="${HOME}/Applications/CodeServerSpawn.app"

mkdir -p "$INSTALL_DIR"

# --- Install the spawn script ---
cp cs-spawn.sh "$INSTALL_DIR/cs-spawn"
chmod +x "$INSTALL_DIR/cs-spawn"

# --- Ensure it's on PATH ---
if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
  echo ""
  echo "⚠  Add $INSTALL_DIR to your PATH if not already:"
  echo "   export PATH=\"$INSTALL_DIR:\$PATH\""
  echo ""
fi

# --- Create macOS app bundle for codeserver:// URL scheme ---
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Info.plist registers the URL scheme
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>zone.hexagon.codeserverspawn</string>
  <key>CFBundleName</key>
  <string>CodeServerSpawn</string>
  <key>CFBundleExecutable</key>
  <string>handler</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>Code Server Spawn</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>codeserver</string>
      </array>
    </dict>
  </array>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
PLIST

# The handler script parses the URL and calls cs-spawn
cat > "$APP_DIR/Contents/MacOS/handler" << 'HANDLER'
#!/bin/bash
# Receives: codeserver://open?repo=/path/to/repo
# Also supports: codeserver:///path/to/repo (path in authority+path)

URL="$1"
if [ -z "$URL" ]; then
  exit 1
fi

# Extract repo path from URL
# Try ?repo= param first
REPO=$(echo "$URL" | sed -n 's/.*[?&]repo=\([^&]*\).*/\1/p' | python3 -c "import sys,urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))")

# Fallback: treat path portion as the repo path
if [ -z "$REPO" ]; then
  REPO=$(echo "$URL" | sed 's|^codeserver://||' | sed 's|^open||' | sed 's|?.*||' | python3 -c "import sys,urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))")
fi

if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
  osascript -e "display alert \"cs-spawn\" message \"Invalid repo path: $REPO\""
  exit 1
fi

"${HOME}/.local/bin/cs-spawn" "$REPO"
HANDLER

chmod +x "$APP_DIR/Contents/MacOS/handler"

# --- Register the URL scheme ---
# Touch the app to trigger LaunchServices re-scan
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_DIR"

echo "✓ Installed cs-spawn to $INSTALL_DIR/cs-spawn"
echo "✓ Registered codeserver:// URL scheme via $APP_DIR"
echo ""
echo "Chrome bookmark URL format:"
echo "  codeserver://open?repo=/Users/sam/code/my-repo"
echo ""
echo "Test it:"
echo "  open 'codeserver://open?repo=/Users/sam/code/my-repo'"
