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
 * The hook is injected INLINE and synchronously at document_start so it runs
 * before any page script (e.g. filecrypt's helper.html which sets
 * `jdownloader = false` and only submits the CnL form if jdownloader is true).
 */
(function () {
  "use strict";
  if (typeof browser !== "undefined") { try { chrome = browser; } catch (e) {} }

  // ---- page-world hook (stringified & injected; runs in the page) ----------
  function pageHook() {
    "use strict";
    if (window.__myjdCnlHookInstalled) return;
    window.__myjdCnlHookInstalled = true;
    var TAG = "[MyJD-CnL]";
    var MARKER = "myjd-cnl-capture";

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

    function isCnlUrl(url) {
      try {
        var parsed = new URL(String(url), location.href);
        return parsed.protocol === "http:" && !parsed.username && !parsed.password &&
          (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
          parsed.port === "9666" && /^\/flash\/add(?:crypted2?)?\/?$/.test(parsed.pathname);
      } catch (e) { return false; }
    }
    function isCrypted(url) { return String(url).indexOf("/flash/addcrypted") !== -1; }

    function bodyToObject(body) {
      var out = {};
      try {
        if (!body) return out;
        if (typeof body === "string") {
          new URLSearchParams(body).forEach(function (v, k) { out[k] = v; });
        } else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
          body.forEach(function (v, k) { out[k] = v; });
        } else if (typeof FormData !== "undefined" && body instanceof FormData) {
          body.forEach(function (v, k) { if (typeof v === "string") out[k] = v; });
        } else if (typeof body === "object") {
          Object.keys(body).forEach(function (k) { out[k] = body[k]; });
        }
      } catch (e) {}
      return out;
    }
    function formToObject(form) {
      // FormData follows browser rules for disabled and unchecked controls.
      return bodyToObject(new FormData(form));
    }
    var nextRequestId = 1;
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
      if (!formData || Object.keys(formData).length === 0) {
        return Promise.reject(new Error("Empty Click'n'Load payload"));
      }
      return new Promise(function (resolve, reject) {
        var requestId = "cnl-" + Date.now() + "-" + (nextRequestId++);
        pendingRequests[requestId] = {
          resolve: resolve,
          reject: reject,
          timeout: setTimeout(function () {
            delete pendingRequests[requestId];
            reject(new Error("MyJDownloader request timed out"));
          }, 20000)
        };
        window.postMessage({
          __myjd: MARKER, requestId: requestId, url: location.href, cnlUrl: new URL(String(url), location.href).href,
          crypted: isCrypted(url), formData: formData
        }, "*");
        console.info(TAG, "captured Click'n'Load payload:", Object.keys(formData).join(", "));
      });
    }

    // fetch
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          var url = (typeof input === "string" || input instanceof URL) ? String(input) : (input && input.url);
          if (isCnlUrl(url)) {
            var body = init && init.body !== undefined ? Promise.resolve(init.body) :
              (typeof Request !== "undefined" && input instanceof Request ?
                (/^multipart\/form-data/i.test(input.headers.get("content-type") || "") ? input.clone().formData() : input.clone().text()) :
                Promise.resolve(null));
            return body.then(function (value) { return send(url, bodyToObject(value)); })
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
        this.__myjdUrl = url; this.__myjdIsCnl = isCnlUrl(url);
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        if (this.__myjdIsCnl) {
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
            responseBody = ok ? "success" : "error: " + ((error && error.message) || error || "unknown error");
            try { xhr.dispatchEvent(new Event("readystatechange")); } catch (e) {}
            try { xhr.dispatchEvent(new Event("load")); } catch (e) {}
            try { xhr.dispatchEvent(new Event("loadend")); } catch (e) {}
          };
          send(this.__myjdUrl, bodyToObject(body)).then(function () {
            finish(true);
          }).catch(function (error) {
            finish(false, error);
          });
          return;
        }
        return origSend.apply(this, arguments);
      };
    }

    // form submit (programmatic .submit() and submit events)
    function showFormResult(ok, error) {
      var message = ok ? "success" : "MyJDownloader error: " + ((error && error.message) || error || "unknown error");
      try {
        document.open();
        document.write("<!doctype html><meta charset=\"utf-8\"><title>MyJDownloader</title><pre style=\"font:16px system-ui;padding:24px;white-space:pre-wrap\"></pre>");
        document.close();
        document.querySelector("pre").textContent = message;
      } catch (e) {}
    }
    function handleForm(form) {
      try {
        if (form && isCnlUrl(form.action)) {
          send(form.action, formToObject(form)).then(function () {
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
      if (handleForm(ev.target)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    }, true);
    if (window.HTMLFormElement && HTMLFormElement.prototype) {
      var origSubmit = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function () {
        if (handleForm(this)) return;
        return origSubmit.apply(this, arguments);
      };
    }

    // navigator.sendBeacon
    if (navigator && navigator.sendBeacon) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        if (isCnlUrl(url)) {
          send(url, bodyToObject(data)).catch(function (error) {
            console.error(TAG, error);
          });
          return true;
        }
        return origBeacon(url, data);
      };
    }

    console.info(TAG, "page hook installed");
  }

  // Inject synchronously, before page scripts run.
  try {
    var s = document.createElement("script");
    s.textContent = "(" + pageHook.toString() + ")();";
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (e) {
    console.error("[MyJD-CnL] could not inject page hook:", e);
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
