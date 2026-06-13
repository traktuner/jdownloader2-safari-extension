'use strict';

/**
 * @ngdoc function
 * @name myjdWebextensionApp.controller:ConnectedCtrl
 * @description
 * # ConnectedCtrl
 * Controller of the myjdWebextensionApp
 */
angular.module('myjdWebextensionApp')
    .controller('ConnectedCtrl', ['$scope', 'ExtensionMessagingService', 'ApiErrorService', '$timeout', 'StorageService', 'BackgroundScriptService', function ($scope, ExtensionMessagingService, ApiErrorService, $timeout, storageService, BackgroundScriptService) {
        $scope.autoGrabberState = {
            isActive: false,
            activeTabs: []
        };

        var onDeviceListResult = function (result) {
            $timeout(function () {
                if (result.data.error) {
                    $timeout(function () {
                        $scope.initializing = false;
                        $scope.state.error.message = ApiErrorService.createReadableApiError(ApiErrorService.createApiError(result.data.error));
                    }, 0);
                } else if (result.data.devices) {
                    $timeout(function () {
                        $scope.initializing = false;
                        if ($.isArray(result.data.devices)) {
                            $scope.devices = result.data.devices;
                            storageService.set(storageService.STORAGE_DEVICE_LIST_KEY, result.data.devices);
                        }
                    }, 0);
                }
            }, 0);
        };

        /*function checkAutograbberRunning() {
            ExtensionMessagingService.sendMessage("autograbber", "is-active").then(function (result) {
                $timeout(function () {
                    $scope.autoGrabberState.isActive = result.data.active;
                });
            });
        }

        function getAutograbberTabs() {
            ExtensionMessagingService.sendMessage("autograbber", "get-active-tabs").then(function (result) {
                $timeout(function () {
                    console.log("" + Date.now() + " | " + JSON.stringify(result.data.active));
                    $scope.autoGrabberState.activeTabs = result.data.active;
                });
            });
        }

        checkAutograbberRunning();
        getAutograbberTabs();*/

        $scope.autograbberRunning = false;

        var updateDevices = function () {
            $timeout(function () {
                $scope.initializing = true;
            }, 0);
            BackgroundScriptService.getDevices().then(function (result) {
                if (result && result.data) {
                    onDeviceListResult(result);
                } else {
                    $timeout(function () {
                        $scope.initializing = false;
                        $scope.state.error.message = "Failed to get a list of your JDownloaders";
                    }, 0);
                }
            }).catch(function (e) {
                $timeout(function () {
                    $scope.initializing = false;
                    if ($scope.state.isLoggedIn) {
                        console.log($scope.state);
                        console.log(e);
                        $scope.state.error.message = ApiErrorService.createReadableApiError(ApiErrorService.createApiError(e));
                    }
                }, 0);
            });
        };

        updateDevices();

        var viewStates = {
            JD_LIST: "JD_LIST",
            CLIPBOARD: "CLIPBOARD",
            SETTINGS: "SETTINGS"
        };

        $scope.viewstate = viewStates.JD_LIST;

        $scope.clipboardHistoryDisabled = false; // TODO: user settings
        $scope.initializing = false;
        $scope.state.error = {};
        $scope.showFeedbackPanel = false;
        $scope.showClipboardHistory = false;
        $scope.clipboardHistorySupported = document.queryCommandSupported('copy') && document.queryCommandSupported('paste');

        $scope.feedback = {
            msg: "",
            max: 2000,
            sending: false,
            success: false
        };

        $scope.logout = function () {
            BackgroundScriptService.logout().then(function (result) {

            }, function (error) {

            });
        };

        $scope.reallyLogout = function () {
            $timeout(function () {
                $scope.reallyLogoutDialogShown = !$scope.reallyLogoutDialogShown;
            });
        };

        $scope.sendError = function (rawError) {
            var prefill = "[API REQUEST ERROR]\n";
            prefill += "" + JSON.stringify(rawError);
            internalSendFeedback(prefill);
        };

        $scope.sendFeedback = function (msg) {
            $timeout(function () {
                $scope.feedback.sending = true;
            });
            internalSendFeedback(msg);
        };

        function internalSendFeedback(msg) {
            BackgroundScriptService.sendFeedback(msg).then(function () {
                $timeout(function () {
                    $scope.feedback.success = true;
                    $scope.feedback.sending = false;
                    storageService.set(storageService.STORAGE_FEEDBACK_MSG_DRAFT, "");
                    $timeout(function () {
                        $scope.toggleFeedbackPanel();
                    }, 2000);
                });
            }).catch(function (e) {
                $timeout(function () {
                    $scope.state.error.message = ApiErrorService.createReadableApiError(ApiErrorService.createApiError(e));
                    $scope.feedback.success = false;
                    $scope.feedback.sending = false;
                }, 2000)
            });
        }

        $scope.clearFeedback = function () {
            $timeout(function () {
                $scope.feedback.msg = "";
                storageService.set(storageService.STORAGE_FEEDBACK_MSG_DRAFT, "");
            });
        };

        $scope.showClipboardHistoryPanel = function () {
            $timeout(function () {
                $scope.state.error = {};
                $scope.viewstate = viewStates.CLIPBOARD;
            });
        };

        $scope.showJDList = function () {
            $timeout(function () {
                $scope.state.error = {};
                $scope.viewstate = viewStates.JD_LIST;
            }, 0);
        };

        $scope.showSettings = function () {
            $timeout(function () {
                $scope.state.error = {};
                $scope.viewstate = viewStates.SETTINGS;
            }, 0)
        };

        $scope.toggleFeedbackPanel = function () {
            $timeout(function () {
                $scope.showFeedbackPanel = $scope.showFeedbackPanel === false ? true : false;
                $scope.feedback.success = false;
                $scope.feedback.sending = false;
                $scope.feedback.msg = "";
                storageService.get(storageService.STORAGE_FEEDBACK_MSG_DRAFT, function (result) {
                    if (result && result.STORAGE_FEEDBACK_MSG_DRAFT && result.STORAGE_FEEDBACK_MSG_DRAFT.length > 0) {
                        $timeout(function () {
                            $scope.feedback.msg = result.STORAGE_FEEDBACK_MSG_DRAFT;
                        });
                    }
                });
            }, 0);
        };

        /*$scope.stopAutoGrabber = function () {
            ExtensionMessagingService.sendMessage("autograbber", "stop");
            checkAutograbberRunning();
        };*/

        $scope.isShowingFeedbackPanel = function () {
            return $scope.showFeedbackPanel;
        };

        $scope.isShowingClipboard = function () {
            return $scope.viewstate === viewStates.CLIPBOARD;
        };

        $scope.isShowingJDList = function () {
            return $scope.viewstate === viewStates.JD_LIST;
        };

        $scope.isShowingSettings = function () {
            return $scope.viewstate === viewStates.SETTINGS;
        };

        $scope.$watch(function (scope) {
            return scope.feedback.msg;
        }, function (newValue, oldValue) {
            if (newValue && newValue !== oldValue) {
                if (newValue && newValue.length > 0) {
                    storageService.set(storageService.STORAGE_FEEDBACK_MSG_DRAFT, newValue);
                }
            }
        });

        BackgroundScriptService.onDeviceListChanged(function (request) {
            onDeviceListResult(request);
        });

        BackgroundScriptService.onApiError(function (error) {
            $timeout(function () {
                if (error && error.data && error.data.error && error.data.error.type !== "UNKNOWN") {
                    $scope.state.error = ApiErrorService.createReadableApiError(error.data.error) || {};
                } else {
                    $scope.state.error.message = "Unknown communication error. Please try again later."
                    $scope.state.error.raw = {};
                }
            }, 0);
        });

        BackgroundScriptService.onConnectionChanged(function (request) {
            $timeout(function () {
                if (request.data.error) {
                    $scope.state.error.message = ApiErrorService.createReadableApiError(request.data.error);
                } else if (request.data.isLoggedIn !== undefined) {
                    if (request.data.isLoggedIn === true) {
                        storageService.get(storageService.STORAGE_DEVICE_LIST_KEY, function (result) {
                            $timeout(function () {
                                $scope.devices = result[storageService.STORAGE_DEVICE_LIST_KEY] || [];
                                if ($scope.devices && $scope.devices.length > 0) {
                                    $scope.initializing = false;
                                } else {
                                    $scope.initializing = true;
                                }
                                updateDevices();
                            }, 0);
                        });
                    } else {
                        $scope.state.isLoggedIn = false;
                    }
                }
            }, 0);
        });
    }
    ]);
