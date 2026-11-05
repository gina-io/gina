`public` is the public directory.

## Progressive Web App (PWA)

This bundle is scaffolded with a starter PWA setup:

- `manifest.webmanifest` — the web app manifest (name, theme colour, icons, ...). Edit it to describe your app.
- `sw.js` — a service worker with a basic cache-first strategy. Edit `CACHE_NAME` and the precache list for your app.

The default layout (`templates/html/layouts/main.html`) already links the manifest and registers the service worker.

### Icons

No icon binaries ship with the scaffold — drop your own PNGs into this directory:

- `icon-192.png` — 192x192
- `icon-512.png` — 512x512
- `apple-touch-icon.png` — 180x180, used by `main.html` for the iOS home-screen icon

`favicon.ico` is the baseline icon already wired into `manifest.webmanifest`. Once you add the PNGs above, extend the `icons` array in `manifest.webmanifest` to point at them.
