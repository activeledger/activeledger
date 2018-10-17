import {ActivecoreApplication} from './application';
import {ApplicationConfig} from '@loopback/core';
import {ActiveLogger} from '@activeledger/activelogger';

export {ActivecoreApplication};

export async function main(options: ApplicationConfig = {}) {
  const app = new ActivecoreApplication(options);
  await app.boot();
  await app.start();

  const url = app.restServer.url;
  ActiveLogger.info(`Server is running at ${url}`);

  return app;
}
