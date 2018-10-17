/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import {get, param} from '@loopback/rest';
import {ActiveledgerDatasource} from '../datasources/activeledger';

/**
 * Manage Stream related API calls
 *
 * @export
 * @class StreamController
 */
export class StreamController {
  constructor() {}

  /**
   * Fetch an Activity Steam by id
   *
   * @param {string} id
   * @returns {Promise<any>}
   * @memberof StreamController
   */
  @get('/api/stream/{id}', {
    responses: {
      '200': {
        description: 'Activity Stream Data',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                stream: {
                  type: 'object',
                  properties: {
                    name: {type: 'string'},
                    type: {type: 'string'},
                    _id: {type: 'string'},
                    _rev: {type: 'string'},
                  },
                },
              },
            },
          },
        },
      },
      '404': {
        description: 'Activity Stream Not Found',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                statusCode: {type: 'number'},
                name: {type: 'string'},
                message: {type: 'string'},
              },
            },
          },
        },
      },
    },
  })
  async stream(@param.path.string('id') id: string): Promise<any> {
    let results = await ActiveledgerDatasource.getDb().get(id);
    if (results) {
      return {
        stream: results,
      };
    } else {
      return results;
    }
  }
}
