'use strict';

angular.module('myjdWebextensionApp')
    .service('ExtensionI18nService', [
        function () {
            this.getMessage = function (msg) {
                return chrome.i18n.getMessage(msg);
            };

            this.getAcceptLanguages = function () {
                return chrome.i18n.getAcceptLanguages();
            };

            this.getUILanguage = function () {
                return chrome.i18n.getUILanguage();
            };

            this.detectLanguage = function () {
                return chrome.i18n.detectLanguage();
            }
        }]);