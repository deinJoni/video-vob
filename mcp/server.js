#!/usr/bin/env node
"use strict";

const { startStdioServer } = require("./lib/transport.js");
const { TOOLS } = require("./lib/tool-registry.js");
const { executeTool } = require("./lib/dispatch.js");

const SERVER_INFO = Object.freeze({ name: "vob", version: "0.1.0" });

if (require.main === module) {
  startStdioServer({
    serverInfo: SERVER_INFO,
    tools: TOOLS,
    executeTool,
  });
}

module.exports = { TOOLS, executeTool, SERVER_INFO };
