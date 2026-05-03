# Trakt Scrobbler

Trakt Scrobbler is an IINA plugin that scrobbles local movies and episodes to Trakt. It parses file names with `guessit-js`, matches them on Trakt, and keeps track of playback as you watch.

## Install

The best way to install it is from IINA itself.

- Open `Plugins` in IINA, choose `Install from GitHub`
- Paste `i3p9/iina-trakt-scrobbler`, and install it
- Restart IINA, and you should see the Trakt Scrobbler sidebar in the sidebar list. Click it, and follow the instructions to authenticate with Trakt.
- Keyboard shortcut for trakt sidebar: `⌘+T`
  That is also the best way to get future updates.

If you prefer, you can also download the `.iinaplgz` package from GitHub Releases and install that manually.

## Features

- Trakt device auth
- Movie and episode parsing with `guessit-js`
- Automatic Trakt matching
- `start`, `pause`, and `stop` scrobbling
- Preview and fast-pause guards
- Live sidebar with auth, playback, and scrobble status

<img width="364" height="458" alt="image" src="https://github.com/user-attachments/assets/eecc409f-08e8-402d-9bca-dbe22c046453" />

## Todo

- Cache playback locally when a scrobble cannot be sent, then retry or reconcile it later
- Add a manual search / correction flow in the sidebar for cases where a file is misidentified
- Show when a plugin update is available in the sidebar

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

## Notes

- Tokens are stored in the macOS keychain when possible, with an `@data` fallback during development.
- Search results are cached in `@data/trakt-cache.json`.
- Debug logs are written to `@data/debug.log`.

## Acknowledgements

Inspired by `trakt-scrobbler`.
