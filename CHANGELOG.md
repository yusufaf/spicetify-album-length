# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/yusufaf/spicetify-album-length/releases/tag/v1.0.0
