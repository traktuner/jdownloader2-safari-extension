'use strict';
if (typeof browser !== 'undefined') { chrome = browser; }

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
            .when('/popup', {
                templateUrl: 'partials/controllers/popup.html',
                controller: 'PopupCtrl',
                controllerAs: 'popup'
            })
            .otherwise({
                redirectTo: '/popup'
            });
    });

angular.element(document).ready(function () {
    angular.bootstrap(document, ['myjdWebextensionApp']);
});
