// NAME: Album Length
// AUTHOR: yusufaf
// x-release-please-start-version
// VERSION: 1.1.0
// x-release-please-end-version
// DESCRIPTION: Show the length of each track's source album/EP inline in playlists, Liked Songs, and the Queue.

(function () {
'use strict';

// Prevent the extension from running more than once per page session (e.g. if
// Spicetify injects the script multiple times without a full page reload).
if (window.__albumLengthActive) return;
window.__albumLengthActive = true;

//#region Type Definitions

/**
 * @typedef {Object} AlbumLengthConfig
 * @property {'inline'|'tooltip'} displayMode
 * @property {'album'|'duration'} placement
 * @property {'short'|'colon'|'long'|'auto'} format
 * @property {{playlist: boolean, likedSongs: boolean, queue: boolean}} surfaces
 * @property {boolean} hideSingles
 * @property {boolean} colorCoding
 * @property {{short: string, medium: string, long: string, xlong: string}} colors - Hex color per length tier.
 * @property {{short: number, medium: number, long: number}} thresholds - Tier boundaries in minutes, ascending.
 */

/**
 * @typedef {Object} AlbumCacheEntry
 * @property {number|null} ms - Total album duration in ms; null if suppressed (single).
 * @property {number} cachedAt
 */

//#endregion

//#region Constants

/** LocalStorage key for config */
const CONFIG_KEY = 'album-length-config';

/** LocalStorage key for cached album durations */
const CACHE_KEY = 'album-length-cache';

/** Container/menu identifiers */
const BADGE_CLASS = 'al-badge';
const BADGE_DATA_ATTR = 'data-al-album';
const TOOLTIP_ID = 'al-tooltip';
const STYLE_ID = 'al-styles';

/**
 * Tracklist row selector. Spotify's track rows are `.main-trackList-trackListRow`
 * (the inner grid container). The header row uses `.main-trackList-trackListHeaderRow`,
 * so this class is unique to actual track rows. Older builds used
 * `[data-testid="tracklist-row"]` but that attribute was removed.
 */
const SEL_TRACKLIST_ROW = '.main-trackList-trackListRow';
/** Anchor inside a row that links to the album the track belongs to. */
const SEL_ALBUM_LINK = 'a[href^="/album/"]';

/** Default config */
/** @type {AlbumLengthConfig} */
const DEFAULT_CONFIG = {
  displayMode: 'inline',
  placement: 'album',
  format: 'short',
  surfaces: { playlist: true, likedSongs: true, queue: true },
  hideSingles: true,
  colorCoding: false,
  colors: {
    short: '#1ed760',
    medium: '#ffd24c',
    long: '#ff8a3d',
    xlong: '#ff5c5c'
  },
  thresholds: {
    short: 30,
    medium: 60,
    long: 120
  }
};

/** Length tiers, ordered shortest to longest. Drives the palette and the settings UI. */
const COLOR_TIERS = ['short', 'medium', 'long', 'xlong'];

/** The three editable tier boundaries (xlong is open-ended, so it has no boundary of its own). */
const THRESHOLD_TIERS = ['short', 'medium', 'long'];

/** Sentinel for cache entries that should not render (singles when hideSingles is on). */
const SUPPRESS = null;

//#endregion

//#region State

/** @type {Map<string, number|null>} albumId -> duration ms (null = suppressed/single) */
const albumDurationCache = new Map();

/** @type {Map<string, Promise<number|null>>} albumId -> in-flight fetch */
const inFlight = new Map();

/** @type {AlbumLengthConfig} */
let currentConfig = { ...DEFAULT_CONFIG };

/** @type {MutationObserver|null} */
let tracklistObserver = null;

/** @type {HTMLElement|null} Singleton tooltip element (tooltip mode) */
let tooltipElement = null;

/** Debounce timer for re-injection */
let injectDebounceTimer = null;

//#endregion

//#region Storage

/**
 * Coerces a user-entered color to a canonical `#rrggbb` string.
 * Accepts `#rgb` shorthand (expanded) and any letter casing.
 * @param {unknown} value
 * @param {string} fallback - Returned when the value isn't a valid hex color.
 * @returns {string}
 */
function normalizeHex(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return fallback;
}

/**
 * Coerces the tier boundaries to whole ascending minutes. Each value falls back to
 * the default when unparseable, then boundaries are pushed apart so that no tier
 * can become unreachable (e.g. a `medium` below `short` would never match).
 * @param {Partial<AlbumLengthConfig['thresholds']>} raw
 * @returns {AlbumLengthConfig['thresholds']}
 */
function normalizeThresholds(raw) {
  const clamp = (value, fallback) => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, 1), 100000);
  };
  const source = raw || {};
  const short = clamp(source.short, DEFAULT_CONFIG.thresholds.short);
  const medium = Math.max(clamp(source.medium, DEFAULT_CONFIG.thresholds.medium), short + 1);
  const long = Math.max(clamp(source.long, DEFAULT_CONFIG.thresholds.long), medium + 1);
  return { short, medium, long };
}

