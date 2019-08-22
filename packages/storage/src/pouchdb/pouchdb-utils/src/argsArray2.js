"use strict";

/**
 * Simplified replacement for the argsArray dep
 *
 * @param {*} fun
 * @returns
 */
function argsArray2(fun) {
  return function() {
    return fun.call(this, Object.values(arguments));
  };
}


export default argsArray2;