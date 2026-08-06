"use strict";

const methods = require("./parent-closure-recovery-store").createParentClosureRecoveryStoreMethods();

module.exports = function attachParentClosureRecoveryMethods(MessageStore) {
  Object.defineProperties(
    MessageStore.prototype,
    Object.fromEntries(Object.entries(methods).map(([name, value]) => [
      name,
      { configurable: true, writable: true, value },
    ])),
  );
};
