(function() {
  // Get Local PouchDB 7
  let PouchDB: any = require("../node_modules/pouchdb-monorepo/packages/node_modules/pouchdb/lib/index.js");

  // Get base version of Express
  let app: any = require("express")();

  // Basic middleware needed to reroute incorrect paths
  app.use((req: any, res: any, next: any) => {
    // Fix double forward slash problem
    req.originalUrl = req.originalUrl.replace("//", "/");
    next();
  });

  // Get PouchDB (With Correct Path) Specific Express
  app.use(
    "/",
    require("express-pouchdb")(
      PouchDB.defaults({ prefix: "./" + process.argv[2] + "/" })
    )
  );

  // Start
  app.listen(process.argv[3]);
})();
