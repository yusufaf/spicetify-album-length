// NAME: Album Length
// AUTHOR: yusufaf
// DESCRIPTION: Show the length of each track's source album/EP inline in playlists, Liked Songs, and the Queue.
//
// Album Length moved to https://github.com/yusufaf/spicetify-extensions/tree/main/extensions/album-length
// This file only loads it from there, so installs from this repository keep updating.
// Install it from the new location to stop depending on this redirect.

(function () {
  if (window.__albumLengthActive) return;
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/gh/yusufaf/spicetify-extensions@main/extensions/album-length/album-length.js';
  script.onerror = () => console.error('[Album Length] Could not load the extension from https://cdn.jsdelivr.net/gh/yusufaf/spicetify-extensions@main/extensions/album-length/album-length.js');
  document.head.appendChild(script);
})();
