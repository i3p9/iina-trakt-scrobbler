# Trakt Scrobbler

An IINA plugin for Trakt scrobbling.

## Current Status

This repo now has the first real scrobble foundation in place:

- vendored `guessit-js` with heuristic fallback
- Trakt device-auth flow with explicit connect controls
- explicit Trakt auth controls in plugin preferences and a live Trakt sidebar
- a plugin menu entry for quickly reopening the Trakt sidebar
- token persistence with macOS keychain primary storage and `@data` fallback
- Trakt show/movie ID lookup cache
- playback state tracking for `start`, `pause`, and `stop`
- preview and fast-pause guards based on the Python `trakt-scrobbler` reference app
- parser smoke tests and playback state unit tests
- bundled Trakt app credential support with optional local preference overrides

What is still missing:

- retry/backlog handling for failed `stop` scrobbles
- richer logging/inspection for Trakt payloads
- packaging polish and GitHub metadata
- embedding the real shared Trakt app credentials for release

## Development

Stage a clean plugin folder:

```bash
./scripts/stage-plugin.sh
```

That creates:

```bash
.build/iina-trakt-scrobbler.iinaplugin
```

Link it into IINA:

```bash
/Applications/IINA.app/Contents/MacOS/iina-plugin link "$(pwd)/.build/iina-trakt-scrobbler.iinaplugin"
```

Useful checks:

```bash
node --check main.js
node tests/parser-smoke.js
node tests/monitor-state.js
./scripts/pack-release.sh
```

## Runtime Notes

- Release builds are intended to use bundled Trakt app credentials from `trakt_keys.js`.
- Until those are embedded, you can use the optional client ID and client secret override fields in plugin preferences.
- Use the plugin sidebar for live auth state, device codes, connected account info, token validity, playback identity, and recent scrobble status.
- Use `Plugin > Trakt Scrobbler > Show Sidebar` or `Command+T` to reopen the sidebar quickly.
- Connect to Trakt explicitly from the sidebar or plugin preferences.
- Playback will not trigger device auth automatically; unauthenticated scrobbles are skipped until you connect.
- Search results are cached in `@data/trakt-cache.json`.
- OAuth tokens are stored in the macOS keychain when possible, with a mirrored `@data/trakt-token.json` fallback for development.
- Debug logs are written to `@data/debug.log`.

## Layout

- `Info.json`: plugin manifest
- `main.js`: IINA runtime, playback tracking, and event handling
- `monitor.js`: pure playback transition logic derived from the Python reference monitor
- `trakt.js`: Trakt auth, search, ID caching, and scrobble calls
- `trakt_keys.js`: bundled shared Trakt app credentials for release builds
- `parser.js`: `guessit-js` backed parser with heuristic fallback
- `preferences.html`: Trakt settings UI
- `sidebar.html`: live Trakt sidebar UI
- `vendor/`: vendored `guessit-js` runtime and attribution
- `tests/parser-smoke.js`: parser smoke tests
- `tests/monitor-state.js`: playback state-machine tests
- `scripts/stage-plugin.sh`: stages the plugin for local IINA development
- `scripts/pack-release.sh`: builds a release archive
