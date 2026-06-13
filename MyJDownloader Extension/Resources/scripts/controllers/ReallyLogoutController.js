angular.module('myjdWebextensionApp')
    .controller('ReallyLogoutCtrl', ['$scope', '$timeout', 'BackgroundScriptService', function ($scope, $timeout, BackgroundScriptService) {
        $scope.logout = function () {
            BackgroundScriptService.logout().then(function (result) {

            }, function (error) {
                console.error(error);
            });
        };
        $scope.toggleReallyLogout = function () {
            $timeout(function () {
                $scope.reallyLogoutDialogShown = !$scope.reallyLogoutDialogShown;
            });
        };

        $scope.$watch('reallyLogoutDialogShown', function (newVal, oldVal, scope) {
            $timeout(function () {
                $scope.reallyLogoutDialogShown = scope.reallyLogoutDialogShown;
            });
        });
    }]);