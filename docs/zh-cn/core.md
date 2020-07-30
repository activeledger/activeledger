# Activecore

Activecore是独立于Activeledger运行的应用， 提供易用的基于restAPI来获取链上数据的方法。它的API不具备授权及验证的功能，所以建议访问权限设置在localhost使用， 并且建议用户创建自己的API来完成授权和验证。

Activecore 使用服务器来发送事件及信息推送，基于SSE(Server Sent Events）。

### /Activity 活动

在链上活动的承诺阶段完成后发送基于SSE的信息提示。

####GET /subscribe 获取提醒

获取在链上所有活动的提示信息，这意味着你会收到所有关于新数据的提醒和任何数据更新的提醒。

#### POST /subscribe 发送提醒

The same as the GET however you can send a body to restrict the activities you want to be notified about.

#### GET /subscribe/{stream} 获取提醒{特定信息}

获取在链上所有活动的提示信息The same as /subscribe however you will only be sent notifications when this stream gets updated

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

#### POST /search ⚠️Deprecated⚠️

Allows you to run a "SQL like" query against the ledger to search for data objects.
