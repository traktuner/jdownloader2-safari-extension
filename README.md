# JDownloader 2 — Safari Extension (personal, unofficial port)

A Safari port of the MyJDownloader browser extension, for **personal use**.

> **Unofficial — not made by AppWork GmbH.** A Safari port of the
> MyJDownloader browser extension. MyJDownloader and JDownloader are products
> and trademarks of AppWork GmbH, and all rights to the original extension are
> theirs. Shared for personal/community use only — not for promotion or sale.

## What was changed for Safari

The original extension relies on Chrome/Firefox features Safari handles
differently. The Safari-specific fixes:

- **Click'n'Load** without blocking `webRequest` (Safari has none): a page-world
  hook (`contentscripts/cnlCaptureContentscript.js`) captures the CnL payload
  (`crypted`, `jk`, …) before it hits the network and the background packages it
  into a `dummycnl.jdownloader.org` link, added to the device over the https
  MyJDownloader cloud API. Also sidesteps Safari's mixed-content block of
  `https → http://127.0.0.1:9666`.
- `vendor/js/jdapi.js`: added the `safari-web-extension:` protocol to the API
  root init (otherwise every API call failed) and replaced an
  `Object.create(null)` passed to `chrome.storage.local.set` with `{}` (Safari
  rejects prototype-less objects, which broke session persistence / login).
- Login form: proper `autocomplete` hints for native AutoFill.

## Install on a new Mac (personal Homebrew tap)

Requirements: macOS 14 Sonoma or later, Safari and Homebrew. Releases from v1.2.0
are signed with Developer ID and notarized by Apple, so no Xcode, certificate or
Safari developer setting is needed on the Mac that installs them.

```sh
brew install --cask traktuner/tap/jdownloader2-safari
```

1. Open **MyJDownloader** from Applications and log in with your MyJDownloader
   account. Enable **Start at login** if you want native Click'n'Load.
2. In **Safari → Settings → Extensions**, enable MyJDownloader and allow it on
   all websites (Click'n'Load, link capture and CAPTCHA integration need this).
3. Log in through the Safari extension popup and select your JDownloader device.

A notarized build keeps running after the signing certificate or the Apple
membership expires. See Apple's [distribution guide](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension).

## Menu bar companion

The menu bar app shows the selected device's state (running, paused, stopped),
speed, progress and remaining time, and provides start/resume, pause and stop.
It polls the device only while its panel is open. Its login is separate from
Safari's login. Credentials saved by the native app use the macOS Keychain;
unfinished Safari login input stays only in background-page memory for up to
five minutes.

### Native Click'n'Load (127.0.0.1:9666)

While it runs, the app answers Click'n'Load on `127.0.0.1:9666` like a local
JDownloader (`/jdcheck.js`, `/crossdomain.xml`, `/flash/add`,
`/flash/addcrypted2`, `/flash/addcrypted`) and sends the links to the device
selected in the app. This covers what the extension's page hooks cannot see:
`<script src>` detection, navigations, popups, frames and strict-CSP pages. The
extension still handles captured requests first. When the extension is logged
out or its Click'n'Load setting is off, it lets the original request through to
this port. The port listens on loopback only. If a local JDownloader already
uses port 9666, the app reports that and JDownloader handles Click'n'Load itself.

Safari Click'n'Load sent by the extension applies the extension's default
options (autostart, auto extract, priority, deep decrypt, packagizer) and its
preferred device.

## Upstream baseline

On 2026-09-08 the [official MyJDownloader downloads page](https://my.jdownloader.org/apps/)
still linked a Firefox package whose manifest is version **3.3.20**, matching
this port. Its bundled jQuery 3.6.0 and AngularJS 1.8.2 also match this repository.
The archive's HTTP modification date alone does not establish a newer source
build. This port retains the original UI stack and Safari-compatible manifest
v2; a third-party Chrome manifest-v3 rewrite is not treated as an official update.
Matching the original extension does not mean these legacy libraries are the
latest independently available versions.

## Build

Building from source requires Xcode with the macOS SDK. The shared build script
produces an ad-hoc-signed universal app for Apple silicon and Intel:

```sh
bash scripts/build.sh
open build/Build/Products/Release/MyJDownloader.app
```

Use `MYJD_BUILD_DIR` to keep build output on a local disk if the checkout is on a
network volume. `MYJD_VERSION` overrides the default app version (three numeric
components). The upstream browser-extension version in `buildMeta.json` is tracked
separately from the Safari wrapper version.

## Release (Developer ID + notarization)

CI builds pull requests and `main` ad-hoc. A tag `vX.Y.Z` runs
`scripts/release.sh` on GitHub Actions: Developer ID signature with secure
timestamp, notarization through `notarytool`, stapling, and a GitHub Release
with `MyJDownloader.zip`. The job summary prints the cask `version`/`sha256`.

Repository secrets (same names as in encrypted-memories):

| Secret | Content |
| --- | --- |
| `APPLE_SIGNING_CERTIFICATES_P12_BASE64` | base64 of the `.p12` export of the **Developer ID Application** certificate with its private key |
| `APPLE_SIGNING_CERTIFICATES_PASSWORD` | password of that `.p12` |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect API issuer ID |
| `APP_STORE_CONNECT_KEY_ID` | API key ID (team key) |
| `APP_STORE_CONNECT_PRIVATE_KEY_BASE64` | base64 of `AuthKey_<id>.p8` |

An Apple Development or Apple Distribution certificate cannot replace the
Developer ID Application certificate. A release reaches Homebrew users only
after the cask's `version` and `sha256` point to that exact ZIP.

Focused regression tests (Node.js, no packages to install):

```sh
node --test tests/extension.test.cjs
```

## Signing failure in older casks

Older casks selected the first `Apple Development` identity by display name.
A revoked certificate produced `CSSMERR_TP_CERT_REVOKED` and macOS moved the app
to the Trash. Multiple certificates with the same name also made signing
ambiguous, and unchecked signing failures allowed installation to continue.
The certificate-free cask removes that dependency and fails on verification errors.
Do not disable Gatekeeper or XProtect globally to repair an older installation.

For supported Click'n'Load transports and remaining browser restrictions, see the
[link-crypter compatibility matrix](docs/CNL-COMPATIBILITY.md). Compatibility
with standard CNL2 does not imply support for every crypter.
