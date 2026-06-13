'use strict';

angular.module('myjdWebextensionApp')
    .service('MyjdService', ['$q', '$http', 'ApiErrorService', 'StorageService', 'ExtensionMessagingService',
        function ($q, $http, ApiErrorService, StorageService, ExtensionMessagingService) {

            this.CONNECTION_STATES = {
                CONNECTING: "CONNECTING",
                CONNECTED: "CONNECTED",
                DISCONNECTED: "DISCONNECTED",
                RECONNECTING: "RECONNECTING"
            };

            this.LOCAL_STORAGE_KEY = "jdapi/src/core/core.js";
            this.CREDS_STORAGE_KEY = "myjd_creds";
            var myjdService = this;
            this.api;
            this.lastConnectionState = -1;

            this.isConnected = function () {
                return myjdService.lastConnectionState === 0;
            };

            this.apiStateChanceListener = function (state) {
                if (myjdService.lastConnectionState === state) return;
                console.log("MyjdService: connection state change, new state ", state);
                myjdService.lastConnectionState = state;
                var CONNECTED_STATE = 0;
                var PENDING_STATE = 1;
                var RECONNECT_STATE = 2;
                var DISCONNECTED_STATE = 3;

                if (state === CONNECTED_STATE) {
                    myjdService.apiConnectionObserver.onNext(createObservableValue(myjdService.CONNECTION_STATES.CONNECTED));
                    chrome.runtime.sendMessage({
                        name: "myjd-toolbar",
                        action: "CONNECTION_STATE_CHANGE",
                        data: myjdService.CONNECTION_STATES.CONNECTED
                    }, function () {
                        if (chrome.runtime.lastError != null && chrome.runtime.lastError.message != null) console.log(chrome.runtime.lastError.message);
                    });
                    console.log("MyjdService: connection state change, new state: CONNECTED_STATE");
                } else if (state === RECONNECT_STATE) {
                    myjdService.apiConnectionObserver.onNext(createObservableValue(myjdService.CONNECTION_STATES.RECONNECTING));
                    chrome.runtime.sendMessage({
                        name: "myjd-toolbar",
                        action: "CONNECTION_STATE_CHANGE",
                        data: myjdService.CONNECTION_STATES.RECONNECTING
                    }, function () {
                        if (chrome.runtime.lastError != null && chrome.runtime.lastError.message != null) console.log(chrome.runtime.lastError.message);
                    });
                    console.log("MyjdService: connection state change, new state: RECONNECT_STATE");
                } else if (state === DISCONNECTED_STATE) {
                    myjdService.apiConnectionObserver.onNext(createObservableValue(myjdService.CONNECTION_STATES.DISCONNECTED));
                    ExtensionMessagingService.sendMessage("myjd-toolbar", "CONNECTION_STATE_CHANGE", myjdService.CONNECTION_STATES.DISCONNECTED);
                    ExtensionMessagingService.sendMessage("myjd-toolbar", "session-change", { isLoggedIn: false });
                    console.log("MyjdService: connection state change, new state: DISCONNECTED_STATE");
                } else if (state === PENDING_STATE) {
                    myjdService.apiConnectionObserver.onNext(createObservableValue(myjdService.CONNECTION_STATES.CONNECTING));
                    ExtensionMessagingService.sendMessage("myjd-toolbar", "CONNECTION_STATE_CHANGE", myjdService.CONNECTION_STATES.CONNECTING);
                    console.log("MyjdService: connection state change, new state: PENDING_STATE");
                }
            };

            this.apiConnectionObserver = new Rx.BehaviorSubject();
            this.apiDeviceListObserver = new Rx.BehaviorSubject();

            this.getConnectionObservable = function () {
                return myjdService.apiConnectionObserver;
            };

            this.getDeviceListObservable = function () {
                return myjdService.apiDeviceListObserver;
            };

            function init() {
                // as long as we are using the old API client, we need to push credentials from web extensions storage back to local storage
                try {
                    myjdService.connect();
                } catch (e) {
                }
            }

            init();

            this.disconnect = function () {
                return $q(function (resolve, reject) {
                    myjdService.api.disconnect().done(function () {
                        StorageService.clear();
                        myjdService.api.jdAPICore.options = {};
                        resolve();
                    }).fail(function (error) {
                        StorageService.clear();
                        myjdService.api.jdAPICore.options = {};
                        myjdService.apiConnectionObserver.onNext(createObservableValue(myjdService.CONNECTION_STATES.DISCONNECTED));
                        reject(error);
                    });
                });
            };

            var _connect = function (creds, resolve, reject) {
                myjdService.api.connect(creds).fail(function (e) {
                    myjdService.apiConnectionObserver.onNext(createObservableValue(myjdService.CONNECTION_STATES.DISCONNECTED, ApiErrorService.createApiError(e)));
                    reject(ApiErrorService.createApiError(e));
                }).done(function (data) {
                    if (data && data.sessiontoken && data.regaintoken && data.serverEncryptionToken) {
                        myjdService.apiConnectionObserver.onNext(createObservableValue(myjdService.CONNECTION_STATES.CONNECTED));
                    } else {
                        // already logged in with restored session
                        myjdService.apiConnectionObserver.onNext(createObservableValue(myjdService.CONNECTION_STATES.CONNECTED));
                    }

                    resolve();
                });
            };

            this.connect = function (credentials, forceReinit) {
                return $q(function (resolve, reject) {
                    if (!myjdService.api || credentials !== undefined || forceReinit === true) {
                        require(["jdapi"], function (API) {
                            myjdService.apiConnectionObserver.onNext(createObservableValue(myjdService.CONNECTION_STATES.CONNECTING));
                            myjdService.api = new API({
                                API_ROOT: "https://api.jdownloader.org",
                                APP_KEY: "myjd_webextension_" + createBrowserDebugInfo().browserName.toLowerCase()
                            });
                            window.jdapi = myjdService.api;
                            myjdService.api.addAPIStateChangeListener(myjdService.apiStateChanceListener);
                            var creds = {};
                            if (credentials && credentials.email && credentials.password) {
                                creds = {
                                    email: credentials.email,
                                    pass: credentials.password
                                };
                            }
                            _connect(creds, resolve, reject);
                        }
                        );
                    } else {
                        resolve();
                    }
                });
            };

            this.getDeviceList = function () {
                return $q(function (resolve, reject) {
                    try {
                        var deviceListDef = myjdService.api.listDevices();
                        deviceListDef.fail(function (e) {
                            reject(ApiErrorService.createApiError(e));
                        });
                        deviceListDef.done(function (data) {
                            resolve(createObservableValue(data));
                        });
                    } catch (e) {
                        reject(ApiErrorService.createApiError(e));
                    }
                });
            };

            this.whoami = function () {
                this.api.jdAPICore.getCurrentUser().name;
            };

            this.send = function (deviceId, call, params) {
                this.api.setActiveDevice(deviceId);
                return this.api.send(call, params);
            };

            function createApiCredsObject(data) {
                var result = {
                    email: data.email,
                    deviceSecret: data.deviceEncryptionToken || data.deviceSecret,
                    sessiontoken: data.sessiontoken,
                    regaintoken: data.regaintoken,
                    serverEncryptionToken: data.serverEncryptionToken,
                    deviceEncryptionToken: data.deviceEncryptionToken
                };
                return result;
            }

            function createObservableValue(result, error) {
                return { result: result, error: error };
            }

            this.sendFeedback = function (prefill) {
                var sendFeedbackDef = $.Deferred();
                var prefill = prefill || "";
                $http({
                    method: 'GET',
                    url: '/manifest.json'
                }).then(function successCallback(response) {
                    if (response && response.data) {
                        var manifest = response.data;
                        prefill = "[WEB EXTENSION] Version " + manifest.version + "\n" + prefill;
                    } else {
                        prefill = "\n\nFAILED TO PARSE manifest.json\n\n" + prefill;
                    }
                    prefill = createBrowserDebugInfo().toString() + "\n\n" + prefill;
                    internalSendFeedback(prefill).done(sendFeedbackDef.resolve).fail(sendFeedbackDef.reject);
                }, function errorCallback(response) {
                    prefill = "\n\nFAILED TO READ manifest.json\n\n" + createBrowserDebugInfo().toString() + "\n\n" + prefill;
                    internalSendFeedback(prefill).done(sendFeedbackDef.resolve).fail(sendFeedbackDef.reject);
                });

                return sendFeedbackDef;
            };

            function internalSendFeedback(feedback) {
                return myjdService.api.feedback(feedback);
            }

            //source: http://stackoverflow.com/questions/11219582/how-to-detect-my-browser-version-and-operating-system-using-javascript
            function createBrowserDebugInfo() {
                var os = "Unknown OS";
                var nVer = navigator.appVersion;
                var nAgt = navigator.userAgent;
                var browserName = navigator.appName;
                var fullVersion = '' + parseFloat(navigator.appVersion);
                var majorVersion = parseInt(navigator.appVersion, 10);
                var nameOffset, verOffset, ix;

                if (navigator.appVersion.indexOf("Win") != -1) os = "Windows";
                if (navigator.appVersion.indexOf("Mac") != -1) os = "MacOS";
                if (navigator.appVersion.indexOf("X11") != -1) os = "UNIX";
                if (navigator.appVersion.indexOf("Linux") != -1) os = "Linux";
                // In Opera, the true version is after "Opera" or after "Version"
                if ((verOffset = nAgt.indexOf("Opera")) != -1) {
                    browserName = "Opera";
                    fullVersion = nAgt.substring(verOffset + 6);
                    if ((verOffset = nAgt.indexOf("Version")) != -1)
                        fullVersion = nAgt.substring(verOffset + 8);
                }
                // In MSIE, the true version is after "MSIE" in userAgent
                else if ((verOffset = nAgt.indexOf("MSIE")) != -1) {
                    browserName = "Microsoft Internet Explorer";
                    fullVersion = nAgt.substring(verOffset + 5);
                }
                // In Chrome, the true version is after "Chrome"
                else if ((verOffset = nAgt.indexOf("Chrome")) != -1) {
                    browserName = "Chrome";
                    fullVersion = nAgt.substring(verOffset + 7);
                }
                // In Safari, the true version is after "Safari" or after "Version"
                else if ((verOffset = nAgt.indexOf("Safari")) != -1) {
                    browserName = "Safari";
                    fullVersion = nAgt.substring(verOffset + 7);
                    if ((verOffset = nAgt.indexOf("Version")) != -1)
                        fullVersion = nAgt.substring(verOffset + 8);
                }
                // In Firefox, the true version is after "Firefox"
                else if ((verOffset = nAgt.indexOf("Firefox")) != -1) {
                    browserName = "Firefox";
                    fullVersion = nAgt.substring(verOffset + 8);
                }
                // In most other browsers, "name/version" is at the end of userAgent
                else if ((nameOffset = nAgt.lastIndexOf(' ') + 1) <
                    (verOffset = nAgt.lastIndexOf('/'))) {
                    browserName = nAgt.substring(nameOffset, verOffset);
                    fullVersion = nAgt.substring(verOffset + 1);
                    if (browserName.toLowerCase() == browserName.toUpperCase()) {
                        browserName = navigator.appName;
                    }
                }
                // trim the fullVersion string at semicolon/space if present
                if ((ix = fullVersion.indexOf(";")) != -1)
                    fullVersion = fullVersion.substring(0, ix);
                if ((ix = fullVersion.indexOf(" ")) != -1)
                    fullVersion = fullVersion.substring(0, ix);

                majorVersion = parseInt('' + fullVersion, 10);
                if (isNaN(majorVersion)) {
                    fullVersion = '' + parseFloat(navigator.appVersion);
                    majorVersion = parseInt(navigator.appVersion, 10);
                }

                return {
                    os: os,
                    nVer: nVer,
                    nAgt: nAgt,
                    browserName: browserName,
                    fullVersion: fullVersion,
                    majorVersion: majorVersion,
                    toString: function () {
                        return "UA: " + this.nAgt + " | OS: " + os + " | Ver: " + nVer + " | Browser: " + browserName + " " + fullVersion;
                    }
                }
            }
        }])
    ;