/**
 * Normalizes the color palette, falling back to the defaults for any missing or
 * malformed entry.
 * @param {Partial<AlbumLengthConfig['colors']>} raw
 * @returns {AlbumLengthConfig['colors']}
 */
function normalizeColors(raw) {
  const source = raw || {};
  const colors = {};
  for (const tier of COLOR_TIERS) {
    colors[tier] = normalizeHex(source[tier], DEFAULT_CONFIG.colors[tier]);
  }
  return colors;
}

/** @returns {AlbumLengthConfig} */
function loadConfig() {
  try {
    const raw = Spicetify.LocalStorage.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      surfaces: { ...DEFAULT_CONFIG.surfaces, ...(parsed.surfaces || {}) },
      colors: normalizeColors(parsed.colors),
      thresholds: normalizeThresholds(parsed.thresholds)
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** @param {AlbumLengthConfig} config */
function saveConfig(config) {
  Spicetify.LocalStorage.set(CONFIG_KEY, JSON.stringify(config));
}

function loadCache() {
  try {
    const raw = Spicetify.LocalStorage.get(CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    for (const [id, ms] of Object.entries(obj)) {
      albumDurationCache.set(id, ms);
    }
  } catch (e) {
    console.warn('[Album Length] Failed to load cache', e);
  }
}

function persistCache() {
  const obj = {};
  for (const [id, ms] of albumDurationCache.entries()) obj[id] = ms;
  try {
    Spicetify.LocalStorage.set(CACHE_KEY, JSON.stringify(obj));
  } catch (e) {
    console.warn('[Album Length] Failed to persist cache', e);
  }
}

function clearCache() {
  albumDurationCache.clear();
  try {
    Spicetify.LocalStorage.remove(CACHE_KEY);
  } catch {
    Spicetify.LocalStorage.set(CACHE_KEY, '{}');
  }
  // Remove any existing badges so they re-render
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
  document.querySelectorAll(`[${BADGE_DATA_ATTR}]`).forEach((el) => el.removeAttribute(BADGE_DATA_ATTR));
  scheduleInject();
}

//#endregion

//#region Metadata Fetching

/**
 * Returns the total duration of the given album in ms.
 * Returns null if the album should be suppressed (single & hideSingles).
 * Tries the legacy Cosmos endpoint first, then falls back to GraphQL.
 * @param {string} albumId
 * @returns {Promise<number|null>}
 */
async function getAlbumDurationMs(albumId) {
  if (albumDurationCache.has(albumId)) {
    return albumDurationCache.get(albumId);
  }
  if (inFlight.has(albumId)) {
    return inFlight.get(albumId);
  }

  const promise = (async () => {
    try {
      const result = await fetchAlbumSummary(albumId);
      if (!result) return null;

      const { totalMs, isSingleOneTrack } = result;
      const value = isSingleOneTrack ? SUPPRESS : totalMs;
      albumDurationCache.set(albumId, value);
      persistCache();
      return value;
    } finally {
      inFlight.delete(albumId);
    }
  })();

  inFlight.set(albumId, promise);
  return promise;
}

/**
 * @param {string} albumId
 * @returns {Promise<{totalMs: number, isSingleOneTrack: boolean}|null>}
 */
async function fetchAlbumSummary(albumId) {
  // 1) Legacy Cosmos endpoint — fastest, but deprecated on newer builds.
  try {
    const res = await Spicetify.CosmosAsync.get(
      `wg://album/v1/album-app/album/${albumId}/desktop`
    );
    const tracks = collectTracksLegacy(res);
    if (tracks.length > 0) {
      const totalMs = tracks.reduce((sum, t) => sum + (t?.duration?.milliseconds || t?.duration || 0), 0);
      const albumType = (res?.type || res?.album_type || '').toLowerCase();
      return { totalMs, isSingleOneTrack: albumType === 'single' && tracks.length === 1 };
    }
  } catch (e) {
    // Fall through to GraphQL.
    console.debug('[Album Length] wg:// fetch failed', albumId, e?.message || e);
  }

  // 2) GraphQL fallback (matches enhanced-pins.js getAlbum usage).
  try {
    if (Spicetify?.GraphQL?.Request && Spicetify?.GraphQL?.Definitions?.getAlbum) {
      const res = await Spicetify.GraphQL.Request(
        Spicetify.GraphQL.Definitions.getAlbum,
        {
          uri: `spotify:album:${albumId}`,
          locale: Spicetify.Locale?.getLocale?.() || 'en',
          limit: 500,
          offset: 0
        }
      );
      const album = res?.data?.albumUnion;
      if (album) {
        const trackItems = collectTracksGraphQL(album);
        const totalMs = trackItems.reduce((sum, ms) => sum + ms, 0);
        const albumType = (album.type || '').toLowerCase();
        if (totalMs > 0) {
          return { totalMs, isSingleOneTrack: albumType === 'single' && trackItems.length === 1 };
        }
      }
    }
  } catch (e) {
    console.warn('[Album Length] GraphQL fetch failed for', albumId, e?.message || e);
    return null;
  }

  console.warn('[Album Length] No usable album data for', albumId);
  return null;
}

/**
 * Legacy desktop endpoint may return tracks under res.discs[].tracks or res.tracks.
 * @param {*} res
 * @returns {Array<{duration: any}>}
 */
function collectTracksLegacy(res) {
  if (!res) return [];
  if (Array.isArray(res.tracks)) return res.tracks;
  if (Array.isArray(res.discs)) {
    return res.discs.flatMap((d) => Array.isArray(d.tracks) ? d.tracks : []);
  }
  return [];
}

/**
 * GraphQL albumUnion can use a few shapes depending on schema version. Pull
 * track-duration milliseconds out of each.
 * @param {*} album
 * @returns {number[]} per-track duration ms
 */
function collectTracksGraphQL(album) {
  const containers = [album.tracksV2, album.tracks];
  for (const container of containers) {
    if (!container?.items) continue;
    const out = [];
    for (const item of container.items) {
      const track = item.track || item;
      const ms =
        track?.duration?.totalMilliseconds ??
        track?.duration?.milliseconds ??
        (typeof track?.duration === 'number' ? track.duration : null) ??
        track?.trackDuration?.totalMilliseconds ??
        null;
      if (typeof ms === 'number') out.push(ms);
    }
    if (out.length > 0) return out;
  }
  return [];
}

//#endregion

//#region Formatters

/**
 * Format album duration ms according to current format setting.
 * @param {number} ms
 * @param {'short'|'colon'|'long'|'auto'} mode
 * @returns {string}
 */
function formatDuration(ms, mode) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  switch (mode) {
    case 'colon': return formatColon(hours, minutes, seconds);
    case 'long':  return formatLong(hours, minutes);
    case 'auto':  return formatAuto(totalSeconds, hours, minutes, seconds);
    case 'short':
    default:      return formatShort(hours, minutes);
  }
}

function formatShort(h, m) {
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function formatColon(h, m, s) {
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function formatLong(h, m) {
  const parts = [];
  if (h > 0) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m > 0) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  return parts.length ? parts.join(' ') : '0 minutes';
}

/**
 * Auto-hybrid: for under 10 minutes shows m:ss, otherwise short human.
 */
function formatAuto(totalSeconds, h, m, s) {
  if (totalSeconds < 600) return formatColon(0, m, s);
  return formatShort(h, m);
}

//#endregion

//#region Surface Detection

/**
 * Returns the active surface key based on current location, or null if the
 * current view is not a tracklist surface we care about.
 * @returns {'playlist'|'likedSongs'|'queue'|null}
 */
function detectSurface() {
  const path = Spicetify?.Platform?.History?.location?.pathname || location.pathname || '';
  if (path.startsWith('/playlist/')) return 'playlist';
  if (path === '/collection/tracks') return 'likedSongs';
  if (path === '/queue') return 'queue';
  return null;
}

/** True if the user has the current surface enabled in config. */
function surfaceEnabled() {
  const surface = detectSurface();
  if (!surface) return false;
  return !!currentConfig.surfaces[surface];
}

//#endregion

//#region DOM Injection

/**
 * Extracts the album id from a tracklist row.
 *
 * Rows typically contain TWO /album/ anchors: one wrapping the artwork in the
 * title cell (no text content), and one in the Album column (the album name as
 * text). We want the textual one — appending to the artwork link puts the
 * badge behind the image where it can't be seen.
 *
 * @param {HTMLElement} row
 * @returns {{albumId: string, albumLink: HTMLAnchorElement}|null}
 */
function extractAlbumFromRow(row) {
  const anchors = row.querySelectorAll(SEL_ALBUM_LINK);
  if (anchors.length === 0) return null;

  // The duration cell is usually the last cell, we can find it by class or testid
  const durationCell = row.querySelector('.main-trackList-duration') || row.querySelector('.main-trackList-rowDuration') || row.querySelector('[data-testid="tracklist-duration"]');

  for (const a of anchors) {
    if (!a.textContent.trim()) continue;
    // Only claim this anchor for `row` if `row` is its nearest tracklist-row
    // ancestor. If a nested element also carries SEL_TRACKLIST_ROW, that inner
    // element owns the anchor — not the outer one. This prevents the same
    // anchor being processed by multiple levels of a nested row hierarchy,
    // which would produce one badge per nesting level.
    if (a.closest(SEL_TRACKLIST_ROW) !== row) continue;
    const href = a.getAttribute('href') || '';
    const match = href.match(/^\/album\/([A-Za-z0-9]+)/);
    if (!match) continue;
    return { albumId: match[1], albumLink: a, durationCell };
  }
  return null;
}

/**
 * Creates or returns the singleton tooltip element.
 * @returns {HTMLElement}
 */
function getTooltipElement() {
  if (tooltipElement && document.body.contains(tooltipElement)) return tooltipElement;
  tooltipElement = document.createElement('div');
  tooltipElement.id = TOOLTIP_ID;
  tooltipElement.className = 'al-tooltip';
  document.body.appendChild(tooltipElement);
  return tooltipElement;
}

function showTooltip(target, text) {
  const tip = getTooltipElement();
  tip.textContent = text;
  const rect = target.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + 200 > window.innerWidth) left = window.innerWidth - 210;
  if (top + 32 > window.innerHeight) top = rect.top - 32;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.classList.add('visible');
}

function hideTooltip() {
  if (tooltipElement) tooltipElement.classList.remove('visible');
}

/**
 * Injects (or refreshes) the badge on a row according to the active display mode.
 * @param {HTMLElement} row
 */
async function injectIntoRow(row) {
  const info = extractAlbumFromRow(row);
  if (!info) return;
  const { albumId, albumLink, durationCell } = info;

  const targetCell = currentConfig.placement === 'duration' && durationCell ? durationCell : albumLink;

  // We attach data to the row instead of the link so it persists when switching placement modes
  if (row.dataset.alAlbum === albumId && 
      row.dataset.alMode === currentConfig.displayMode &&
      row.dataset.alPlacement === currentConfig.placement &&
      row.dataset.alColor === String(currentConfig.colorCoding)) {
    return;
  }
  if (row.dataset.alPending === albumId) return;

  // Clean up existing badges
  row.querySelectorAll(`.${BADGE_CLASS}`).forEach(el => el.remove());
  row.querySelectorAll('.al-has-badge').forEach(el => el.classList.remove('al-has-badge'));
  detachTooltipHandlers(albumLink);
  if (durationCell) detachTooltipHandlers(durationCell);
  
  delete row.dataset.alAlbum;
  delete row.dataset.alMode;
  delete row.dataset.alPlacement;
  delete row.dataset.alColor;

  row.dataset.alPending = albumId;
  const ms = await getAlbumDurationMs(albumId);

  if (!document.contains(row)) return;
  if (row.dataset.alPending !== albumId) return;
  delete row.dataset.alPending;

  if (ms === SUPPRESS && currentConfig.hideSingles) return;
  if (typeof ms !== 'number') return;

  const text = formatDuration(ms, currentConfig.format);

  switch (currentConfig.displayMode) {
    case 'tooltip':
      attachTooltipHandlers(targetCell, text);
      break;
    case 'inline':
    default:
      appendInlineBadge(targetCell, text, ms, currentConfig.placement);
      break;
  }

  row.dataset.alAlbum = albumId;
  row.dataset.alMode = currentConfig.displayMode;
  row.dataset.alPlacement = currentConfig.placement;
  row.dataset.alColor = String(currentConfig.colorCoding);
}

function appendInlineBadge(targetCell, text, ms, placement) {
  const cell = targetCell.parentElement;
  if (!cell && targetCell.tagName !== 'DIV') return;
  
  const rowScope = targetCell.closest(SEL_TRACKLIST_ROW) || cell;
  if (rowScope && rowScope.querySelector(`.${BADGE_CLASS}`)) return;
  
  // Visual guard
  const cellRect = (cell || targetCell).getBoundingClientRect();
  const existingBadges = document.querySelectorAll(`.${BADGE_CLASS}`);
  for (const existing of existingBadges) {
    const r = existing.getBoundingClientRect();
    if (Math.abs(r.top - cellRect.top) < 8 && Math.abs(r.left - cellRect.left) < 240) {
      return;
    }
  }
  
  const badge = document.createElement('span');
  badge.className = BADGE_CLASS;
  
  if (placement === 'duration') {
    badge.textContent = text;
    badge.classList.add('al-placement-duration');
  } else {
    badge.textContent = `${text}`;
    badge.classList.add('al-placement-album');
  }

  if (currentConfig.colorCoding) {
    badge.classList.add(colorClassFor(ms, currentConfig.thresholds));
  }

  badge.setAttribute('aria-label', `Album length: ${text}`);

  if (placement === 'duration') {
    // Stack the badge below the song length and right-align both (the duration
    // column is right-aligned in Spotify). al-has-badge turns the time cell into
    // a column flex so the time sits on top and the album length directly below.
    targetCell.classList.add('al-has-badge');
    targetCell.appendChild(badge);
  } else {
    cell.appendChild(badge);
  }
}

/**
 * Picks the palette class for a duration. Boundaries are user-configurable minutes.
 * @param {number} ms
 * @param {AlbumLengthConfig['thresholds']} thresholds
 * @returns {string}
 */
function colorClassFor(ms, thresholds) {
  if (ms < thresholds.short * 60000) return 'color-short';
  if (ms < thresholds.medium * 60000) return 'color-medium';
  if (ms < thresholds.long * 60000) return 'color-long';
  return 'color-xlong';
}

/**
 * Pushes the configured palette onto `:root` as CSS custom properties. The stylesheet
 * injected at startup is never re-run, so this is how color edits take effect live —
 * updating the variables repaints existing badges without re-rendering any rows.
 * @param {AlbumLengthConfig} config
 */
function applyColorVars(config) {
  const root = document.documentElement;
  for (const tier of COLOR_TIERS) {
    root.style.setProperty(`--al-color-${tier}`, config.colors[tier]);
  }
}

function attachTooltipHandlers(albumLink, text) {
  const onEnter = () => showTooltip(albumLink, text);
  const onLeave = () => hideTooltip();
  albumLink.addEventListener('mouseenter', onEnter);
  albumLink.addEventListener('mouseleave', onLeave);
  albumLink._alTooltipHandlers = { onEnter, onLeave };
}

function detachTooltipHandlers(albumLink) {
  const handlers = albumLink._alTooltipHandlers;
  if (!handlers) return;
  albumLink.removeEventListener('mouseenter', handlers.onEnter);
  albumLink.removeEventListener('mouseleave', handlers.onLeave);
  delete albumLink._alTooltipHandlers;
}

/**
 * Removes every badge in the document (used when surface is disabled or after
 * config changes that require a full re-render).
 */
function clearAllBadges() {
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
  document.querySelectorAll('.al-has-badge').forEach((el) => el.classList.remove('al-has-badge'));
  document.querySelectorAll(SEL_TRACKLIST_ROW).forEach((row) => {
    delete row.dataset.alAlbum;
    delete row.dataset.alMode;
    delete row.dataset.alPlacement;
    delete row.dataset.alColor;
    delete row.dataset.alPending;
    
    row.querySelectorAll('a, div').forEach(el => detachTooltipHandlers(el));
  });
}

/**
 * Walks the visible tracklist rows and injects badges where missing.
 */
function injectAll() {
  if (!surfaceEnabled()) {
    clearAllBadges();
    return;
  }
  // Spotify renders sibling ".main-trackList-trackListRow" elements per visual
  // track (e.g. a content row plus an interaction-overlay row) at the same —
  // or near-identical, sub-pixel-off — vertical position. Sort by `.top` and
  // skip any row that lands within a small pixel threshold of the previous
  // one, so the overlay copy doesn't also receive a badge. A strict equality
  // check (previous approach) missed pairs that differed by fractions of a
  // pixel from CSS transforms/virtualization.
  const rows = Array.from(document.querySelectorAll(SEL_TRACKLIST_ROW));
  rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  let lastTop = -Infinity;
  for (const row of rows) {
    const top = row.getBoundingClientRect().top;
    if (top - lastTop < 4) continue;
    lastTop = top;
    injectIntoRow(row);
  }
}

function scheduleInject() {
  clearTimeout(injectDebounceTimer);
  injectDebounceTimer = setTimeout(() => {
    injectAll();
    // After injections settle, sweep for any visually-duplicate badges that
    // slipped past the per-append guards (a final safety net).
    setTimeout(sweepDuplicateBadges, 250);
  }, 120);
}

/**
 * Removes any badge whose visual position overlaps an earlier badge. Belt-and-
 * suspenders for the duplicate-badge bug: even if two injections race past
 * every prior guard, this cleans the result.
 */
function sweepDuplicateBadges() {
  const badges = document.querySelectorAll(`.${BADGE_CLASS}`);
  /** @type {Array<{top: number, left: number}>} */
  const seen = [];
  badges.forEach((badge) => {
    const r = badge.getBoundingClientRect();
    for (const s of seen) {
      if (Math.abs(s.top - r.top) < 8 && Math.abs(s.left - r.left) < 240) {
        badge.remove();
        return;
      }
    }
    seen.push({ top: r.top, left: r.left });
  });
}

//#endregion

//#region Tracklist Observer

function setupObserver() {
  if (tracklistObserver) tracklistObserver.disconnect();

  // Observe the entire main view container — Spotify swaps this subtree on
  // navigation between playlist/Liked Songs/queue, and rows are added inside.
  const target = document.querySelector('.Root__main-view') || document.body;

  tracklistObserver = new MutationObserver(() => scheduleInject());
  tracklistObserver.observe(target, { childList: true, subtree: true });

  // Re-run on Spicetify navigation events.
  if (Spicetify?.Platform?.History?.listen) {
    Spicetify.Platform.History.listen(() => scheduleInject());
  }
}

//#endregion

//#region Styles

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${BADGE_CLASS} {
      color: var(--spice-subtext, #b3b3b3);
      pointer-events: none;
      white-space: nowrap;
    }
    .${BADGE_CLASS}.al-placement-album {
      display: block;
      font-size: 0.9em;
      margin-top: 2px;
    }
    .${BADGE_CLASS}.al-placement-duration {
      display: block;
      text-align: right;
      font-size: 0.85em;
      opacity: 0.8;
      margin-top: 2px;
    }
    /* Make the duration cell stack the song length and album length vertically,
       right-aligned to match Spotify's right-aligned duration column. */
    .main-trackList-duration.al-has-badge {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }
    /*
     * On hover/focus Spotify reveals the add-to-playlist (check) and more (...)
     * buttons inside the duration column. The add button is pinned to the left
     * of the duration, so our inline badge — which widens the duration cell
     * leftward — gets overlapped by it. Hide the badge while the row is hovered
     * or focused so those buttons reclaim their native space; the album length
     * reappears once the row is no longer interacted with.
     */
    .main-trackList-trackListRow:hover .${BADGE_CLASS}.al-placement-duration,
    .main-trackList-trackListRow:focus-within .${BADGE_CLASS}.al-placement-duration {
      display: none;
    }
    /* Graduated palette — distinct hues so each tier reads differently and none
       collide with the default subtext gray. The hex values are user-configurable;
       applyColorVars() writes them to :root, and the literals below are the
       fallbacks used before that runs. */
    .${BADGE_CLASS}.color-short {
      color: var(--al-color-short, #1ed760); /* shortest tier — green */
    }
    .${BADGE_CLASS}.color-medium {
      color: var(--al-color-medium, #ffd24c); /* yellow */
    }
    .${BADGE_CLASS}.color-long {
      color: var(--al-color-long, #ff8a3d); /* orange */
    }
    .${BADGE_CLASS}.color-xlong {
      color: var(--al-color-xlong, #ff5c5c); /* longest tier — red */
      font-weight: 600;
    }
    .al-tooltip {
      position: fixed;
      z-index: 99999;
      background: var(--spice-card, #282828);
      color: var(--spice-text, #fff);
      border: 1px solid var(--spice-button-disabled, #555);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .al-tooltip.visible { opacity: 1; }

    /* Settings modal */
    .al-settings { display: flex; flex-direction: column; gap: 16px; min-width: 480px; }
    .al-settings h3 { margin: 0 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--spice-subtext, #b3b3b3); }
    .al-settings label { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 4px 0; }
    .al-settings input[type="radio"], .al-settings input[type="checkbox"] { accent-color: var(--spice-button, #1ed760); }
    .al-settings .al-row { display: flex; flex-direction: column; gap: 4px; }
    .al-settings .al-actions { display: flex; gap: 8px; margin-top: 8px; }
    .al-settings button.al-btn {
      background: var(--spice-button, #1ed760);
      color: var(--spice-button-text, #000);
      border: none; border-radius: 999px;
      padding: 6px 14px; font-weight: 600; cursor: pointer;
    }
    .al-settings button.al-btn.secondary {
      background: transparent;
      color: var(--spice-text, #fff);
      border: 1px solid var(--spice-button-disabled, #555);
    }
    .al-settings .al-disabled { opacity: 0.5; cursor: not-allowed; }

    /* Palette editor: one row per tier — boundary input, swatch, hex field. */
    .al-settings [data-section="colors"][hidden] { display: none; }
    .al-settings .al-color-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
    .al-settings .al-color-label { flex: 1; display: flex; align-items: center; gap: 6px; cursor: default; padding: 0; }
    .al-settings .al-color-label input[type="number"] { width: 62px; }
    .al-settings input[type="number"], .al-settings input[type="text"] {
      background: var(--spice-card, #282828);
      color: var(--spice-text, #fff);
      border: 1px solid var(--spice-button-disabled, #555);
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 13px;
    }
    .al-settings input[type="text"] { width: 86px; font-family: monospace; }
    .al-settings input[type="color"] {
      width: 28px; height: 24px; padding: 0; cursor: pointer;
      background: none;
      border: 1px solid var(--spice-button-disabled, #555);
      border-radius: 4px;
    }
    .al-settings input.al-invalid { border-color: #ff5c5c; }
  `;
  document.head.appendChild(style);
}

//#endregion

//#region Settings UI

function showSettingsModal() {
  const config = loadConfig();
  const container = document.createElement('div');
  container.className = 'al-settings';

  container.innerHTML = `
    <div class="al-row">
      <h3>Display Mode</h3>
      <label><input type="radio" name="al-mode" value="inline"  ${config.displayMode === 'inline'  ? 'checked' : ''}> Subtext (persistent text)</label>
      <label><input type="radio" name="al-mode" value="tooltip" ${config.displayMode === 'tooltip' ? 'checked' : ''}> Tooltip (on hover)</label>
    </div>

    <div class="al-row">
      <h3>Placement</h3>
      <label><input type="radio" name="al-placement" value="album" ${config.placement === 'album' ? 'checked' : ''}> Album column (below album name)</label>
      <label><input type="radio" name="al-placement" value="duration" ${config.placement === 'duration' ? 'checked' : ''}> Duration column (below song length)</label>
    </div>

    <div class="al-row">
      <h3>Format</h3>
      <label><input type="radio" name="al-format" value="short" ${config.format === 'short' ? 'checked' : ''}> Short human (42m / 1h 23m)</label>
      <label><input type="radio" name="al-format" value="colon" ${config.format === 'colon' ? 'checked' : ''}> Colon (42:13 / 1:23:00)</label>
      <label><input type="radio" name="al-format" value="long"  ${config.format === 'long'  ? 'checked' : ''}> Long human (1 hour 23 minutes)</label>
      <label><input type="radio" name="al-format" value="auto"  ${config.format === 'auto'  ? 'checked' : ''}> Auto (m:ss under 10 min, otherwise short)</label>
    </div>

    <div class="al-row">
      <h3>Show On</h3>
      <label><input type="checkbox" name="al-surface-playlist"   ${config.surfaces.playlist   ? 'checked' : ''}> Playlists</label>
      <label><input type="checkbox" name="al-surface-likedSongs" ${config.surfaces.likedSongs ? 'checked' : ''}> Liked Songs</label>
      <label><input type="checkbox" name="al-surface-queue"      ${config.surfaces.queue      ? 'checked' : ''}> Queue</label>
    </div>

    <div class="al-row">
      <h3>Behavior</h3>
      <label><input type="checkbox" name="al-hide-singles" ${config.hideSingles ? 'checked' : ''}> Hide for singles (1-track albums)</label>
      <label><input type="checkbox" name="al-color-coding" ${config.colorCoding ? 'checked' : ''}> Color-code badges by length</label>
    </div>

    <div class="al-row" data-section="colors">
      <h3>Badge Colors</h3>
      <div class="al-color-row">
        <span class="al-color-label">Under <input type="number" name="al-threshold-short" min="1" max="100000" value="${config.thresholds.short}"> min</span>
        <input type="color" name="al-color-short" value="${config.colors.short}">
        <input type="text" name="al-hex-short" value="${config.colors.short}" maxlength="7" spellcheck="false" aria-label="Short tier hex color">
      </div>
      <div class="al-color-row">
        <span class="al-color-label"><span data-bound="short">${config.thresholds.short}</span> &ndash; <input type="number" name="al-threshold-medium" min="1" max="100000" value="${config.thresholds.medium}"> min</span>
        <input type="color" name="al-color-medium" value="${config.colors.medium}">
        <input type="text" name="al-hex-medium" value="${config.colors.medium}" maxlength="7" spellcheck="false" aria-label="Medium tier hex color">
      </div>
      <div class="al-color-row">
        <span class="al-color-label"><span data-bound="medium">${config.thresholds.medium}</span> &ndash; <input type="number" name="al-threshold-long" min="1" max="100000" value="${config.thresholds.long}"> min</span>
        <input type="color" name="al-color-long" value="${config.colors.long}">
        <input type="text" name="al-hex-long" value="${config.colors.long}" maxlength="7" spellcheck="false" aria-label="Long tier hex color">
      </div>
      <div class="al-color-row">
        <span class="al-color-label">Over <span data-bound="long">${config.thresholds.long}</span> min</span>
        <input type="color" name="al-color-xlong" value="${config.colors.xlong}">
        <input type="text" name="al-hex-xlong" value="${config.colors.xlong}" maxlength="7" spellcheck="false" aria-label="Extra long tier hex color">
      </div>
      <div class="al-actions">
        <button type="button" class="al-btn secondary" data-action="reset-colors">Reset colors &amp; thresholds</button>
      </div>
    </div>

    <div class="al-actions">
      <button type="button" class="al-btn secondary" data-action="clear-cache">Clear cached album lengths</button>
    </div>
  `;

  const colorSection = container.querySelector('[data-section="colors"]');
  const swatchFor = (tier) => container.querySelector(`input[name="al-color-${tier}"]`);
  const hexFieldFor = (tier) => container.querySelector(`input[name="al-hex-${tier}"]`);
  const thresholdFieldFor = (tier) => container.querySelector(`input[name="al-threshold-${tier}"]`);

  /** Everything except `colors` — a change here means badges must be re-rendered. */
  const structuralKey = (cfg) => JSON.stringify({ ...cfg, colors: undefined });

  /** Reflects normalized values back into the controls and shows/hides the section. */
  const syncColorSection = (cfg) => {
    for (const tier of THRESHOLD_TIERS) {
      thresholdFieldFor(tier).value = String(cfg.thresholds[tier]);
      const bound = colorSection.querySelector(`[data-bound="${tier}"]`);
      if (bound) bound.textContent = String(cfg.thresholds[tier]);
    }
    // Color coding never applies in tooltip mode (tooltips don't receive a duration),
    // so hide the palette rather than offer settings that do nothing.
    colorSection.hidden = !cfg.colorCoding || cfg.displayMode === 'tooltip';
  };

  const applyChange = () => {
    const previous = currentConfig;
    const thresholds = normalizeThresholds({
      short: thresholdFieldFor('short').value,
      medium: thresholdFieldFor('medium').value,
      long: thresholdFieldFor('long').value
    });
    const colors = {};
    for (const tier of COLOR_TIERS) {
      // The swatch is always a valid color; the hex field is only mirrored into it
      // once it parses, so reading the swatch keeps half-typed input from applying.
      colors[tier] = normalizeHex(swatchFor(tier).value, previous.colors[tier]);
    }

    const updated = {
      displayMode: container.querySelector('input[name="al-mode"]:checked')?.value || 'inline',
      placement: container.querySelector('input[name="al-placement"]:checked')?.value || 'album',
      format: container.querySelector('input[name="al-format"]:checked')?.value || 'short',
      surfaces: {
        playlist: container.querySelector('input[name="al-surface-playlist"]').checked,
        likedSongs: container.querySelector('input[name="al-surface-likedSongs"]').checked,
        queue: container.querySelector('input[name="al-surface-queue"]').checked
      },
      hideSingles: container.querySelector('input[name="al-hide-singles"]').checked,
      colorCoding: container.querySelector('input[name="al-color-coding"]').checked,
      colors,
      thresholds
    };

    const needsRerender = structuralKey(updated) !== structuralKey(previous);
    currentConfig = updated;
    saveConfig(updated);
    applyColorVars(updated);
    syncColorSection(updated);

    // Dragging the OS color picker fires `input` continuously; re-injecting every
    // frame would thrash the track list, and the CSS variables already repainted
    // the existing badges. Only rebuild when something else actually changed.
    if (needsRerender) {
      clearAllBadges();
      scheduleInject();
    }
  };

  for (const tier of COLOR_TIERS) {
    const swatch = swatchFor(tier);
    const hexField = hexFieldFor(tier);

    swatch.addEventListener('input', () => {
      hexField.value = swatch.value;
      hexField.classList.remove('al-invalid');
      applyChange();
    });

    hexField.addEventListener('input', () => {
      const parsed = normalizeHex(hexField.value, null);
      // Don't rewrite the field while it's being typed into — only flag it.
      hexField.classList.toggle('al-invalid', parsed === null);
      if (parsed === null) return;
      swatch.value = parsed;
      applyChange();
    });

    hexField.addEventListener('blur', () => {
      hexField.value = swatch.value;
      hexField.classList.remove('al-invalid');
    });
  }

  container.querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="number"]').forEach((input) => {
    input.addEventListener('change', applyChange);
  });

  container.querySelector('[data-action="reset-colors"]').addEventListener('click', () => {
    for (const tier of COLOR_TIERS) {
      swatchFor(tier).value = DEFAULT_CONFIG.colors[tier];
      hexFieldFor(tier).value = DEFAULT_CONFIG.colors[tier];
      hexFieldFor(tier).classList.remove('al-invalid');
    }
    for (const tier of THRESHOLD_TIERS) {
      thresholdFieldFor(tier).value = String(DEFAULT_CONFIG.thresholds[tier]);
    }
    applyChange();
  });

  syncColorSection(config);

  container.querySelector('[data-action="clear-cache"]').addEventListener('click', () => {
    clearCache();
    Spicetify.showNotification?.('[Album Length] Cache cleared');
  });

  Spicetify.PopupModal.display({
    title: 'Album Length',
    content: container,
    isLarge: true
  });
}

function registerMenuItem() {
  if (!Spicetify?.Menu?.Item) return;
  const item = new Spicetify.Menu.Item('Album Length', false, showSettingsModal);
  item.register();
}

//#endregion

//#region Bootstrap

(async function main() {
  while (
    !Spicetify?.Platform?.History ||
    !Spicetify?.CosmosAsync ||
    !Spicetify?.LocalStorage ||
    !Spicetify?.Menu?.Item ||
    !Spicetify?.PopupModal
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log('[Album Length] Starting...');

  currentConfig = loadConfig();
  loadCache();
  injectStyles();
  applyColorVars(currentConfig);
  registerMenuItem();
  setupObserver();
  scheduleInject();

  console.log('[Album Length] Initialized');
})();

//#endregion

})();
