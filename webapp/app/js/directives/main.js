/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

treeherder.directive('ngRightClick', [
    '$parse',
    function($parse) {
    return function(scope, element, attrs) {
        var fn = $parse(attrs.ngRightClick);
        element.bind('contextmenu', function(event) {
            scope.$apply(function() {
                event.preventDefault();
                fn(scope, {$event:event});
            });
        });
    };
}]);

// allow an input on a form to request focus when the value it sets in its
// ``focus-me`` directive is true.  You can set ``focus-me="focusInput"`` and
// when ``$scope.focusInput`` changes to true, it will request focus on
// the element with this directive.
treeherder.directive('focusMe', [
  '$timeout',
  function($timeout) {
  return {
    link: function(scope, element, attrs) {
      scope.$watch(attrs.focusMe, function(value) {
        if (value === true) {
          $timeout(function() {
            element[0].focus();
            console.log("focusMeDirective" + " " + scope[attrs.focusMe]);
            console.log("----------------------------------------------");
          }, 0);
        } else if (value === false) {
        console.log("focusMeDirective" + " " + scope[attrs.focusMe]);
        console.log("----------------------------------------------");
        element[0].blur();
        // scope[attrs.focusMe] = false;
        }
      });
    }
  };
}]);
// Select all text input in an html element on click.
treeherder.directive('selectOnClick', [
    function () {
        return {
            restrict: 'A',
            link: function (scope, element, attrs) {
                element.on('click', function () {
                    this.select();
                });
        }
    };
}]);
// Prevent default behavior on left mouse click. Useful
// for html anchor's that need to do in application actions
// on left click but default href type functionality on
// middle or right mouse click.
treeherder.directive('preventDefaultOnLeftClick', [
    function(){
        return {
            restrict: 'A',
            link: function(scope, element, attrs){
                element.on('click', function(event){
                    if(event.which === 1){
                        event.preventDefault();
                    }
                });
            }
        }
    }
]);
treeherder.directive('thFilterByBuildername', [
    'thJobFilters',
    function(thJobFilters){
        return {
            restrict: 'A',
            link: function(scope, element, attrs){
                element.on('click', function(event){

                    // Only execute the in page search if the
                    // user does a left click
                    if(event.which === 1){

                        thJobFilters.setSearchQuery(scope.buildbotJobname || "");

                        // Need to tell angular to run the digest cycle
                        // to process the new values in
                        // thJobFilters.searchQuery
                        if(!scope.$$phase){
                            scope.$apply();
                        }
                    }
                });
            }
        }
    }
]);

treeherder.directive('thNotificationBox', [
    'thNotify',
    function(thNotify){
    return {
        restrict: "E",
        templateUrl: "partials/main/thNotificationsBox.html",
        link: function(scope, element, attr) {
            scope.notifier = thNotify
            scope.alert_class_prefix = "alert-"
        }
    }
}]);

treeherder.directive('thFaviconLink', [
    'ThRepositoryModel', 'thFavicons',
    function(ThRepositoryModel, thFavicons){
    return {
        restrict: "E",
        link: function(scope, element, attr) {
            scope.currentTreeStatus = ThRepositoryModel.getCurrentTreeStatus
            scope.$watch('currentTreeStatus()', function(newVal) {
                if (newVal) {
                    scope.favicon = thFavicons[ThRepositoryModel.getCurrentTreeStatus()];
                }
            });
        },
        template: '<link id="favicon" type="image/png" rel="shortcut icon" href="{{favicon}}" />'
    }
}]);

treeherder.directive('numbersOnly', function(){
   return {
     require: 'ngModel',
     link: function(scope, element, attrs, modelCtrl) {
       modelCtrl.$parsers.push(function (inputValue) {
           // this next is necessary for when using ng-required on your input.
           // In such cases, when a letter is typed first, this parser will be called
           // again, and the 2nd time, the value will be undefined
           if (inputValue == undefined) return ''
           var transformedInput = inputValue.replace(/[^0-9]/g, '');
           if (transformedInput!=inputValue) {
              modelCtrl.$setViewValue(transformedInput);
              modelCtrl.$render();
           }

           return transformedInput;
       });
     }
   };
});

treeherder.directive("thMultiSelect", [
    '$log',
    function($log){
    return {
        restrict: "E",
        templateUrl: "partials/main/thMultiSelect.html",
        scope: {
            leftList: "=",
            rightList: "="
        },
        link: function(scope, element, attrs){

            scope.leftSelected = [];
            scope.rightSelected = [];
            // move the elements selected from one list to the other
            var move_options = function(what, from, to){
                var found;
                for(var i=0;i<what.length; i++){
                    found = from.indexOf(what[i]);
                    if(found !== -1){
                        to.push(from.splice(found, 1)[0]);
                    }
                }
            }
            scope.move_left = function(){
                move_options(scope.rightSelected, scope.rightList, scope.leftList);
            };
            scope.move_right = function(){
                move_options(scope.leftSelected, scope.leftList, scope.rightList);
            };
        }
    }
}]);

treeherder.directive("thTruncatedList", [
    '$log',
    function($log){
    // transforms a list of elements in a shortened list
    // with a "more" link
    return {
        restrict: "E",
        scope: {
            // number of visible elements
            visible: "@",
            elem_list: "=elements"
        },
        link: function(scope, element, attrs){
            scope.visible = parseInt(scope.visible)
            if(typeof scope.visible !== 'number'
                || scope.visible < 0
                || isNaN(scope.visible)){
                throw new TypeError("The visible parameter must be a positive number")
            }
            // cloning the original list to avoid
            scope.$watch("elem_list", function(newValue, oldValue){
                if(newValue){
                    var elem_list_clone = angular.copy(newValue);
                    scope.visible = Math.min(scope.visible, elem_list_clone.length);
                    var visible_content = elem_list_clone.splice(0, scope.visible);
                    $(element[0]).empty();
                    $(element[0]).append(visible_content.join(", "));
                    if(elem_list_clone.length > 0){
                        $(element[0]).append(
                            $("<a></a>")
                            .attr("title", elem_list_clone.join(", "))
                            .text(" and "+ elem_list_clone.length+ " others")
                            .tooltip()
                        );
                    }
                }
            });
        }
    }
}]);
