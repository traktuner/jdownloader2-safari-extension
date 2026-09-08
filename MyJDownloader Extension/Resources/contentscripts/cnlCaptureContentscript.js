/*
 * MyJDownloader – Safari Click'n'Load capture content script.
 *
 * Safari has no blocking webRequest and blocks HTTPS->http://127.0.0.1:9666 as
 * mixed content, so the original interception path is dead. Instead we inject a
 * hook into the *page* world that:
 *   1. pretends a local JDownloader is present (window.jdownloader = true) so
 *      crypter pages / helper popups run their submit logic, and
 *   2. captures the Click'n'Load payload (crypted, jk, source, ...) from the
 *      fetch / XHR / form submit the page makes to 127.0.0.1:9666 and posts it
 *      back to this content script, which relays it to the background. The
 *      background refreshes the live device list and calls addLinks through
 *      the HTTPS MyJDownloader cloud API, then acknowledges the actual result.
 *
 * The legacy page-world hook is injected inline as soon as a document root is
 * available. Strict page CSP can block it; a separate isolated-world DOM form
 * listener still handles ordinary submit events. Programmatic form.submit()
 * and page fetch/XHR calls require the page-world hook. See docs/CNL-COMPATIBILITY.md.
 */
(function () {
  "use strict";
  if (typeof browser !== "undefined") { try { chrome = browser; } catch (e) {} }

  // ---- page-world hook (stringified & injected; runs in the page) ----------
  function pageHook(formsOnly) {
    "use strict";
    if (window.__myjdCnlHookInstalled) return;
    window.__myjdCnlHookInstalled = true;
    var TAG = "[MyJD-CnL]";
    var MARKER = "myjd-cnl-capture";

    // The isolated-world fallback only handles DOM form events. It must not
    // change globals or network APIs used by other extension content scripts.
    if (!formsOnly) {
      // Pretend JDownloader is present so crypter pages enable/submit CnL.
      try {
        Object.defineProperty(window, "jdownloader", {
          configurable: true,
          get: function () { return true; },
          set: function () { /* ignore page attempts to reset to false */ }
        });
      } catch (e) {
        try { window.jdownloader = true; } catch (e2) {}
      }

      var POP_W = 640, POP_H = 480;
      function centeredFeatures() {
        var left = Math.max(0, Math.round(((screen && screen.availWidth || 1280) - POP_W) / 2));
        var top = Math.max(0, Math.round(((screen && screen.availHeight || 800) - POP_H) / 2));
        return "width=" + POP_W + ",height=" + POP_H + ",left=" + left + ",top=" + top + ",resizable=yes,scrollbars=yes";
      }

      // (a) Container side: filecrypt opens the CnL helper with window.open(...,'CNL',...).
      // Safari ignores its size, so force a sane size on the call itself.
      try {
        var origWinOpen = window.open;
        if (origWinOpen) {
          window.open = function (url, name, features) {
            try {
              if (name === "CNL" || /helper\.html|\/_?cnl\//i.test(String(url || ""))) {
                features = centeredFeatures();
              }
            } catch (e) {}
            return origWinOpen.call(window, url, name, features);
          };
        }
      } catch (e) {}

      // (b) Popup side: if we ARE the CnL helper popup, shrink/center ourselves
      // (covers the case where Safari ignored the window.open size above).
      try {
        if (window.opener && (window.name === "CNL" || /helper\.html/i.test(location.pathname))) {
          var doResize = function () {
            try {
              window.resizeTo(POP_W, POP_H);
              window.moveTo(Math.max(0, Math.round(((screen.availWidth) - POP_W) / 2)),
                            Math.max(0, Math.round(((screen.availHeight) - POP_H) / 2)));
            } catch (e) {}
          };
          doResize();
          setTimeout(doResize, 0);
          setTimeout(doResize, 250);
        }
      } catch (e) {}

    }

    function localEndpoint(url) {
      try {
        var parsed = new URL(String(url), document.baseURI || location.href);
        if (parsed.protocol === "http:" && !parsed.username && !parsed.password &&
          (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
          parsed.port === "9666") return parsed;
      } catch (e) {}
      return null;
    }
    function isCnlUrl(url) {
      var parsed = localEndpoint(url);
      return !!parsed && /^\/flash\/add(?:crypted2?)?\/?$/.test(parsed.pathname);
    }
    function isProbe(url) {
      var parsed = localEndpoint(url);
      return !!parsed && parsed.pathname === "/jdcheck.js";
    }
    function put(out, key, value) {
      // Preserve even hostile field names as data for background validation.
      Object.defineProperty(out, key, {value: value, enumerable: true, configurable: true, writable: true});
    }

    function bodyToObject(body) {
      var out = {};
      try {
        if (!body) return out;
        if (typeof body === "string") {
          new URLSearchParams(body).forEach(function (v, k) { put(out, k, v); });
        } else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
          body.forEach(function (v, k) { put(out, k, v); });
        } else if (typeof FormData !== "undefined" && body instanceof FormData) {
          body.forEach(function (v, k) { if (typeof v === "string") put(out, k, v); });
        } else if (typeof body === "object") {
          Object.keys(body).forEach(function (k) { put(out, k, body[k]); });
        }
      } catch (e) {}
      return out;
    }
    function formToObject(form, submitter) {
      // FormData follows browser rules for disabled and unchecked controls.
      var data = bodyToObject(new FormData(form));
      if (submitter && submitter.name && !submitter.disabled) put(data, submitter.name, submitter.value);
      return data;
    }
    var nextRequestId = 1;
    var contextId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    var pendingRequests = {};

    window.addEventListener("message", function (ev) {
      if (ev.source !== window) return;
      var d = ev.data;
      if (!d || d.__myjd !== "myjd-cnl-result" || !d.requestId) return;
      var pending = pendingRequests[d.requestId];
      if (!pending) return;
      delete pendingRequests[d.requestId];
      clearTimeout(pending.timeout);
      if (d.ok) pending.resolve(d);
      else pending.reject(new Error(d.error || "MyJDownloader rejected the request"));
    }, false);

    function send(url, formData) {
      var parsed = localEndpoint(url);
      if (!parsed || !isCnlUrl(url)) return Promise.reject(new Error("Invalid Click'n'Load endpoint"));
      // Some clients send fields in the URL, others in a POST body. Preserve
      // both; an explicit body value takes precedence over the query string.
      var combined = bodyToObject(parsed.searchParams);
      Object.keys(formData || {}).forEach(function (key) { put(combined, key, formData[key]); });
      formData = combined;
      if (!formData || Object.keys(formData).length === 0) {
        return Promise.reject(new Error("Empty Click'n'Load payload"));
      }
      return new Promise(function (resolve, reject) {
        var requestId = "cnl-" + contextId + "-" + (nextRequestId++);
        pendingRequests[requestId] = {
          resolve: resolve,
          reject: reject,
          timeout: setTimeout(function () {
            delete pendingRequests[requestId];
            reject(new Error("MyJDownloader request timed out"));
          }, 20000)
        };
        window.postMessage({
          __myjd: MARKER, requestId: requestId, url: location.href, cnlUrl: parsed.href,
          crypted: parsed.pathname.indexOf("/flash/addcrypted") === 0, formData: formData
        }, "*");
        console.info(TAG, "captured Click'n'Load payload:", Object.keys(formData).join(", "));
      });
    }

    function readBody(body) {
      if (typeof Blob !== "undefined" && body instanceof Blob) {
        return (/^multipart\/form-data/i.test(body.type) ? new Response(body).formData() : body.text())
          .then(bodyToObject);
      }
      return Promise.resolve(bodyToObject(body));
    }

    if (!formsOnly) {
      // fetch
      var origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function (input, init) {
          try {
            var url = (typeof input === "string" || input instanceof URL) ? String(input) : (input && input.url);
            if (isProbe(url)) return Promise.resolve(new Response("var jdownloader = true;", {
              status: 200, headers: {"Content-Type": "application/javascript"}
            }));
            if (isCnlUrl(url)) {
              var body = init && init.body !== undefined ? Promise.resolve(init.body) :
                (typeof Request !== "undefined" && input instanceof Request ?
                  (/^multipart\/form-data/i.test(input.headers.get("content-type") || "") ? input.clone().formData() : input.clone().text()) :
                  Promise.resolve(null));
              return body.then(readBody).then(function (value) { return send(url, value); })
                .then(function () { return new Response("success", { status: 200 }); })
                .catch(function (error) { return new Response("error: " + error.message, { status: 502 }); });
            }
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
      }

      // XMLHttpRequest
      var XHR = window.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        var origOpen = XHR.prototype.open, origSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url) {
          this.__myjdUrl = url; this.__myjdIsCnl = isCnlUrl(url); this.__myjdIsProbe = isProbe(url);
          return origOpen.apply(this, arguments);
        };
        XHR.prototype.send = function (body) {
          if (this.__myjdIsCnl || this.__myjdIsProbe) {
            var xhr = this;
            var completed = false, responseStatus = 0, responseBody = "";
            try {
              Object.defineProperty(xhr, "readyState", { configurable: true, get: function () { return completed ? 4 : 1; } });
              Object.defineProperty(xhr, "status", { configurable: true, get: function () { return responseStatus; } });
              Object.defineProperty(xhr, "responseText", { configurable: true, get: function () { return responseBody; } });
              Object.defineProperty(xhr, "response", { configurable: true, get: function () { return responseBody; } });
            } catch (e) {}
            var finish = function (ok, error) {
              completed = true;
              responseStatus = ok ? 200 : 502;
              responseBody = ok ? (xhr.__myjdIsProbe ? "var jdownloader = true;" : "success") :
                "error: " + ((error && error.message) || error || "unknown error");
              try { xhr.dispatchEvent(new Event("readystatechange")); } catch (e) {}
              try { xhr.dispatchEvent(new Event("load")); } catch (e) {}
              try { xhr.dispatchEvent(new Event("loadend")); } catch (e) {}
            };
            var response = this.__myjdIsProbe ? Promise.resolve() :
              readBody(body).then(function (data) { return send(xhr.__myjdUrl, data); });
            response.then(function () {
              finish(true);
            }).catch(function (error) {
              finish(false, error);
            });
            return;
          }
          return origSend.apply(this, arguments);
        };
      }
    }

    // form submit (programmatic .submit() and submit events)
    var statusElement;
    function showFormResult(ok, error) {
      var message = ok ? "An JDownloader gesendet." : "MyJDownloader: " + ((error && error.message) || error || "unknown error");
      try {
        if (!statusElement || !statusElement.isConnected) {
          statusElement = document.createElement("div");
          statusElement.id = "myjd-cnl-status-" + contextId;
          statusElement.setAttribute("data-myjd-cnl-status", "");
          statusElement.setAttribute("role", "status");
          statusElement.style.cssText = "position:fixed;bottom:16px;left:16px;right:16px;z-index:2147483647;padding:16px;background:#fff;color:#111;border:1px solid #777;font:16px system-ui;white-space:pre-wrap";
          (document.body || document.documentElement).appendChild(statusElement);
        }
        statusElement.textContent = message;
      } catch (e) {}
    }
    function handleForm(form, submitter) {
      try {
        var action = submitter && submitter.hasAttribute("formaction") ? submitter.formAction : form && form.action;
        if (form && isCnlUrl(action)) {
          send(action, formToObject(form, submitter)).then(function () {
            showFormResult(true);
          }).catch(function (error) {
            showFormResult(false, error);
          });
          return true;
        }
      } catch (e) {}
      return false;
    }
    document.addEventListener("submit", function (ev) {
      // Preserve early capture: page handlers that stop propagation must not
      // send the form to an unreachable loopback endpoint. requestSubmit()
      // emits this event too. defaultPrevented deduplicates the two worlds.
      if (!ev.defaultPrevented && handleForm(ev.target, ev.submitter)) {
        ev.preventDefault(); ev.stopImmediatePropagation();
      }
    }, true);
    if (!formsOnly && window.HTMLFormElement && HTMLFormElement.prototype) {
      var origSubmit = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function () {
        if (handleForm(this)) return;
        return origSubmit.apply(this, arguments);
      };
    }

    // navigator.sendBeacon
    if (!formsOnly && navigator && navigator.sendBeacon) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        if (isCnlUrl(url)) {
          readBody(data).then(function (body) { return send(url, body); }).catch(function (error) {
            console.error(TAG, error);
          });
          return true;
        }
        return origBeacon(url, data);
      };
    }

    console.info(TAG, formsOnly ? "form fallback installed" : "page hook installed");
  }

  // DOM submit events cross isolated worlds and remain available even if the
  // page blocks the legacy inline network hook with Content Security Policy.
  pageHook(true);

  // document_start may precede creation of the root element. Retry as soon as
  // one exists instead of permanently losing the hook on an empty document.
  function injectPageHook() {
    var parent = document.head || document.documentElement;
    if (!parent) return false;
    try {
      var s = document.createElement("script");
      s.textContent = "(" + pageHook.toString() + ")();";
      parent.appendChild(s);
      s.remove();
    } catch (e) {
      console.error("[MyJD-CnL] could not inject page hook:", e);
    }
    return true;
  }
  if (!injectPageHook() && typeof MutationObserver !== "undefined") {
    var rootObserver = new MutationObserver(function () {
      if (injectPageHook()) rootObserver.disconnect();
    });
    rootObserver.observe(document, {childList: true, subtree: true});
  }

  // Relay captured payloads (page world -> content script -> background).
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__myjd !== "myjd-cnl-capture" || !d.formData || typeof d.requestId !== "string") return;
    try {
      chrome.runtime.sendMessage({
        name: "myjd-cnl-capture",
        action: "captured",
        data: { url: location.href, cnlUrl: d.cnlUrl, crypted: d.crypted, formData: d.formData }
      }, function (response) {
        var runtimeError = chrome.runtime.lastError && chrome.runtime.lastError.message;
        window.postMessage({
          __myjd: "myjd-cnl-result",
          requestId: d.requestId,
          ok: !runtimeError && response !== undefined && response.error === undefined,
          error: runtimeError || (response && response.error) || (response === undefined ? "No response from MyJDownloader" : undefined)
        }, "*");
      });
    } catch (e) {
      window.postMessage({__myjd: "myjd-cnl-result", requestId: d.requestId, ok: false,
        error: "Could not contact the MyJDownloader extension"}, "*");
    }
  }, false);
})();
