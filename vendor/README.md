This directory contains vendored third-party code used by the plugin runtime.

Current contents:

- `guessit-js.js`: copied from `opensubtitles/guessit-js`
- `guessit-js.compat.js`: local downleveled build of the vendored bundle for IINA runtime compatibility

Source reference in this repo:

- `resourses/guessit-js-main/dist/guessit-js.js`

Upstream project:

- `https://github.com/opensubtitles/guessit-js`

Vendored snapshot:

- package: `guessit-js`
- version: `3.9.0`
- source commit: `d455e3213adef0ce19964deceaf76239b90ff37c`

Refresh note:

- this repo keeps the vendored files directly
- if the upstream bundle is refreshed, regenerate `guessit-js.compat.js` and `parser.iina.js` too

IINA runtime note:

- The raw vendored bundle was not stable inside IINA's JavaScriptCore runtime.
- The working Trakt plugin path is:
  1. vendor the upstream JS bundle as `guessit-js.js`
  2. generate `guessit-js.compat.js` with a downleveled `esbuild` pass
  3. bundle the parser and the compat bundle into `parser.iina.js`
  4. stage `parser.iina.js` into the plugin as `parser.js`

License note:

- upstream `guessit-js` declares `LGPL-3.0` in its package metadata
