'use strict';

treeherder.directive('lvLogSteps', ['$timeout', '$parse', function ($timeout) {
    function getOffsetOfStep (order) {
        var el = $('.logviewer-step[order="' + order + '"]');
        var parentOffset = el.parent().offset();

        return el.offset().top - 
               parentOffset.top + el.parent().scrollTop() - 
               parseInt($('.steps-data').first().css('padding-bottom'));
    }

    /* -------------------------------------------------------------------- */

    return {
        restrict: 'A',
        templateUrl: 'partials/lvLogSteps.html',
        link: function (scope, element, attr) {
            scope.scrollTo = function($event, step, linenumber) {
                scope.currentLineNumber = linenumber;

                scope.loadMore({}).then(function () {
                    $timeout(function () {
                        var line = $('.lv-log-line[line="' + linenumber + '"]');

                            // Animate to successfully scroll to the selected error
                            if (line.offset() !== undefined) {
                                $('html, body').animate({
                                    scrollTop: line.offset().top - $('.run-data').outerHeight()
                                }, 200);
                            }
                    });
                });

                if (scope.displayedStep && scope.displayedStep.order === step.order) {
                    $event.stopPropagation();
                }
            };

            scope.toggleSuccessfulSteps = function() {
                scope.showSuccessful = !scope.showSuccessful;

                var firstError = scope.artifact.step_data.steps.filter(function(step){
                    return step.errors && step.errors.length > 0;
                })[0];

                if (!firstError) return;

                // scroll to the first error
                $timeout(function () {
                    var scrollTop = getOffsetOfStep(firstError.order);

                    $('.steps-data').scrollTop( scrollTop );
                });
            };

            scope.displayLog = function(step) {
                scope.displayedStep = step;
                scope.currentLineNumber = step.started_linenumber;

                scope.loadMore({}).then(function () {
                    $timeout(function () {
                        var line = $('.lv-log-line[line="' + step.started_linenumber + '"]');

                        if (line.offset() !== undefined) {
                            // Animate to successfully scroll to the selected error
                            $('html, body').animate({
                                scrollTop: line.offset().top - $('.run-data').outerHeight()
                            }, 200);
                        }
                    });
                });
            };
        }
    };
}]);
