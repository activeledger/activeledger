# Activeledger Application

This is the main runtime application for running Activeledger. (Core is recommended but not required). This application sets up the nessecary controls across multiple processes to manage the single API layer.

Before passing an Activeledger transaction into its own process pool it will verify any locks.