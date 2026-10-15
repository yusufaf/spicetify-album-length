# Live Tests — Album Length

Extension file: `album-length.js`  
Use skill `spicetify-live-test` for CDP mechanics (reload, eval, screenshot, console).

## Storage keys (`Spicetify.LocalStorage.get(key)` or `localStorage.getItem(key)`)

| Key | Contents |
|-----|----------|
| `album-length-config` | JSON config object |
| `album-length-cache` | JSON map of albumId → duration (seconds) |

## Smoke test (run after every edit)

1. `node --check album-length.js` — syntax gate.
2. CDP reload xpui.
3. Console (filter `Album Length`): expect `[Album Length] Starting...` then `[Album Length] Initialized`.
4. Navigate to any album page; screenshot.

```js
// Eval to verify storage readable
Spicetify.LocalStorage.get('album-length-config')   // → JSON string or null
Spicetify.LocalStorage.get('album-length-cache')    // → JSON string or null (may be large)
```

## T1: Duration shown on album page

- Navigate Spotify to any album page with many tracks.
- Screenshot: verify total duration is injected (e.g. "1h 23m" or "83 min") near track list or album header.
- Eval: check the DOM element the extension injects:
  ```js
  document.querySelector('[data-testid="album-length-total"]')?.textContent
  // or search for the injected span — adjust selector to match the actual DOM
  ```

## T2: Cache populates after first visit

- Eval before navigating: `Object.keys(JSON.parse(Spicetify.LocalStorage.get('album-length-cache') || '{}')).length` → N.
- Navigate to an album not yet in cache.
- Wait ~2 s; eval again → N+1 (new albumId key written).

## T3: Config defaults survive missing key

- `Spicetify.LocalStorage.remove('album-length-config')` then reload.
- Assert: `[Album Length] Initialized` in console; no errors.
- Eval: `Spicetify.LocalStorage.get('album-length-config')` → non-null (defaults written back).

## T4: Cache clear does not break extension

- Eval: `Spicetify.LocalStorage.remove('album-length-cache')` (or set to `'{}'`).
- Navigate to an album page.
- Assert: duration still appears (fetches fresh from API, re-populates cache).
- No `[Album Length] Failed` errors in console.

## T5: Hot-reload sanity

- Add `console.log('[Album Length] HOT-RELOAD-MARKER')` near line 850.
- CDP reload; console filter `HOT-RELOAD-MARKER`: must appear.
- Revert.

## T6: Settings footer links

- Profile menu (top-right avatar) → **Album Length**.
- Eval: each footer link has the right target and is the element hit at its own centre:
  ```js
  [...document.querySelectorAll('.al-settings-footer a[href]')].map(a => {
    const r = a.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { text: a.textContent.trim() || a.getAttribute('aria-label'), href: a.href,
             target: a.target, color: getComputedStyle(a).color, clickable: a.contains(hit) };
  })
  ```
- Assert three links, in order:
  - Docs → `https://spicetify.yusufaf.dev/album-length/`
  - More extensions → `https://spicetify.yusufaf.dev/`
  - GitHub icon → `…/spicetify-album-length/issues/new`, with `aria-label` "Report an issue on GitHub"
- Assert every link has `target: "_blank"` and `clickable: true`.
- Assert every link's color is `--spice-subtext`: `rgb(179, 179, 179)` on the stock theme, not
  the white of Spotify's global `a:not([data-encore-id])` rule. The icon's `svg` fill matches it.
- Hover and keyboard focus: with CDP `CSS.forcePseudoState` (`hover` / `focus-visible`) the color
  turns `--spice-text`, and focus draws a 2px outline.
- Check against a light theme as well, per CLAUDE.md: the footer background is `--spice-player`,
  the same as the popup, so the links must stay readable when that is light.
