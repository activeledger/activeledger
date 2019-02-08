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

import { get, param, post, requestBody } from "@loopback/rest";
import { ActiveledgerDatasource } from "../datasources/activeledger";

/**
 * Manage Stream related API calls
 *
 * @export
 * @class StreamController
 */
export class StreamController {
  constructor() {}

  /**
   * Fetch multiple Activity Steams by id
   *
   * @param {string[]} data
   * @returns {Promise<any>}
   * @memberof StreamController
   */
  @post("/api/stream", {
    responses: {
      "200": {
        description: "Activity Stream Data",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                streams: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      _id: { type: "string" },
                      _rev: { type: "string" }
                    },
                    additionalProperties: true
                  }
                }
              }
            }
          }
        }
      },
      "404": {
        description: "Activity Stream Not Found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                statusCode: { type: "number" },
                name: { type: "string" },
                message: { type: "string" }
              }
            }
          }
        }
      }
    }
  })
  async streams(
    @requestBody({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "array",
            items: {
              type: "string"
            }
          }
        }
      }
    })
    data: string[]
  ): Promise<any> {
    let results = await ActiveledgerDatasource.getDb().allDocs({
      include_docs: true,
      keys: data
    });
    if (results) {
      // Normalise the data from rows[].doc
      let i = results.rows.length;
      let streams = [];
      while (i--) {
        streams.push(results.rows[i].doc);
      }
      return {
        streams
      };
    } else {
      return results;
    }
  }

  /**
   * Fetch an Activity Steam by id
   *
   * @param {string} id
   * @returns {Promise<any>}
   * @memberof StreamController
   */
  @get("/api/stream/{id}", {
    responses: {
      "200": {
        description: "Activity Stream Data",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                stream: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                    _id: { type: "string" },
                    _rev: { type: "string" }
                  },
                  additionalProperties: true
                }
              }
            }
          }
        }
      },
      "404": {
        description: "Activity Stream Not Found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                statusCode: { type: "number" },
                name: { type: "string" },
                message: { type: "string" }
              }
            }
          }
        }
      }
    }
  })
  async stream(@param.path.string("id") id: string): Promise<any> {
    let results = await ActiveledgerDatasource.getDb().get(id);
    if (results) {
      return {
        stream: results
      };
    } else {
      return results;
    }
  }

  /**
   * Fetch an Activity Steam volatile data by id
   *
   * @param {string} id
   * @returns {Promise<any>}
   * @memberof StreamController
   */
  @get("/api/stream/{id}/volatile", {
    responses: {
      "200": {
        description: "Activity Stream Volatile Data",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                stream: {
                  type: "object",
                  properties: {
                    _id: { type: "string" },
                    _rev: { type: "string" }
                  },
                  additionalProperties: true
                }
              }
            }
          }
        }
      },
      "404": {
        description: "Activity Stream Not Found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                statusCode: { type: "number" },
                name: { type: "string" },
                message: { type: "string" }
              }
            }
          }
        }
      }
    }
  })
  async getVolatile(@param.path.string("id") id: string): Promise<any> {
    let results = await ActiveledgerDatasource.getDb().get(id + ":volatile");
    if (results) {
      return {
        stream: results
      };
    } else {
      return results;
    }
  }

  /**
   * Write an Activity Steam volatile data by id
   *
   * @param {string} id
   * @param {*} data
   * @returns {Promise<any>}
   * @memberof StreamController
   */
  @post("/api/stream/{id}/volatile", {
    responses: {
      "200": {
        description: "Activity Stream Volatile Data",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                success: { type: "boolean" }
              }
            }
          }
        }
      },
      "404": {
        description: "Activity Stream Not Found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                statusCode: { type: "number" },
                name: { type: "string" },
                message: { type: "string" }
              }
            }
          }
        }
      }
    }
  })
  async postVolatile(
    @param.path.string("id") id: string,
    @requestBody() data: any
  ): Promise<any> {
    // Get Latest Version
    let results = await ActiveledgerDatasource.getDb().get(id + ":volatile");
    if (results) {
      // Update _id and _rev
      data._id = results._id;
      data._rev = results._rev;

      // Commit changes
      results = await ActiveledgerDatasource.getDb().put(data);
      return {
        success: results.ok
      };
    } else {
      return results;
    }
  }

  /**
   * Search the ledger with a url query SQL statement
   *
   * @param {string} sql
   * @returns {Promise<any>}
   * @memberof StreamController
   */
  @get("/api/stream/search", {
    responses: {
      "200": {
        description: "Activity Streams Data",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                streams: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      _id: { type: "string" },
                      _rev: { type: "string" }
                    },
                    additionalProperties: true
                  }
                },
                warning: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    message: { type: "string" }
                  }
                }
              }
            }
          }
        }
      },
      "404": {
        description: "Activity Streams Not Found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                statusCode: { type: "number" },
                name: { type: "string" },
                message: { type: "string" }
              }
            }
          }
        }
      }
    }
  })
  async search(@param.query.string("sql") sql: string): Promise<any> {
    // Get Latest Version
    let results = await ActiveledgerDatasource.getQuery().sql(sql);
    if (results) {
      let warning = ActiveledgerDatasource.getQuery().getLastWarning();
      if (warning) {
        return {
          streams: results,
          warning: warning
        };
      } else {
        return {
          streams: results
        };
      }
    } else {
      return results;
    }
  }

  /**
   * Search the ledger with a posted SQL statement
   *
   * @param {string} sql
   * @returns {Promise<any>}
   * @memberof StreamController
   */
  @post("/api/stream/search", {
    responses: {
      "200": {
        description: "Activity Streams Data",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                streams: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      _id: { type: "string" },
                      _rev: { type: "string" }
                    },
                    additionalProperties: true
                  }
                },
                warning: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    message: { type: "string" }
                  }
                }
              }
            }
          }
        }
      },
      "404": {
        description: "Activity Streams Not Found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                statusCode: { type: "number" },
                name: { type: "string" },
                message: { type: "string" }
              }
            }
          }
        }
      }
    }
  })
  async searchPost(
    @requestBody({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              sql: { type: "string" },
              mango: { type: "object" }
            }
          }
        }
      }
    })
    data: any
  ): Promise<any> {
    let results;
    // Get Latest Version
    if (data.sql && data.sql.length > 15) {
      results = await ActiveledgerDatasource.getQuery().sql(data.sql);
    }

    if (data.mango && Object.keys(data.mango).length > 0) {
      results = await ActiveledgerDatasource.getQuery().mango(data.mango);
    }

    if (results) {
      let warning = ActiveledgerDatasource.getQuery().getLastWarning();
      if (warning) {
        return {
          streams: results,
          warning: warning
        };
      } else {
        return {
          streams: results
        };
      }
    } else {
      return {
        streams: [],
        warning: {
          query: "N/A",
          message: "No SQL or Mango query found"
        }
      };
    }
  }

  /**
   * Get the latest changes
   *
   * @param {boolean} include_docs
   * @param {number} limit
   * @returns {Promise<any>}
   * @memberof StreamController
   */
  @get("/api/stream/changes", {
    responses: {
      "200": {
        description: "Activity Stream Volatile Data",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                changes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      changes: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            rev: { type: "string" }
                          }
                        }
                      },
                      doc: {
                        type: "object",
                        properties: {
                          _id: { type: "string" },
                          _rev: { type: "string" }
                        },
                        additionalProperties: true
                      },
                      seq: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "404": {
        description: "Activity Stream Not Found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                statusCode: { type: "number" },
                name: { type: "string" },
                message: { type: "string" }
              }
            }
          }
        }
      }
    }
  })
  async changes(
    @param.query.boolean("include_docs") include_docs: boolean,
    @param.query.number("limit") limit: number
  ): Promise<any> {
    let changes = await ActiveledgerDatasource.getDb().changes({
      descending: true,
      include_docs: include_docs,
      limit: (limit || 10) * 3
    });
    if (changes) {
      // Filter in only the stream data documents
      let dataDocs = [];
      let i = changes.results.length;
      while (i--) {
        if (
          changes.results[i].id.indexOf(":") === -1 &&
          changes.results[i].id.indexOf("_design") === -1
        ) {
          dataDocs.push(changes.results[i]);
        }
      }
      return {
        changes: dataDocs
      };
    } else {
      return changes;
    }
  }
}
