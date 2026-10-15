# Link-crypter compatibility

Support is based on the protocol a page uses, not a list of domain names.
The extension forwards captured Click'n'Load data to the selected JDownloader
device. JDownloader's plugins perform the actual link decryption. A successful
submission acknowledgment does not prove that every link subsequently decrypts
or downloads successfully.

## Original Chrome comparison

The official Chrome package 3.3.20 (`update_url` clients2.google.com, Web Store
`_metadata`) is unpacked next to this repository in `../../extension`, with the
archive `../../myjd.crx`. The Safari resources were derived from it. The
original intercepts Click'n'Load at network level with blocking `webRequest`:
every request to `127.0.0.1:9666` or `localhost:9666` for `/jdcheck.js`,
`/crossdomain.xml`, `/flash/add` and `/flash/addcrypted2`, from any transport,
frame or popup. Support therefore never depended on a crypter list.

Safari has no blocking `webRequest`. Parity is reached in two layers:

1. The extension's page hooks capture fetch/XHR/form/sendBeacon submissions and
   send them through the MyJDownloader cloud API.
2. The MyJDownloader app answers the same routes on `127.0.0.1:9666` like a
   local JDownloader and catches every request that reaches the network. This
   includes `<script src=".../jdcheck.js">`, navigations, popups, frames and
   strict-CSP pages. The extension passes requests through to it while the
   extension is logged out or its Click'n'Load setting is off.

The native layer requires the app to run (Start at login) and to be logged in.
In Safari the original blocking interceptor is not registered as an observer:
as an observer it closed the cryptor tab and opened an empty toolbar.

## Development support matrix

This table describes the current source changes after v1.1.0; it does not imply
that the installed v1.1.0 already contains them.

| Page behavior | Current implementation and evidence |
| --- | --- |
| Plain CNL2: /flash/add, urls | Captured and forwarded; regression tested |
| Encrypted CNL2: /flash/addcrypted2, crypted + jk/key | Raw fields forwarded to JDownloader; regression tested with fixture data |
| fetch, Request, URL-encoded and multipart bodies | Captured; regression tested |
| XHR | Waits for the actual add-links acknowledgment; regression tested |
| URL query fields | Combined with body fields; explicit body fields take precedence |
| sendBeacon, including Blob bodies | Captured; its immediate boolean only means queued, not device success |
| DOM submit event, including requestSubmit() | Isolated-world fallback handles it even when inline page scripts are blocked |
| form.submit() | Page-world hook required because this API emits no submit event |
| Alternative submit button action | Honors formaction and includes the submitter's name/value |
| /jdcheck.js using fetch/XHR | Answers the standard detection response; no download is sent |
| Parser/dynamic script loading of jdcheck.js | Answered by the app's native port; page hook additionally sets the jdownloader global |
| Strict CSP with script-only fetch/XHR submission | Page hook can be blocked; the request then reaches the app's native port (if the page CSP allows 127.0.0.1) |
| Helper frames | Manifest requests all frames; real site-specific frame/permission behavior still needs testing |
| Legacy CNL1 /flash/addcrypted (DLC) | Native port forwards it via linkgrabberv2/addContainer; not verified against a live site |
| CCF/RSDF files, custom APIs or URL schemes | No blanket compatibility claim |
| CAPTCHA solving and decrypted links | Separate JDownloader/site/browser acceptance required |

The official [CNL2 documentation](https://jdownloader.org/knowledge/wiki/glossary/cnl2)
defines the standard form fields and detection routes. Proprietary site APIs and
CAPTCHA workflows need their own validation. No assertion that all link-crypters
work is justified by protocol fixtures alone.

## Validation boundaries

Node tests exercise the actual content script with separate page/isolated
globals and a mocked extension/background acknowledgment. A separate local
WebKit fixture uses real HTTP Content Security Policy headers and mocked
extension messaging; its runtime results must be reported separately from
Safari extension installation and live JDownloader link delivery.

Real site acceptance should record the service, Safari/macOS version, granted
site/frame permissions, login/device state, submission transport and whether
JDownloader actually received and decrypted the test links. Do not put private
container URLs, account credentials or decrypted links in public reports.

On 2026-09-08 the development patch passed 14 Node regressions, seven real-WebKit
fixture scenarios, JavaScript syntax/whitespace checks and the universal Release
build with successful signature validation. The WebKit scenarios include a
baseline strict-CSP scripted-fetch failure (expected), current strict-CSP form
capture, capture despite page stopPropagation, and single delivery with both
worlds active. A separate WKUserScript MAIN-world scenario is experimental test
infrastructure, not an implemented Safari extension scripting API. Build output
contained AppIntents metadata warnings and an embedded-resource parsing warning
for selectionContentscript.js; build and signature validation still succeeded.

Local evidence: /Users/thomas/Developer/builds/myjd-safari/chrome-comparison/
(FINAL-VERIFICATION.md, tests-final.log, webkit-fixtures/result-final.log,
build-final.log). The installed Brew v1.1.0 was not replaced for these checks.
Onyx search and write tools were unavailable; shared knowledge persistence is
pending, with reusable constraints recorded in PROJECT-TRAPS.md.
