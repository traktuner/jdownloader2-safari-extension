/* Native app API host. Each login runs in a fresh, nonpersistent WKWebView. */
(function () {
  "use strict";
  var api = null;
  var generation = 0;
  function post(reqId, ok, data) {
    webkit.messageHandlers.jd.postMessage({reqId: reqId, ok: ok, data: data});
  }
  function readable(error) {
    // Do not expose request URLs, encrypted session material or credentials.
    return (error && (error.type || error.message)) || "MyJDownloader request failed";
  }
  function failure(reqId, error) { post(reqId, false, readable(error)); }

  if (typeof requirejs !== "undefined") {
    requirejs.onError = function () { post(-1, false, "Die API-Komponente konnte nicht geladen werden."); };
  }
  window.bridge = {
    connect: function (email, pass, reqId) {
      var current = ++generation;
      if (api) { post(reqId, false, "Already initialized; create a new session first"); return; }
      require(["jdapi"], function (API) {
        if (current !== generation) return;
        try {
          // The bundled constructor initiates authentication itself. Passing
          // arbitrary configuration then calling connect() starts two handshakes.
          var handshake = $.Deferred();
          handshake.done(function () { if (current === generation) post(reqId, true, null); });
          handshake.fail(function (error) { if (current === generation) failure(reqId, error); });
          api = new API({email: email, pass: pass}, handshake, "myjd_webextension_safari");
        } catch (error) { if (current === generation) failure(reqId, error); }
      });
    },
    disconnect: function () {
      generation += 1;
      var previous = api;
      api = null;
      try { localStorage.clear(); } catch (error) {}
      if (previous) {
        try { previous.disconnect().always(function () { try { localStorage.clear(); } catch (error) {} }); }
        catch (error) {}
      }
    },
    listDevices: function (reqId) {
      if (!api) { post(reqId, false, "Not connected"); return; }
      var current = generation;
      try {
        api.listDevices().done(function (result) {
          if (current === generation) post(reqId, true, JSON.stringify(result === undefined ? null : result));
        }).fail(function (error) { if (current === generation) failure(reqId, error); });
      } catch (error) { failure(reqId, error); }
    },
    deviceCall: function (deviceId, action, paramsJson, reqId) {
      if (!api) { post(reqId, false, "Not connected"); return; }
      var current = generation;
      try {
        var params = JSON.parse(paramsJson);
        if (!Array.isArray(params)) throw new Error("Invalid device parameters");
        api.setActiveDevice(deviceId);
        api.send(action, params).done(function (result) {
          if (current === generation) post(reqId, true, JSON.stringify(result === undefined ? null : result));
        }).fail(function (error) { if (current === generation) failure(reqId, error); });
      } catch (error) { failure(reqId, error); }
    }
  };
  post(0, true, "ready");
})();
