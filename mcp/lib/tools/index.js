"use strict";

const TOOL_MODULES = Object.freeze([
  require("./init-project.js"),
  require("./read-state.js"),
  require("./read-state-summary.js"),
  require("./transition-phase.js"),
  require("./ingest-file.js"),
  require("./inspect-source.js"),
  require("./acknowledge-inspect.js"),
  require("./record-intent-answer.js"),
  require("./save-brief.js"),
  require("./confirm-brief.js"),
  require("./save-storyboard.js"),
  require("./confirm-storyboard.js"),
  require("./log-storyboarder-invocation.js"),
  require("./log-composer-invocation.js"),
  require("./save-composition.js"),
  require("./lint-composition.js"),
  require("./render-preview.js"),
  require("./confirm-preview.js"),
  require("./render-full.js"),
  require("./confirm-render.js"),
  require("./package-output.js"),
  require("./finalize-iteration.js"),
  require("./archive-for-iteration.js"),
]);

module.exports = { TOOL_MODULES };
