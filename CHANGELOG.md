# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0](https://github.com/yusufaf/spicetify-album-length/compare/v1.0.3...v1.1.0) (2026-07-20)


### Features

* customizable badge colors and length thresholds ([#4](https://github.com/yusufaf/spicetify-album-length/issues/4)) ([356b306](https://github.com/yusufaf/spicetify-album-length/commit/356b306752920144b6a3b9e55fa8b677c1402d58))


### Bug Fixes

* enlarge Album Length settings modal ([219a95c](https://github.com/yusufaf/spicetify-album-length/commit/219a95c5d9b3bcdd2b6e66fe7b933878debbcdf0))

## [1.0.3](https://github.com/yusufaf/spicetify-album-length/compare/v1.0.2...v1.0.3) (2026-06-13)


### Bug Fixes

* distinct color-coding palette and stacked duration placement ([300e25f](https://github.com/yusufaf/spicetify-album-length/commit/300e25f07d89b0b66e7f6a914e0e5cd902ae634e))

## [1.0.2] - 2026-05-16

### Fixed
- Duplicate album-length badges (`· 41m · 41m`) could still appear during fast scroll despite the 1.0.1 row-position dedup. The exact race wasn't pinned down — diagnostic logging showed the layered defenses never tripped once added — but the layered approach empirically stopped reproductions. Three layers added:
  - **Proximity row dedup in `injectAll`**: rows are sorted by `getBoundingClientRect().top` and any row within 4px of the previous is skipped, catching sub-pixel sibling overlay rows the strict-equality check in 1.0.1 missed.
  - **Append-time visual-position guard in `appendInlineBadge`**: before appending, scans every existing badge in the document and bails if one already sits within 8px vertical / 240px horizontal of the target cell.
  - **Post-injection janitor `sweepDuplicateBadges`**: runs 250ms after each `injectAll` and removes any badge whose visual position overlaps an earlier one — a final safety net if two injections race past the per-append guards.

## [1.0.1] - 2026-05-03

### Fixed
- Duplicate album-length badges appearing during fast scrolling. Spotify renders sibling `.main-trackList-trackListRow` elements at the same DOM level per visual track (a content row plus an interaction overlay); `querySelectorAll` found both and injected a badge into each. `injectAll` now deduplicates rows by vertical pixel position (`getBoundingClientRect().top`), skipping any row whose position was already processed.
- Additional defensive layers added: in-flight `alPending` guard prevents concurrent async re-injections into the same link; `document.contains` check abandons injections for elements detached by Spotify's virtualizer mid-fetch; row-scoped badge `querySelector` in `appendInlineBadge` as a last resort; `window.__albumLengthActive` flag prevents re-execution if Spicetify injects the script more than once per session.

## [1.0.0] - 2026-04-25

### Added
- Inline album-length badge appended to the existing **Album** cell in tracklists (e.g. `Currents · 51m`)
- Per-surface toggles for **Playlists**, **Liked Songs**, and the **Queue**
- Format options: `Short` (`1h 23m`), `Colon` (`1:23:00`), `Long` (`1 hour 23 minutes`), and `Auto` (hybrid)
- Tooltip display mode as an alternative to the inline badge
- Auto-suppression of the badge on singles (when the track *is* the album)
- Indefinite caching of album durations in `Spicetify.LocalStorage` (album lengths don't change)
- Settings modal accessible via the Spotify profile menu ("Album Length")
- Manual cache clear from the settings modal
- GraphQL `getAlbum` fallback when the legacy Cosmos endpoint (`wg://album/v1/album-app/album/<id>/desktop`) is unavailable on newer Spotify builds

[1.0.2]: https://github.com/yusufaf/spicetify-album-length/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/yusufaf/spicetify-album-length/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/yusufaf/spicetify-album-length/releases/tag/v1.0.0
