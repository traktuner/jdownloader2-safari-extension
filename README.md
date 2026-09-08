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

Requirements: macOS 14 Sonoma or later, Safari and Homebrew. No Xcode, Apple
account, development certificate or paid Apple membership is required to run the
prebuilt app.

```sh
brew install --cask traktuner/tap/jdownloader2-safari
```

If an older installation was moved to the Trash, use `brew reinstall --cask
traktuner/tap/jdownloader2-safari` after the updated cask and release are available.

This personal build is **not notarized**. The cask checks the release checksum
and bundle signature, signs the app and its embedded extension locally with an
ad-hoc signature, verifies both, and removes quarantine **only from this app**.
It never selects a certificate from your keychain or changes global Gatekeeper
settings. Install this personal cask only if you trust this repository and tap.

1. Open **MyJDownloader** from Applications.
2. In **Safari → Settings → Advanced**, enable **Show features for web developers**.
3. In **Safari → Settings → Developer**, enable **Allow unsigned extensions**.
4. In **Safari → Settings → Extensions**, enable MyJDownloader and allow it on the
   websites where you use Click'n'Load, link capture or CAPTCHA integration.
5. Log in through the Safari extension popup and select your JDownloader device.

Safari can require the unsigned-extension setting to be enabled again after
quitting. Ad-hoc signing does not provide the trust of a Developer ID signature.
For a download that avoids this developer setup, the publisher needs Developer
ID signing and Apple notarization; users installing that release do not need an
Apple subscription. The certificate-free build remains available for personal use.
See Apple's [building and testing guide](https://developer.apple.com/documentation/safariservices/building-and-testing-a-safari-web-extension)
and [distribution guide](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension).

## Menu bar companion

The menu bar app displays device speed and provides start, pause and stop
controls. Its login is separate from Safari's login. Credentials saved by the
native app use the macOS Keychain; unfinished Safari login input stays only in
background-page memory for up to five minutes.

The container app does not need to remain open for adding links. Safari runs the
extension background page and sends links to JDownloader through the MyJDownloader
API. Keep the container app open only when using the menu bar controls.

## Upstream baseline

On 2026-09-08 the [official MyJDownloader downloads page](https://my.jdownloader.org/apps/)
still linked a Firefox package whose manifest is version **3.3.20**, matching
this port. Its bundled jQuery 3.6.0 and AngularJS 1.8.2 also match this repository.
The archive's HTTP modification date alone does not establish a newer source
build. This port retains the original UI stack and Safari-compatible manifest
v2; a third-party Chrome manifest-v3 rewrite is not treated as an official update.
Matching the original extension does not mean these legacy libraries are the
latest independently available versions.

## Build without an Apple subscription

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

CI runs the same script for pull requests and pushes. Tags (`vX.Y.Z`) publish a
ZIP on GitHub Releases. A release is not installed through Homebrew until the
cask's version and SHA256 point to that exact ZIP.

Focused regression tests (Node.js, no packages to install):

```sh
node --test tests/extension.test.cjs
```

They exercise CnL routing/body capture/acknowledgments, popup draft isolation and
expiry, and the native API handshake/logout contract. Real Safari login, CAPTCHA
pages and link delivery still need a browser and an actual JDownloader device.

## Signing failure in older casks

Older casks selected the first `Apple Development` identity by display name.
A revoked certificate produced `CSSMERR_TP_CERT_REVOKED` and macOS moved the app
to the Trash. Multiple certificates with the same name also made signing
ambiguous, and unchecked signing failures allowed installation to continue.
The certificate-free cask removes that dependency and fails on verification errors.
Do not disable Gatekeeper or XProtect globally to repair an older installation.
