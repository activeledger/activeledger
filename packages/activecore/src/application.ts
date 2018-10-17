import {BootMixin} from '@loopback/boot';
import {ApplicationConfig} from '@loopback/core';
import {RepositoryMixin} from '@loopback/repository';
import {RestApplication} from '@loopback/rest';
import {ServiceMixin} from '@loopback/service-proxy';
import {MySequence} from './sequence';
import {ActiveLogger} from '@activeledger/activelogger';
import {ActiveOptions} from '@activeledger/activeoptions';

export class ActivecoreApplication extends BootMixin(
  ServiceMixin(RepositoryMixin(RestApplication)),
) {
  constructor(options: ApplicationConfig = {}) {
    super(options);

    // Initalise CLI Options
    ActiveOptions.init();

    // Parse Config
    ActiveOptions.parseConfig();

    // Basic check for database and config
    if (ActiveOptions.get('db', false)) {
      // Extend Config
      ActiveOptions.extendConfig();

      // Set up the custom sequence
      this.sequence(MySequence);

      // Set Default Port
      options.rest = {
        port: ActiveOptions.get<any>('api', {}).port || 5261,
      };

      this.projectRoot = __dirname;
      // Customize @loopback/boot Booter Conventions here
      this.bootOptions = {
        controllers: {
          // Customize ControllerBooter Conventions here
          dirs: ['controllers'],
          extensions: ['.controller.js'],
          nested: true,
        },
      };
    } else {
      ActiveLogger.fatal('Configuration file incomplete');
      process.exit(0);
    }
  }
}
