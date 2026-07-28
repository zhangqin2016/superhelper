"use strict";

function escapeLocalPathText(value = "") {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, (char) => (
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  ));
}

module.exports = {
  escapeLocalPathText,
};
