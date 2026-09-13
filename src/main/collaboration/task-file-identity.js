"use strict";
// Creation time disambiguates inode reuse. Platforms without a stable inode or
// creation timestamp cannot prove an edited rename and return no identity.
function taskFileIdentity(stat) {
  if (typeof stat.ino !== "bigint" || stat.ino <= 0n || typeof stat.birthtimeNs !== "bigint" || stat.birthtimeNs <= 0n
    || typeof stat.dev !== "bigint" || stat.dev < 0n || !stat.isFile() || stat.nlink !== 1n) return null;
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
module.exports = {taskFileIdentity};
