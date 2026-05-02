# Trakt Scrobbler

Trakt Scrobbler is an IINA plugin that scrobbles local movies and episodes to Trakt. It parses file names with `guessit-js`, matches them on Trakt, and keeps track of playback as you watch.

## Install

The best way to install it is from IINA itself.

- Open `Plugins` in IINA, choose `Install from GitHub`
- paste `i3p9/iina-trakt-scrobbler`, and install it
- Restart IINA, and you should see the Trakt Scrobbler sidebar in the sidebar list. Click it, and follow the instructions to authenticate with Trakt.

That is also the best way to get future updates.

If you prefer, you can also download the `.iinaplgz` package from GitHub Releases and install that manually.

## Features

- Trakt device auth
- Movie and episode parsing with `guessit-js`
- Automatic Trakt matching
- `start`, `pause`, and `stop` scrobbling
- Preview and fast-pause guards
- Live sidebar with auth, playback, and scrobble status

## Todo

- Cache playback locally when a scrobble cannot be sent, then retry or reconcile it later
- Add a manual search / correction flow in the sidebar for cases where a file is misidentified

## Development

Stage the plugin for local testing:

```bash
./scripts/stage-plugin.sh
```

Link it into IINA:

```bash
/Applications/IINA.app/Contents/MacOS/iina-plugin link "$(pwd)/.build/iina-trakt-scrobbler.iinaplugin"
```

Build a release package:

```bash
./scripts/pack-release.sh
```

Useful checks:

```bash
node --check main.js
node --check trakt.js
node tests/parser-smoke.js
node tests/monitor-state.js
node tests/trakt-resolution.js
```

## Notes

- Tokens are stored in the macOS keychain when possible, with an `@data` fallback during development.
- Search results are cached in `@data/trakt-cache.json`.
- Debug logs are written to `@data/debug.log`.

## Acknowledgements

Inspired by `trakt-scrobbler`.
