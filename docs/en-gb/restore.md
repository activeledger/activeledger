# Activerestore

This is ran as a separate application from Activeledger. This application is used to correct any data which is modified outside of consensus and also used to rebuild the entire ledger if required.

When using CouchDB as your storage engine this process requires the correct permissions to the file location of the CouchDB instance.

## Full Rebuild

To run a full rebuild you run restore with the --full flag. This can be along running process but it when it reaches the end it will stop execution and then you can run the restore application without the flag and it will listen and check on errors.

