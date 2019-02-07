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

export interface IQuery {
  fields?: string[];
  selector: any;
  sort?: any[];
  limit?: number;
}

/**
 * Simple SQL Parser to Mango. Will be expanded to support more complex queries
 *
 * @export
 * @class SQL
 */
export class SQL {
  /**
   * Creates an instance of SQL.
   * @param {string} query
   * @memberof SQL
   */
  constructor(private query: string) {}

  /**
   * Parse SQL Query to Mango
   *
   * @returns {IQuery}
   * @memberof SQL
   */
  public parse(): IQuery {
    let out: IQuery = { selector: {} };

    // Breakdown the string into its main parts
    let [select, , where, order, limit] = this.query
      .split(/SELECT|FROM|WHERE|ORDER BY|LIMIT/g)
      .filter(Boolean)
      .map(s => s.trim());

    // Process Select
    if (select && select != "*") {
      // Split selects on , and set as fields
      out.fields = select.split(",").filter(Boolean);
    }

    // Process WHERE
    if (where) {
      // Manage Nested Bracketed conditions (2 levels)
      // brackets || where
      let brackets = (where as any).match(
        new RegExp("\\((?:[^)(]+|\\((?:[^)(]+|\\([^)(]*\\))*\\))*\\)", "g")
      );

      // Nested Brackets?
      if (brackets) {
        brackets = brackets
          .filter(Boolean)
          .map((s: string) => s.trim().replace(/^[\\(](.*)[\\)]$/, "$1"));

        // Loop condition groups
        brackets.forEach((conditions: string) => {
          out.selector = { ...out.selector, ...this.where(conditions) };
        });
      } else {
        // Simple Where
        out.selector = { ...out.selector, ...this.where(where) };
      }
    }

    // Process ORDER BY
    if (order) {
      // Split selects on , and loop
      let orders = order.split(",").filter(Boolean);
      out.sort = [];
      orders.forEach((item: string) => {
        // Trim white space to split on space
        let [order, direction] = item.trim().split(" ");
        // Add to sort
        if (out.sort)
          out.sort.push({ [order]: (direction || "asc").toLowerCase() });
      });
    }

    // Add Limit
    if (limit) {
      out.limit = parseInt(limit);
    }

    return out;
  }

  /**
   * Manage Where Condition mapping
   *
   * @private
   * @param {string} conditions
   * @returns {*}
   * @memberof SQL
   */
  private where(conditions: string): any {
    // Split on AND
    let condition = conditions.split("AND").filter(Boolean);

    // Output
    let out: any = {};

    condition.forEach(item => {
      // Get The Operators
      let [leftSideOp, op, rightSideOp] = item
        .split(
          new RegExp("(>=|<=|!=|=|<>|>|<|BETWEEN|EXISTS|NOT IN|IN|LIKE)", "g")
        )
        .map(s => s.trim().replace(/^['|"](.*)['|"]$/, "$1"));

      // Null or Blank
      if (rightSideOp == "" || rightSideOp == "null") {
        (rightSideOp as unknown) = null;
      }

      switch (op) {
        case "=":
          out[leftSideOp] = rightSideOp;
          break;
        case "!=":
        case "<>":
          out[leftSideOp] = {
            $ne: rightSideOp
          };
          break;
        case "<":
          out[leftSideOp] = {
            $lt: rightSideOp
          };
          break;
        case "<=":
          out[leftSideOp] = {
            $lte: rightSideOp
          };
          break;
        case ">":
          out[leftSideOp] = {
            $gt: rightSideOp
          };
          break;
        case ">=":
          out[leftSideOp] = {
            $gte: rightSideOp
          };
          break;
        case "IN":
          out[leftSideOp] = {
            $in: rightSideOp
              .replace(/[\(\)]/g, "")
              .split(",")
              .map(e => parseInt(e) || e.replace(/^['|"](.*)['|"]$/, "$1"))
          };
          break;
        case "NOT IN":
          out[leftSideOp] = {
            $nin: rightSideOp
              .replace(/[\(\)]/g, "")
              .split(",")
              .map(e => parseInt(e) || e.replace(/^['|"](.*)['|"]$/, "$1"))
          };
          break;
        default:
          break;
      }
    });

    return out;
  }
}
