#!/bin/bash
# Developer ID release: universal build, signed with "Developer ID Application",
# notarized by Apple and stapled. Output: $MYJD_BUILD_DIR/MyJDownloader.zip
#
# Environment:
#   MYJD_VERSION                        three numeric components (required)
#   MYJD_BUILD_NUMBER                   defaults to the git commit count
#   MYJD_BUILD_DIR                      defaults to ./build
#   APPLE_TEAM_ID                       defaults to 587T3YR252
#   APP_STORE_CONNECT_KEY_ID            notarytool API key ID
#   APP_STORE_CONNECT_ISSUER_ID         notarytool issuer ID
#   APP_STORE_CONNECT_PRIVATE_KEY_PATH  path to the AuthKey_*.p8 file
# The Developer ID Application identity must be in an unlocked keychain.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${MYJD_BUILD_DIR:-$ROOT/build}"
VERSION="${MYJD_VERSION:?MYJD_VERSION is required (for example 1.2.0)}"
BUILD_NUMBER="${MYJD_BUILD_NUMBER:-$(git -C "$ROOT" rev-list --count HEAD)}"
TEAM_ID="${APPLE_TEAM_ID:-587T3YR252}"
: "${APP_STORE_CONNECT_KEY_ID:?}" "${APP_STORE_CONNECT_ISSUER_ID:?}" "${APP_STORE_CONNECT_PRIVATE_KEY_PATH:?}"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "MYJD_VERSION must contain three numeric components (for example 1.2.0)." >&2
  exit 1
fi

xcodebuild \
  -project "$ROOT/MyJDownloader.xcodeproj" \
  -scheme MyJDownloader \
  -configuration Release \
  -derivedDataPath "$BUILD_DIR" \
  -destination 'generic/platform=macOS' \
  'ARCHS=arm64 x86_64' ONLY_ACTIVE_ARCH=NO \
  CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=Developer ID Application" \
  "DEVELOPMENT_TEAM=$TEAM_ID" PROVISIONING_PROFILE_SPECIFIER= \
  OTHER_CODE_SIGN_FLAGS=--timestamp \
  "MARKETING_VERSION=$VERSION" "CURRENT_PROJECT_VERSION=$BUILD_NUMBER" \
  clean build

APP="$BUILD_DIR/Build/Products/Release/MyJDownloader.app"
APPEX="$APP/Contents/PlugIns/MyJDownloader Extension.appex"
ZIP="$BUILD_DIR/MyJDownloader.zip"

# A plain `xcodebuild build` injects com.apple.security.get-task-allow, which
# notarization rejects (archive/export would strip it). Disabling base
# entitlement injection would also drop the sandbox entitlements, so remove only
# this key and re-sign: embedded extension first, then the containing app.
for bundle in "$APPEX" "$APP"; do
  entitlements="$BUILD_DIR/$(basename "$bundle").entitlements.plist"
  /usr/bin/codesign -d --entitlements - --xml "$bundle" > "$entitlements"
  /usr/libexec/PlistBuddy -c 'Delete :com.apple.security.get-task-allow' "$entitlements" 2>/dev/null || true
  /usr/bin/codesign --force --sign "Developer ID Application" --timestamp --options runtime \
    --entitlements "$entitlements" "$bundle"
done

/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
for bundle in "$APP" "$APPEX"; do
  details="$(/usr/bin/codesign -dvv "$bundle" 2>&1)"
  grep -q "^Authority=Developer ID Application: .*($TEAM_ID)$" <<< "$details" || {
    echo "$bundle is not signed with a Developer ID Application identity of team $TEAM_ID:" >&2
    echo "$details" >&2
    exit 1
  }
  grep -q '^Timestamp=' <<< "$details" || { echo "$bundle has no secure timestamp." >&2; exit 1; }
  # Notarization rejects the debugging entitlement Xcode can inject.
  entitlements="$(/usr/bin/codesign -d --entitlements - --xml "$bundle" 2>/dev/null)"
  if grep -q 'get-task-allow' <<< "$entitlements" || ! grep -q 'com.apple.security.app-sandbox' <<< "$entitlements"; then
    echo "$bundle must keep the sandbox and must not carry get-task-allow:" >&2
    echo "$entitlements" >&2
    exit 1
  fi
done
/usr/bin/lipo "$APP/Contents/MacOS/MyJDownloader" -verify_arch arm64 x86_64
/usr/bin/lipo "$APPEX/Contents/MacOS/MyJDownloader Extension" -verify_arch arm64 x86_64

rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" \
  --key "$APP_STORE_CONNECT_PRIVATE_KEY_PATH" \
  --key-id "$APP_STORE_CONNECT_KEY_ID" \
  --issuer "$APP_STORE_CONNECT_ISSUER_ID" \
  --wait --timeout 30m --output-format json | tee "$BUILD_DIR/notarization.json"
grep -q '"status" *: *"Accepted"' "$BUILD_DIR/notarization.json" || {
  echo "Notarization was not accepted. Apple's log:" >&2
  submission_id="$(sed -nE 's/.*"id" *: *"([^"]+)".*/\1/p' "$BUILD_DIR/notarization.json")"
  xcrun notarytool log "$submission_id" \
    --key "$APP_STORE_CONNECT_PRIVATE_KEY_PATH" \
    --key-id "$APP_STORE_CONNECT_KEY_ID" \
    --issuer "$APP_STORE_CONNECT_ISSUER_ID" >&2 || true
  exit 1
}

# Staple so Gatekeeper accepts the app offline, then package the stapled app.
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
/usr/sbin/spctl --assess --type execute --verbose=2 "$APP"
rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
echo "Released: $ZIP"
shasum -a 256 "$ZIP"
