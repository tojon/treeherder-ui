'use strict';

treeherder.factory('ThResultSetModel',
                   ['$log', '$rootScope', 'thResultSets', 'thSocket',
                    'ThJobModel', 'thEvents', 'thAggregateIds',
                   function($log, $rootScope, thResultSets, thSocket,
                            ThJobModel, thEvents, thAggregateIds) {

   /******
    * Handle updating the resultset datamodel based on a queue of jobs
    * and resultsets.
    *
    * manages:
    *     resultset array
    *     socket messages
    *     resultset queue
    *     resultset map
    *     job queue
    *     job map
    */

    // the primary data model
    var resultSets,
        updateQueueInterval,
        rsOffset,

        repoName,

    // queues of updates that have come over socket.io.  Processed at intervals
        jobUpdateQueue,
        rsUpdateQueue,

    // maps to help finding objects to update/add
        rsMap,
        jobMap,
        jobMapOldestId,
        rsMapOldestTimestamp;

    var getJobMapKey = function(job) {
        //Build string key for jobMap entires
        return 'key' + job.id;
    };

    var getPlatformKey = function(name, option){
        var key = name;
        if(option != undefined){
            key += option;
        }
        return key;
    };

    /******
     * Build the Job and Resultset object mappings to make it faster and
     * easier to find and update jobs and resultsets
     *
     * @param data The array of resultsets to map.
     */
    var mapResultSets = function(data) {

        for (var rs_i = 0; rs_i < data.length; rs_i++) {
            var rs_obj = data[rs_i];
            // make a watch-able revisions array
            rs_obj.revisions = [];

            var rsMapElement = {
                rs_obj: rs_obj,
                platforms: {}
            };
            rsMap[rs_obj.id] = rsMapElement;

            // keep track of the oldest push_timestamp, so we don't auto-fetch resultsets
            // that are out of the range we care about.
            if (!rsMapOldestTimestamp || rsMapOldestTimestamp > rs_obj.push_timestamp) {
                rsMapOldestTimestamp = rs_obj.push_timestamp;
            }

            // platforms
            for (var pl_i = 0; pl_i < rs_obj.platforms.length; pl_i++) {
                var pl_obj = rs_obj.platforms[pl_i];

                var plMapElement = {
                    pl_obj: pl_obj,
                    parent: rsMap[rs_obj.id],
                    groups: {}
                };
                var platformKey = getPlatformKey(pl_obj.name, pl_obj.option);
                rsMap[rs_obj.id].platforms[platformKey] = plMapElement;

                // groups
                for (var gp_i = 0; gp_i < pl_obj.groups.length; gp_i++) {
                    var gr_obj = pl_obj.groups[gp_i];

                    var grMapElement = {
                        grp_obj: gr_obj,
                        parent: plMapElement,
                        jobs: {}
                    };
                    plMapElement.groups[gr_obj.name] = grMapElement;

                    // jobs
                    for (var j_i = 0; j_i < gr_obj.jobs.length; j_i++) {
                        var job_obj = gr_obj.jobs[j_i];
                        var key = getJobMapKey(job_obj);

                        var jobMapElement = {
                            job_obj: job_obj,
                            parent: grMapElement
                        };
                        grMapElement.jobs[key] = jobMapElement;
                        jobMap[key] = jobMapElement;

                        // track oldest job id
                        if (!jobMapOldestId || jobMapOldestId > job_obj.id) {
                            jobMapOldestId = job_obj.id;
                        }
                    }
                }
            }
        }

        resultSets.sort(rsCompare);
        $log.debug("oldest job: " + jobMapOldestId);
        $log.debug("oldest result set: " + rsMapOldestTimestamp);
        $log.debug("done mapping:");
        $log.debug(rsMap);
    };

    /**
     * Sort the resultsets in place after updating the array
     */
    var rsCompare = function(a, b) {
        if (a.push_timestamp > b.push_timestamp) {
          return -1;
        }
        if (a.push_timestamp < b.push_timestamp) {
          return 1;
        }
        return 0;
    };

    /******
     * Ensure that the platform for ``newJob`` exists.  Create it if
     * necessary.  Add to the datamodel AND the map
     * @param newJob
     * @returns plMapElement
     */
    var getOrCreatePlatform = function(newJob) {
        var rsMapElement = rsMap[newJob.result_set_id];
        var platformKey = getPlatformKey(newJob.platform, newJob.option);
        var plMapElement = rsMapElement.platforms[platformKey];
        if (!plMapElement) {
            // this platform wasn't in the resultset, so add it.
            $log.debug("adding new platform");

            var pl_obj = {
                name: newJob.platform,
                option: newJob.platform_opt,
                groups: []
            };

            // add the new platform to the datamodel and resort
            rsMapElement.rs_obj.platforms.push(pl_obj);

            // add the new platform to the resultset map
            rsMapElement.platforms[platformKey] = {
                pl_obj: pl_obj,
                parent: rsMapElement,
                groups: {}
            };
            plMapElement = rsMapElement.platforms[platformKey];
        }
        return plMapElement;
    };

    /******
     * Ensure that the group and platform for ``newJob`` exist.
     * Create it if necessary.  Add to the datamodel AND the map
     * @param newJob
     * @returns grpMapElement
     */
    var getOrCreateGroup = function(newJob) {
        var plMapElement = getOrCreatePlatform(newJob);
        var grMapElement = plMapElement.groups[newJob.job_group_name];
        if (!grMapElement) {
            $log.debug("adding new group");
            var grp_obj = {
                symbol: newJob.job_group_symbol,
                name: newJob.job_group_name,
                jobs: []
            };

            // add the new group to the datamodel
            plMapElement.pl_obj.groups.push(grp_obj);

            // add the new group to the platform map
            plMapElement.groups[grp_obj.name] = {
                grp_obj: grp_obj,
                parent: plMapElement,
                jobs: {}
            };

            grMapElement = plMapElement.groups[newJob.job_group_name];
        }
        return grMapElement;
    };

    /******
     * Socket.io handling for new and updated jobs and resultsets
     *
     * First we fetch new resultsets.  These may contain some of the jobs
     * in the jobUpdateQueue.  So after getting the resultsets, we check
     * if any of the jobs in the queue were fetched and remove them from
     * the job queue before fetching them.
     *
     * Then we fetch the remaining jobs in a batch and add them to their
     * appropriate resultset.
     */
    var processUpdateQueues = function() {

        $log.debug("Processing update queue.  jobs: " +
            jobUpdateQueue.length +
            ", resultsets: " +
            rsUpdateQueue.length);
        // clear the ``jobUpdateQueue`` so we won't miss items that get
        // added while in the process of fetching the current queue items.
        var rsFetchList = rsUpdateQueue;
        rsUpdateQueue = [];
        var jobFetchList = jobUpdateQueue;
        jobUpdateQueue = [];

        if (rsFetchList.length > 0) {
            // fetch these resultsets in a batch and put them into the model
            $log.debug("processing the rsFetchList");
            api.fetchNewResultSets(rsFetchList);
        }

        if (jobFetchList.length > 0) {
            $log.debug("processing jobFetchList");
            $log.debug(jobFetchList);

            // make an ajax call to get the job details

            ThJobModel.get_list({
                id__in: jobFetchList.join()
            }).then(
                updateJobs,
                function(data) {
                    $log.error("Error fetching jobUpdateQueue: " + data);
                });
        }
    };

    /***
     * update resultsets and jobs with those that were in the update queue
     * @param jobList List of jobs to be placed in the data model and maps
     */
    var updateJobs = function(jobList) {
        $log.debug("number of jobs returned for add/update: " + jobList.length);

        var platformData = {};

        var resultsetId, platformName, platformOption, platformAggregateId,
            platformKey, resultsetAggregateId, revision, i;

        for (i = 0; i < jobList.length; i++) {

            updateJob(jobList[i]);

            platformAggregateId = thAggregateIds.getPlatformRowId(
                $rootScope.repoName,
                jobList[i].result_set_id,
                jobList[i].platform,
                jobList[i].platform_opt
                );

            if(!platformData[platformAggregateId]){

                resultsetId = jobList[i].result_set_id;
                platformName = jobList[i].platform;
                platformOption = jobList[i].platform_opt;

                if(!_.isEmpty(rsMap[resultsetId])){

                    revision = rsMap[resultsetId].rs_obj.revision;

                    resultsetAggregateId = thAggregateIds.getResultsetTableId(
                        $rootScope.repoName, resultsetId, revision
                        );

                    platformKey = getPlatformKey(platformName, platformOption);

                    platformData[platformAggregateId] = {
                        platformName:platformName,
                        revision:revision,
                        platformOrder:rsMap[resultsetId].rs_obj.platforms,
                        resultsetId:resultsetId,
                        resultsetAggregateId:resultsetAggregateId,
                        platformOption:platformOption,
                        jobGroups:rsMap[resultsetId].platforms[platformKey].pl_obj.groups,
                        jobs:[]
                        };
                }else{
                    //We don't have the result set associated with this job yet
                    continue;
                }
            }

            platformData[platformAggregateId].jobs.push(jobList[i]);
        }

        // coalesce the updated jobs into their
        $rootScope.$broadcast(thEvents.jobsLoaded, platformData);
    };

    /******
     *
     * Add or update a new job.  Either we have it loaded already and the
     * status and info need to be updated.  Or we have the resultset, and
     * the job needs to be added to that resultset.
     *
     * Check the map, and update.  or add by finding the right place.
     *
     * Shape of the rsMap:
     * -------------------
     * rsMap = {
           <rs_id1>: {
               rs_obj: rs_obj,
               platforms: {
                   <pl_name1 + pl_option>: {
                       pl_obj: pl_obj,
                       groups: {
                           <grp_name1>: {
                               grp_obj: grp_obj
                           },
                           <grp_name2>: {...}
                       }
                   },
                   <pl_name2>: {...}
               },
           <rs_id2>: {...}
           }
       }
     *
     *
     * @param newJob The new job object that was just fetched which needs
     *               to be added or updated.
     */
    var updateJob = function(newJob) {

        var key = getJobMapKey(newJob);
        var loadedJobMap = jobMap[key];
        var loadedJob = loadedJobMap? loadedJobMap.job_obj: null;
        var rsMapElement = rsMap[newJob.result_set_id];

        if (!rsMapElement) {
            $log.error("we should have added the resultset for this job already!");
            return;
        }

        if (loadedJob) {
            $log.debug("updating existing job");
            _.extend(loadedJob, newJob);
        } else {
            // this job is not yet in the model or the map.  add it to both
            $log.debug("adding new job");

            var grpMapElement = getOrCreateGroup(newJob);

            // add the job mapping to the group
            grpMapElement.jobs[key] = {
                job_obj: newJob,
                parent: grpMapElement
            };
            // add the job to the datamodel
            grpMapElement.grp_obj.jobs.push(newJob);


            // add job to the jobmap
            jobMap[key] = {
                job_obj: newJob,
                parent: grpMapElement
            };

        }

        $rootScope.$broadcast(thEvents.jobUpdated, newJob);
    };

    var prependResultSets = function(data) {
        // prepend the resultsets because they'll be newer.

        var added = [];
        for (var i = data.length - 1; i > -1; i--) {
            if (data[i].push_timestamp > rsMapOldestTimestamp) {
                $log.debug("prepending resultset: " + data[i].id);
                resultSets.push(data[i]);
                added.push(data[i]);
            } else {
                $log.debug("not prepending.  timestamp is older");
            }
        }

        mapResultSets(added);

        api.loadingStatus.prepending = false;
    };

    var appendResultSets = function(data) {
        rsOffset += data.length;
        resultSets.push.apply(resultSets, data);

        mapResultSets(data);

        api.loadingStatus.appending = false;
    };

    var api = {

        init: function(interval, repo) {
            $log.debug("new resultset model manager");
            if (interval) {
                updateQueueInterval = interval;
            }

            repoName = repo;
            rsOffset = 0;
            jobUpdateQueue = [];
            rsUpdateQueue = [];
            rsMap = {};
            jobMap = {};
            jobMapOldestId = null;
            rsMapOldestTimestamp = null;
            resultSets = [];

            setInterval(processUpdateQueues, updateQueueInterval);
            /*
                socket.io update rules

                new resultset: when a job comes in, check the resultset id.  If
                    its newer than the oldest resultset in memory, then add it to the
                    update queue.  It will be added to the beginning of the resultsets
                    array.

                new job: check against list of jobs.
                    if it exists, update job data.
                    if it is part of the resultset update queue, then don't queue
                        it for update, we will get it with the resultset.
                    If it belongs to an existing resultset, but we don't have it to
                        be updated, then add it to the queue.

             */
            // Add a connect listener
            thSocket.on('connect',function() {
                thSocket.emit('subscribe', $rootScope.repoName + '.job');
                $log.debug("listening for new events.  interval: " + updateQueueInterval +
                    " for repo: " + repoName);
            });

            /******
             * Process a new ``job`` event notification.
             * Check the job's ``result_set_id``.  If the id belongs to a resulset
             * we already have in memory, add it to the ``jobUpdateQueue``.  If
             * not, then check if the ``resultset_id`` is newer or older than the
             * oldest rs_id we have in memory.  If it's newer, then add the
             * ``resultset_id`` to ``rsUpdateQueue``.
             *
             * So basically, if we see a job belonging to a newer resultset we
             * don't yet have loaded, then add it to the list of resultsets to
             * fetch.  Fetching a resultset also gets all its jobs, so we don't
             * need to add it to the ``jobUpdateQueue``.
             */
            thSocket.on("job", function(data) {
                if (data.branch === repoName) {
                    $log.debug("new job event");
                    $log.debug(data);
                    if (data.resultset.push_timestamp >= rsMapOldestTimestamp) {
                        // we want to load this job, one way or another
                        if (rsMap[data.resultset.id]) {
                            // we already have this resultset loaded, so queue the job
                            $log.debug("adding job to queue");
                            jobUpdateQueue.push(data.id);
                        } else {
                            // we haven't loaded this resultset yet, so queue it
                            $log.debug("checking resultset queue");
                            if (rsUpdateQueue.indexOf(data.resultset.id) < 0) {
                                $log.debug("new resultset not yet in queue");
                                rsUpdateQueue.push(data.resultset.id);
                            } else {
                                $log.debug("new resultset already queued");
                            }
                        }

                    }
                    else {
                        $log.debug("job too old");
                    }

                }
            });
        },

        loadRevisions: function(resultset_id) {
            var rs = rsMap[resultset_id].rs_obj;
            if (rs && rs.revisions.length === 0) {
                // these revisions have never been loaded; do so now.
                thResultSets.get(rs.revisions_uri).
                    success(function(data) {
                        rs.revisions.push.apply(rs.revisions, data);
                        $rootScope.$broadcast(thEvents.revisionsLoaded, rs);
                    });
            }
        },

        // this is "watchable" for when we add new resultsets and have to
        // sort them
        getResultSetsArray: function() {
            return resultSets;
        },

        getResultSetsMap: function() {
            return rsMap;
        },

        // this is a "watchable" for jobs
        getJobMap: function() {
            return jobMap;
        },

        getPlatformKey: getPlatformKey,

        // this is "watchable" by the controller now to update its scope.
        loadingStatus: {
            appending: false,
            prepending: false
        },

        /**
         * For fetching new resultsets via the web socket queue
         * @param resultsetlist list of result set ids to fetch.
         */
        fetchNewResultSets: function(resultsetlist) {

            api.loadingStatus.prepending = true;
            thResultSets.getResultSets(0, resultsetlist.length, resultsetlist).
                success(prependResultSets);
        },

        /**
         * Get the next batch of resultsets based on our current offset.
         * @param count How many to fetch
         */
        fetchResultSets: function(count) {

            api.loadingStatus.appending = true;
            thResultSets.getResultSets(rsOffset, count).
                success(appendResultSets);
        }

    };

    return api;

}]);