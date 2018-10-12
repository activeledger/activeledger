#!/usr/bin/env node

"use strict";
require("ts-node/register");
var fs = require("fs");
var loopback = require("loopback");
var boot = require("loopback-boot");
var cookieParser = require("cookie-parser");
var rateLimit = require("express-rate-limit");
var ActiveOptions = require("@activeledger/activeoptions").ActiveOptions;

var app = (module.exports = loopback());

app.use(cookieParser());

// Initalise CLI Options
ActiveOptions.init();

// Parse Config
ActiveOptions.parseConfig();

// Basic check for database and config
if (ActiveOptions.get("db", false)) {
  // Extend Config
  ActiveOptions.extendConfig();

  // Set Limits
  var limiter = new rateLimit({
    windowMs: global.config.rate.minutes * 60 * 1000, // 15 minutes
    max: global.config.rate.limit, // limit each IP to 20 requests per windowMs
    delayMs: global.config.rate.delay // disable delaying - full speed until the max limit is reached
  });

  // Attach Limiter
  app.use("/api/", limiter);

  app.start = function() {
    // start the web server
    var server = app.listen((global.config.api && global.config.api.port) ? global.config.api.port : 5261, function() {
      app.emit("started", server);
      var baseUrl = app.get("url").replace(/\/$/, "");
      console.log("Web server listening at: %s", baseUrl);
      if (app.get("loopback-component-explorer")) {
        var explorerPath = app.get("loopback-component-explorer").mountPath;
        console.log("Browse your REST API at %s%s", baseUrl, explorerPath);
      }
    });
    return server;
  };

  // Bootstrap the application, configure models, datasources and middleware.
  // Sub-apps like REST API are mounted via boot scripts.
  boot(app, __dirname, function(err) {
    if (err) throw err;

    // start the server if `$ node server.js`
    if (require.main === module) app.start();
  });
} else {
  console.log("Configuration file not found");
}
