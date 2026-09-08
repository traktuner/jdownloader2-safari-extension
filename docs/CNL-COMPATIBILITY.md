# Link-crypter compatibility

Support is based on the protocol a page uses, not a list of domain names.
The extension forwards captured Click'n'Load data to the selected JDownloader
device. JDownloader's plugins perform the actual link decryption. A successful
submission acknowledgment does not prove that every link subsequently decrypts
or downloads successfully.

## Original Chrome comparison

On 2026-09-08 the official Chrome package could not be retrieved from the
inspected Chrome Web Store/update endpoints. The update service returned no
package, and no installed local original was found. Therefore an actual
Chrome-versus-Safari source comparison was **not completed**. The previously
inspected official Firefox 3.3.20 package is a separate browser target.

[AppWork's explanation](https://support.jdownloader.org/en/knowledgebase/article/unable-to-install-myjdownloader-browser-extension-due-to-the-forced-switch-to-manifestv3)
describes the original extension's Manifest V2 dependency and the limitations
affecting a Chrome Manifest V3 replacement. No unofficial replacement is treated
as the authoritative original.

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
| Parser/dynamic script loading of jdcheck.js | Global jdownloader compatibility hook only; script load/error behavior not guaranteed |
| Strict CSP with script-only fetch/XHR submission | Legacy inline page hook can still be blocked; DOM form fallback does not solve all scripted submissions |
| Helper frames | Manifest requests all frames; real site-specific frame/permission behavior still needs testing |
| Legacy CNL1 /flash/addcrypted, DLC/CCF/RSDF files, custom APIs or URL schemes | No blanket compatibility claim |
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
