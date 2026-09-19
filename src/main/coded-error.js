"use strict";

/**
 * An Error that carries a machine-readable code — built in one place.
 * Ten modules had their own three-line copy; a caller that checks `error.code`
 * should be able to rely on one shape.
 *
 * @param {string} code
 * @param {string} [message] defaults to the code
 * @param {object} [details] extra own properties (never `code`/`message`)
 */
function codedError(code, message = code, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  for (const [key, value] of Object.entries(details || {})) if (key !== "code" && key !== "message") error[key] = value;
  return error;
}

module.exports = { codedError };
