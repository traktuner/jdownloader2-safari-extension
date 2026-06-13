# JDownloader 2 — Safari Extension (personal, unofficial port)

A Safari port of the MyJDownloader browser extension, for **personal use**.

> **Not affiliated with AppWork GmbH.** This is a private, personal
> interoperability port of the official MyJDownloader extension so it runs in
> Safari. The original extension and the MyJDownloader / JDownloader names and
> assets belong to AppWork GmbH. Do not publish or redistribute this.

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

## Build

```sh
xcodebuild -project MyJDownloader.xcodeproj -scheme MyJDownloader \
  -configuration Release -derivedDataPath build
```

CI (`.github/workflows/build.yml`) builds an **ad-hoc** signed `.app` on every
push and attaches a zip to the release on tags (`vX.Y.Z`). The Homebrew cask in
the personal tap re-signs it locally with an Apple Development certificate so
Safari accepts it without "Allow Unsigned Extensions".

## Install (personal Homebrew tap)

```sh
brew install --cask <your-tap>/jdownloader2-safari
```

Then enable the extension in **Safari → Settings → Extensions** and allow it on
all websites. Log in once with your MyJDownloader account.
