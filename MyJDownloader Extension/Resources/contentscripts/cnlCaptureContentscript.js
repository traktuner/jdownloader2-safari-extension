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
 *      background feeds it into the normal requestQueue + toolbar + addLinks
 *      pipeline (sent to JDownloader over the https MyJDownloader cloud API).
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
      if (!url) return false;
      url = String(url);
      return (url.indexOf("127.0.0.1:9666/flash/add") !== -1) ||
             (url.indexOf("localhost:9666/flash/add") !== -1);
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
      var out = {};
      try {
        var els = form.elements;
        for (var i = 0; i < els.length; i++) {
          if (els[i] && els[i].name) out[els[i].name] = els[i].value;
        }
      } catch (e) {}
      return out;
    }
    function send(url, formData) {
      if (!formData || Object.keys(formData).length === 0) return;
      try {
        window.postMessage({
          __myjd: MARKER, url: location.href, cnlUrl: String(url),
          crypted: isCrypted(url), formData: formData
        }, "*");
        console.info(TAG, "captured Click'n'Load payload:", Object.keys(formData).join(", "));
      } catch (e) {}
    }

    // fetch
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          var url = (typeof input === "string") ? input : (input && input.url);
          if (isCnlUrl(url)) {
            send(url, bodyToObject((init && init.body) || (input && input.body)));
            return Promise.resolve(new Response("success", { status: 200 }));
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
          send(this.__myjdUrl, bodyToObject(body));
          var xhr = this;
          try {
            Object.defineProperty(xhr, "readyState", { configurable: true, get: function () { return 4; } });
            Object.defineProperty(xhr, "status", { configurable: true, get: function () { return 200; } });
            Object.defineProperty(xhr, "responseText", { configurable: true, get: function () { return "success"; } });
            Object.defineProperty(xhr, "response", { configurable: true, get: function () { return "success"; } });
          } catch (e) {}
          setTimeout(function () {
            try { if (typeof xhr.onreadystatechange === "function") xhr.onreadystatechange(); } catch (e) {}
            try { xhr.dispatchEvent(new Event("readystatechange")); } catch (e) {}
            try { xhr.dispatchEvent(new Event("load")); } catch (e) {}
            try { xhr.dispatchEvent(new Event("loadend")); } catch (e) {}
          }, 0);
          return;
        }
        return origSend.apply(this, arguments);
      };
    }

    // form submit (programmatic .submit() and submit events)
    function handleForm(form) {
      try {
        if (form && isCnlUrl(form.action)) { send(form.action, formToObject(form)); return true; }
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
        if (isCnlUrl(url)) { send(url, bodyToObject(data)); return true; }
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
    if (!d || d.__myjd !== "myjd-cnl-capture" || !d.formData) return;
    try {
      chrome.runtime.sendMessage({
        name: "myjd-cnl-capture",
        action: "captured",
        data: { url: d.url, cnlUrl: d.cnlUrl, crypted: d.crypted, formData: d.formData }
      });
    } catch (e) {
      console.error("[MyJD-CnL] relay to background failed:", e);
    }
  }, false);
})();
