// NAME: Album Length
// AUTHOR: yusufaf
// VERSION: 1.0.0
// DESCRIPTION: Show the length of each track's source album/EP inline in playlists, Liked Songs, and the Queue.

(function () {
'use strict';

//#region Type Definitions

/**
 * @typedef {Object} AlbumLengthConfig
 * @property {'inline'|'column'|'tooltip'} displayMode
 * @property {'short'|'colon'|'long'|'auto'} format
 * @property {{playlist: boolean, likedSongs: boolean, queue: boolean}} surfaces
 * @property {boolean} hideSingles
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

/** Tracklist selectors */
const SEL_TRACKLIST_ROW = '[data-testid="tracklist-row"]';
/** Anchor inside a row that links to the album the track belongs to. */
const SEL_ALBUM_LINK = 'a[href^="/album/"]';

/** Default config */
/** @type {AlbumLengthConfig} */
const DEFAULT_CONFIG = {
  displayMode: 'inline',
  format: 'short',
  surfaces: { playlist: true, likedSongs: true, queue: true },
  hideSingles: true
};

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

/** @returns {AlbumLengthConfig} */
function loadConfig() {
  try {
    const raw = Spicetify.LocalStorage.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      surfaces: { ...DEFAULT_CONFIG.surfaces, ...(parsed.surfaces || {}) }
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
      const res = await Spicetify.CosmosAsync.get(
        `wg://album/v1/album-app/album/${albumId}/desktop`
      );
      const tracks = collectTracks(res);
      const totalMs = tracks.reduce((sum, t) => sum + (t?.duration?.milliseconds || t?.duration || 0), 0);

      const albumType = (res?.type || res?.album_type || '').toLowerCase();
      const isSingleOneTrack = albumType === 'single' && tracks.length === 1;

      const value = isSingleOneTrack ? SUPPRESS : totalMs;
      albumDurationCache.set(albumId, value);
      persistCache();
      return value;
    } catch (e) {
      console.warn('[Album Length] Cosmos fetch failed for', albumId, e);
      return null;
    } finally {
      inFlight.delete(albumId);
    }
  })();

  inFlight.set(albumId, promise);
  return promise;
}

/**
 * The desktop album endpoint returns tracks under res.discs[].tracks; older
 * variants flatten to res.tracks. Handle both.
 * @param {*} res
 * @returns {Array<{duration: any}>}
 */
function collectTracks(res) {
  if (!res) return [];
  if (Array.isArray(res.tracks)) return res.tracks;
  if (Array.isArray(res.discs)) {
    return res.discs.flatMap((d) => Array.isArray(d.tracks) ? d.tracks : []);
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
 * @param {HTMLElement} row
 * @returns {{albumId: string, albumLink: HTMLAnchorElement}|null}
 */
function extractAlbumFromRow(row) {
  const anchor = row.querySelector(SEL_ALBUM_LINK);
  if (!anchor) return null;
  const href = anchor.getAttribute('href') || '';
  const match = href.match(/^\/album\/([A-Za-z0-9]+)/);
  if (!match) return null;
  return { albumId: match[1], albumLink: anchor };
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
 * Removes any badge previously injected on this album link / row.
 * @param {HTMLAnchorElement} albumLink
 */
function removeBadge(albumLink) {
  const cell = albumLink.parentElement;
  if (!cell) return;
  cell.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
}

/**
 * Injects (or refreshes) the badge on a row according to the active display mode.
 * @param {HTMLElement} row
 */
async function injectIntoRow(row) {
  const info = extractAlbumFromRow(row);
  if (!info) return;
  const { albumId, albumLink } = info;

  // Skip if this row already has a badge for this album in the current mode.
  if (albumLink.dataset.alAlbum === albumId && albumLink.dataset.alMode === currentConfig.displayMode) {
    return;
  }
  // Stale: clean up before re-injecting in the new mode.
  removeBadge(albumLink);
  detachTooltipHandlers(albumLink);
  delete albumLink.dataset.alAlbum;
  delete albumLink.dataset.alMode;

  const ms = await getAlbumDurationMs(albumId);
  if (ms === SUPPRESS && currentConfig.hideSingles) return;
  if (typeof ms !== 'number') return;

  const text = formatDuration(ms, currentConfig.format);

  switch (currentConfig.displayMode) {
    case 'tooltip':
      attachTooltipHandlers(albumLink, text);
      break;
    case 'column':
      // Column mode is a v1.1 stub — fall back to inline for now so users still
      // see the data. Settings UI marks the option as "Coming soon".
    case 'inline':
    default:
      appendInlineBadge(albumLink, text);
      break;
  }

  albumLink.dataset.alAlbum = albumId;
  albumLink.dataset.alMode = currentConfig.displayMode;
}

function appendInlineBadge(albumLink, text) {
  const cell = albumLink.parentElement;
  if (!cell) return;
  const badge = document.createElement('span');
  badge.className = BADGE_CLASS;
  badge.textContent = ` · ${text}`;
  badge.setAttribute('aria-label', `Album length: ${text}`);
  cell.appendChild(badge);
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
  document.querySelectorAll(`a[data-al-album]`).forEach((el) => {
    detachTooltipHandlers(el);
    delete el.dataset.alAlbum;
    delete el.dataset.alMode;
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
  const rows = document.querySelectorAll(SEL_TRACKLIST_ROW);
  rows.forEach((row) => { injectIntoRow(row); });
}

function scheduleInject() {
  clearTimeout(injectDebounceTimer);
  injectDebounceTimer = setTimeout(injectAll, 120);
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
      font-size: inherit;
      margin-left: 2px;
      pointer-events: none;
      white-space: nowrap;
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
    .al-settings { display: flex; flex-direction: column; gap: 16px; min-width: 320px; }
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
      <label><input type="radio" name="al-mode" value="inline"  ${config.displayMode === 'inline'  ? 'checked' : ''}> Inline (append to album cell)</label>
      <label><input type="radio" name="al-mode" value="tooltip" ${config.displayMode === 'tooltip' ? 'checked' : ''}> Tooltip (hover album cell)</label>
      <label class="al-disabled"><input type="radio" name="al-mode" value="column" disabled> Column &mdash; coming soon</label>
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
    </div>

    <div class="al-actions">
      <button type="button" class="al-btn secondary" data-action="clear-cache">Clear cached album lengths</button>
    </div>
  `;

  const applyChange = () => {
    const updated = {
      displayMode: container.querySelector('input[name="al-mode"]:checked')?.value || 'inline',
      format: container.querySelector('input[name="al-format"]:checked')?.value || 'short',
      surfaces: {
        playlist: container.querySelector('input[name="al-surface-playlist"]').checked,
        likedSongs: container.querySelector('input[name="al-surface-likedSongs"]').checked,
        queue: container.querySelector('input[name="al-surface-queue"]').checked
      },
      hideSingles: container.querySelector('input[name="al-hide-singles"]').checked
    };
    currentConfig = updated;
    saveConfig(updated);
    clearAllBadges();
    scheduleInject();
  };

  container.querySelectorAll('input').forEach((input) => {
    input.addEventListener('change', applyChange);
  });

  container.querySelector('[data-action="clear-cache"]').addEventListener('click', () => {
    clearCache();
    Spicetify.showNotification?.('[Album Length] Cache cleared');
  });

  Spicetify.PopupModal.display({
    title: 'Album Length',
    content: container
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
  registerMenuItem();
  setupObserver();
  scheduleInject();

  console.log('[Album Length] Initialized');
})();

//#endregion

})();
