angular.module('myjdWebextensionApp')
    .filter('translate', ['ExtensionI18nService', function (ExtensionI18nService) {
        return function (message) {
            return ExtensionI18nService.getMessage(message) || message;
        }
    }]);