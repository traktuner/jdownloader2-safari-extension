'use strict';
if (typeof browser !== 'undefined') {
    chrome = browser;
}

angular
    .module('myjdWebextensionApp', [
        'ngAnimate',
        'ngCookies',
        'ngResource',
        'ngRoute',
        'ngSanitize',
        'ngTouch'
    ])
    .config(function ($routeProvider) {
        $routeProvider
            .when('/toolbar', {
                templateUrl: 'partials/controllers/toolbar.html',
                controller: 'ToolbarCtrl',
                controllerAs: 'toolbar'
            })
            .otherwise({
                redirectTo: '/toolbar'
            });
    });

angular.element(document).ready(function () {
    angular.bootstrap(document, ['myjdWebextensionApp']);
});