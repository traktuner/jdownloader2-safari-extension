angular.module('myjdWebextensionApp')
    .service('BrowserService', [function () {
        function chromeErrorCallback() {
            if (chrome.extension.lastError != null && chrome.extension.lastError.message != null) {
                let error = chrome.extension.lastError;
                console.log(error.message);
            } else if (chrome.runtime.lastError != null && chrome.runtime.lastError.message) {
                let error = chrome.runtime.lastError;
                console.log(error.message);
            }
        }

        return {
            chromeErrorCallback: chromeErrorCallback
        }
    }]);
