'use strict';

/**
 * @ngdoc function
 * @name myjdWebextensionApp.controller:PopupCtrl
 * @description
 * # PopupCtrl
 * Controller of the myjdWebextensionApp
 */

angular.module('myjdWebextensionApp')
    .controller('PopupCtrl', ['$rootScope', '$scope', '$http', '$timeout', 'BackgroundScriptService', 'ApiErrorService', function ($rootScope, $scope, $http, $timeout, BackgroundScriptService, ApiErrorService) {
        var loadBuildMeta = function () {
            var buildMetaReq = new XMLHttpRequest();
            buildMetaReq.open("GET", chrome.runtime.getURL("buildMeta.json"));
            buildMetaReq.responseType = "json";
            if (buildMetaReq.overrideMimeType) {
                buildMetaReq.overrideMimeType("application/json");
            }
            buildMetaReq.addEventListener('load', function (event) {
                if (buildMetaReq.status >= 200 && buildMetaReq.status < 300) {
                    $timeout(function () {
                        $scope.isOutdatedVersion = (new Date().getTime() - buildMetaReq.response.timestamp) > (1000 * 60 * 60 * 24 * 90);
                    }, 0);
                } else {
                    console.error(buildMetaReq.statusText, buildMetaReq.responseText);
                }
            });
            buildMetaReq.send();
        };
        loadBuildMeta();

        resetScope();
        $rootScope.bodyClass = "browserActionContainer";
        $scope.credentials = {email: undefined, password: undefined};
        $scope.state.isInitializing = true;

        // Keep an unfinished login only in the background page's memory.
        // It expires after five minutes even when the popup is never reopened.
        var restoringDraft = true;
        BackgroundScriptService.getLoginDraft().then(function (result) {
            var draft = result && result.data;
            if (draft && !$scope.state.isLoggedIn) {
                // Never replace input typed while the asynchronous restore ran.
                if (!$scope.credentials.email && !$scope.credentials.password) {
                    $scope.credentials.email = draft.email;
                    $scope.credentials.password = draft.password;
                }
            }
        }).finally(function () {
            restoringDraft = false;
            // A user may already have typed while the restore was in flight.
            // Save that input even if no later keystroke triggers the watcher.
            if (!$scope.state.isLoggedIn && ($scope.credentials.email || $scope.credentials.password)) {
                BackgroundScriptService.setLoginDraft({
                    email: $scope.credentials.email || "", password: $scope.credentials.password || ""
                });
            }
        });

        $scope.$watchGroup(['credentials.email', 'credentials.password'], function (vals) {
            if (restoringDraft || $scope.state.isLoggedIn) return;
            BackgroundScriptService.setLoginDraft({email: vals[0] || "", password: vals[1] || ""});
        });
        $scope.$watch('state.isLoggedIn', function (loggedIn) {
            if (loggedIn) {
                BackgroundScriptService.setLoginDraft(null);
                $scope.credentials.password = undefined;
            }
        });

        BackgroundScriptService.getSessionInfo().then(function (result) {
            $timeout(function () {
                $scope.state.isConnecting = false;
                $scope.state.isInitializing = false;
                if (result.data.isLoggedIn === false) {
                    $scope.state.loading = false;
                    $scope.state.isLoggedIn = false;
                } else if (result.data.isLoggedIn === true) {
                    $scope.state.isLoggedIn = true;
                }
            }, 0);
        }).catch(function () {
            $timeout(function () {
                $scope.state.isConnecting = false;
                $scope.state.isInitializing = false;
                $scope.state.loading = false;
                $scope.state.isLoggedIn = false;
            }, 0);
        });

        function resetScope() {
            $scope.state = {
                'isConnecting': false,
                'isLoggedIn': false,
                'isInitializing': false,
                'successMessage': undefined,
                'error': undefined
            };
        }

        chrome.runtime.onMessage.addListener(function (message) {
            if (message.action === "CONNECTION_STATE_CHANGE" && message.name === "myjd-toolbar") {
                if (message.data === "CONNTECTED") {
                    $timeout(function () {
                        $scope.state.isLoggedIn = true;
                    }, 0);
                } else if (message.data === "DISCONNECTED") {
                    $scope.state.isLoggedIn = false;
                }
            }
        });

        BackgroundScriptService.onConnectionChanged(function (request) {
            if (request.data && request.data.isLoggedIn !== undefined) {
                $timeout(function () {
                    $scope.state.isInitializing = false;
                    if (request.data.isLoggedIn === false) {
                        $scope.state.loading = false;
                        $scope.state.isLoggedIn = false;
                    } else if (request.data.isLoggedIn === true) {
                        $scope.state.isLoggedIn = true;
                    }
                }, 0);
            }
        });

        $scope.showLoggedOutSettings = function () {
            $timeout(function () {
                chrome.runtime.openOptionsPage();
            });
        };

        $scope.login = function (credentials) {
            if ($scope.loginForm.$valid) {
                resetScope();
                $scope.isConnecting = true;

                BackgroundScriptService.login({credentials: credentials}).then(function (result) {
                    $timeout(function () {
                        $scope.state.isConnecting = false;
                        if (result !== undefined && result.error === undefined && result.data !== undefined) {
                            $scope.state.isInitializing = false;
                            if (result.data === true) {
                                $scope.state.loading = false;
                                $scope.state.isLoggedIn = true;
                            } else {
                                $scope.state.isLoggedIn = false;
                            }
                        } else {
                            var errData = (result && result.data) ? result.data.error : (result ? result.error : undefined);
                            if (errData === "credentials missing") {
                                $scope.state.error = "Email and password are required."
                            } else {
                                var readableError = ApiErrorService.createReadableApiError(errData);
                                if (readableError) {
                                    $scope.state.error = readableError;
                                } else {
                                    $scope.state.error = "Sorry, an unknown error happened. Please let us know!";
                                }
                            }
                        }
                    }, 0);
                }, function (error) {
                    $timeout(function () {
                        $scope.state.isConnecting = false;
                        $scope.state.isInitializing = false;
                        $scope.state.loading = false;
                        var readableError = ApiErrorService.createReadableApiError(error);
                        if (readableError) {
                            $scope.state.error = readableError;
                        } else {
                            $scope.state.error = "Sorry, an unknown error happened. Please let us know!";
                        }
                    }, 0);
                });
            }
        };
    }]);
