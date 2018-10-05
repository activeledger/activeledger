# Activecore

This is ran as a separate application from Activeledger. Its main purpose is to help get the data out of the ledger in an easy to use way. It exposes as a REST based API. This API has no authentication or validation so it is not recommended to expose beyond localhost. Instead you should create your own API to expose with authentication.

Activecore uses SSE (Server Sent Events, Also known as Event Source) to provide push notifications.

### /Activity

Subscribe to activities on the ledger after the commit phase has completed. These notifications are sent using SSE.

####GET /subscribe 

Receive notification for all activities on the ledger network. This means for all new streams or updated streams you will be sent the data state.

#### POST /subscribe

The same as the GET however you can send a body to restrict the activities you want to be notified about.

#### GET /subscribe/{stream}

The same as /subscribe however you will only be sent notifications when this stream gets updated

### /Event

Smart contracts are able to raise events at any point of execution (Verify, Vote, Commit, Post) this is how you can subscribe to those events to further the execution. These notifications are sent using SSE.

#### GET /events

Subscribe to all the events sent on the ledger

#### GET /events/{contract}

Subscribe to only the events emitted by that specific contract id. (Remember contracts themselves are also activity streams)

#### GET /events/{contract}/{event}

Subscribe to a specific event emitted by that specific contract id.

### /Stream

This exposes the current data state objects of all streams on the ledger.

#### GET /{stream}

Get a specific activity stream data state.

#### GET /{stream}/volatile

Get the volatile data object for the specific data stream.

####POST /{stream}/volatile 

Set the volatile data object for the specific data stream.

#### GET /changes

Returns a list of the latest data object changes. This is to pull the changes where /activity/subscribe pushes these changes to you.

#### POST /search

Allows you to run a "SQL like" query against the ledger to search for data objects.