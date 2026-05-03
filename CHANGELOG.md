# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.1]: https://github.com/yusufaf/spicetify-album-length/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/yusufaf/spicetify-album-length/releases/tag/v1.0.0
