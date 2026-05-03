var globalScope = typeof globalThis !== "undefined" ? globalThis : this;

if (!globalScope.process || typeof globalScope.process !== "object") {
  globalScope.process = { env: {} };
} else if (!globalScope.process.env || typeof globalScope.process.env !== "object") {
  globalScope.process.env = {};
}

var process = globalScope.process;

const parser = require("./parser.js");
const guessit = require("./vendor/guessit-js.compat.js");

parser.configure({
  loadGuessitModule: function() {
    return guessit;
  }
});

module.exports = parser;
