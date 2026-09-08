#!/bin/bash
# Reproducible personal-use build: no Apple account or signing certificate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${MYJD_BUILD_DIR:-$ROOT/build}"
VERSION="${MYJD_VERSION:-1.1.0}"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "MYJD_VERSION must contain three numeric components (for example 1.1.0)." >&2
  exit 1
fi

xcodebuild \
  -project "$ROOT/MyJDownloader.xcodeproj" \
  -scheme MyJDownloader \
  -configuration Release \
  -derivedDataPath "$BUILD_DIR" \
  -destination 'generic/platform=macOS' \
  'ARCHS=arm64 x86_64' ONLY_ACTIVE_ARCH=NO \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
  PROVISIONING_PROFILE_SPECIFIER= \
  "MARKETING_VERSION=$VERSION" "CURRENT_PROJECT_VERSION=$VERSION"

APP="$BUILD_DIR/Build/Products/Release/MyJDownloader.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
/usr/bin/lipo "$APP/Contents/MacOS/MyJDownloader" -verify_arch arm64 x86_64
/usr/bin/lipo "$APP/Contents/PlugIns/MyJDownloader Extension.appex/Contents/MacOS/MyJDownloader Extension" -verify_arch arm64 x86_64
echo "Built: $APP"
