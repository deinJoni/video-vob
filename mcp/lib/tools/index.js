"use strict";

const TOOL_MODULES = Object.freeze([
  require("./init-project.js"),
  require("./read-state.js"),
  require("./read-state-summary.js"),
  require("./transition-phase.js"),
]);

module.exports = { TOOL_MODULES };
