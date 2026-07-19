# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Spicetify extension (`album-length.js`, ~1100 lines, no build step) that appends each track's *source album* duration to tracklist rows in Spotify's desktop client. Everything ships as one IIFE: config, storage, fetching, DOM injection, styles, and the settings modal.

## Commands

```bash
pnpm test          # node --check album-length.js — syntax gate, the only automated test
pnpm install       # installs husky hooks via `prepare`
```

Husky runs `pnpm test` on pre-commit and `commitlint` (config-conventional) on commit-msg. Commit messages **must** be Conventional Commits — release-please parses them to cut releases.

### Testing changes in the real client

There is no unit test suite. Verification is manual against a running Spotify:

1. Copy `album-length.js` to `%APPDATA%\spicetify\Extensions\` (Windows) or `~/.config/spicetify/Extensions/`.
2. `spicetify apply` — Spotify restarts.
3. DevTools (`Ctrl+Shift+J`), filter console for `[Album Length]`.

`tests.live.md` holds the live smoke-test checklist (T1–T5: injection, cache population, config defaults, cache clear, hot-reload). Use the `spicetify-live-test` skill for CDP mechanics (reload xpui, eval against `Spicetify.*`, screenshot) instead of asking the user to click through manually.

## Architecture

**Single MutationObserver → debounced full sweep.** `setupObserver()` watches `.Root__main-view` (subtree) plus `Spicetify.Platform.History.listen`. Every mutation calls `scheduleInject()` (120 ms debounce) → `injectAll()` walks *all* visible rows → `injectIntoRow()` per row. There is no per-row observer; rows are re-scanned wholesale because Spotify virtualizes and re-renders them constantly.

**Two-tier fetch with fallback** (`fetchAlbumSummary`): legacy Cosmos `wg://album/v1/album-app/album/<id>/desktop` first, then `Spicetify.GraphQL.Request(Definitions.getAlbum)`. Newer Spotify builds have dropped the Cosmos endpoint, and the GraphQL `albumUnion` shape varies by schema version — hence `collectTracksLegacy`/`collectTracksGraphQL` both probe several shapes. When Spotify breaks the extension, this is almost always where.

**Caching is permanent by design.** Album durations never change, so `albumDurationCache` (in-memory `Map`) is mirrored to `Spicetify.LocalStorage` under `album-length-cache` with no TTL. `inFlight` dedupes concurrent fetches for the same album id. A `null` value (`SUPPRESS`) is a cached *decision* to hide the badge (one-track single), not a cache miss — don't conflate `null` with "not fetched".

**Idempotency is the hard part.** Spotify renders sibling `.main-trackList-trackListRow` elements at near-identical vertical positions (content row + interaction overlay), and rows can nest. Duplicate badges are guarded at four layers, all intentional:
- `extractAlbumFromRow` — skips an anchor whose `closest(SEL_TRACKLIST_ROW)` isn't this row (nested-row ownership).
- `injectAll` — sorts rows by `getBoundingClientRect().top`, skips any within 4 px of the previous (overlay twins).
- `appendInlineBadge` — refuses if a badge already exists in row scope or visually overlaps (±8 px top, ±240 px left).
- `sweepDuplicateBadges` — runs 250 ms after each sweep, removes visually-overlapping leftovers.

Before simplifying any of these, read the comments above them — each was added for a specific observed bug.

**Row state lives in `dataset` on the row, not the badge**: `alAlbum`, `alMode`, `alPlacement`, `alColor` form the cache key for "already rendered correctly"; `alPending` guards the async gap in `injectIntoRow` (the row can be recycled or the config can change mid-await, so both `document.contains(row)` and the `alPending` identity are re-checked after the await).

### Storage keys

| Key | Contents |
|-----|----------|
| `album-length-config` | JSON `AlbumLengthConfig` — see the typedef at the top of the file |
| `album-length-cache` | JSON map albumId → duration ms (or `null` for suppressed singles) |

Config load is defensive: `normalizeHex`, `normalizeThresholds` (forces ascending order), and `normalizeColors` sanitize whatever is in localStorage against `DEFAULT_CONFIG` before use.

### Surfaces

`detectSurface()` maps pathname → `playlist` | `likedSongs` | `queue` | `null`, and each is independently toggleable. A `null` surface means `injectAll()` clears all badges rather than doing nothing — badges must not survive navigation to an unsupported view.

## Conventions

- Keep code in `//#region` blocks; JSDoc on functions (the typedefs at the top drive editor tooling since there's no TypeScript).
- Console output is prefixed `[Album Length]`. Expected-and-handled failures use `console.debug`, unexpected ones `console.warn`.
- Styles are one injected `<style id="al-styles">`; theme colors come from `--spice-*` CSS vars, so changes must be checked against both light and dark themes.
- The version lives in the file header between `x-release-please-start-version` / `x-release-please-end-version` markers, and in `package.json`/`version.txt`. **Don't bump versions by hand** — release-please owns all three via `release-please-config.json`.
- `manifest.json` is the Spicetify Marketplace descriptor; `preview` must point at a file that actually exists in the repo.
