# PicoPlex VR — handoff notes for Claude Code

This is a WebXR Plex client. Pico 4 is the first target; Quest and Steam Deck (in a browser) should also work. It's a static site with no build step.

The user is Griffon. He runs Plex in a container on Unraid at **192.168.1.8**, with OPNsense as the router.

**How he likes to work:**
- Diagnose one step at a time, with combined sequential commands
- Commands rather than manual edits
- Don't declare success before it's verified on the real headset or server

## Status (end of day 1, 2026-10-14)

**Verified, in headless Chromium against a mocked plex.tv and PMS (`tests/e2e_mock.py`):**
- PIN login
- Home user list, protected-user PIN (wrong PIN, then correct)
- Resource discovery, picking the HTTPS local plex.direct connection, using the per-server `accessToken`
- On Deck, paged library grid (150 per page, infinite scroll), show → season → episode list, detail page
- Direct play with native seek
- HLS playback, including in-buffer seek and far seek that restarts the transcode at an offset
- `/:/timeline` reporting, including the final `stopped` report, and watch-state refresh after playback
- Refused-stream error surfaces in the controls panel

**NOT yet verified (first things to test tomorrow):**
1. **Real PMS CORS** on the endpoints the app depends on:
   - `/photo/:/transcode` — posters go through fetch→ImageBitmap so the WebGL canvas isn't tainted
   - `/library/parts/...` for direct play — `<video crossorigin>`
   - The HLS chain
   - If posters fail, cards fall back to text placeholders. If direct play fails, the player auto-falls back to HLS.
2. **Real Plex HLS sub-playlist and segment auth.** `xhrSetup` in `player.js` appends `X-Plex-Token` to every request to the server. Confirm that PMS accepts this, and that `start.m3u8` with `X-Plex-Platform=Chrome` actually direct-streams H.264-in-MKV instead of transcoding. Check the Plex dashboard while playing.
3. **Pico browser specifics:**
   - Does the `select` event count as user activation for `video.play()` with audio? There's an Unmute fallback button for when it doesn't.
   - Gamepad axes indices: the code uses axes 2/3 when there are 4 axes, otherwise 0/1.
   - Is A/X at index 4 and B/Y at index 5 (xr-standard)?
   - Performance at framebuffer scale 1.2 with 4K video.
4. **Plex Home endpoints:** `/api/v2/home/users` and `/api/v2/home/users/{uuid}/switch`. Both have v1 XML fallbacks. Managed users must use the server `accessToken` from `/api/v2/resources`, not the switch token, which is what the code does.
5. **OPNsense DNS rebind:** `plex.direct` needs to be in Unbound Private Domains, otherwise only the relay/remote connection works. The sidebar shows `local`, `remote`, or `relay`.

## Layout

| File | Contents |
|---|---|
| `index.html` | Overlay buttons (Enter VR / Passthrough). Hidden `<video>`. Loads `vendor/hls.min.js` and then `js/main.js`. |
| `js/main.js` | Three.js scene and starfield; main panel group; screen group (video plane plus controls panel); controller rays and cursors; grab-to-move; thumbstick handling; desktop mouse/keyboard; XR session start, end, and recenter. Exposes `view` to App. |
| `js/app.js` | State machine (`login → users → pin → servers → browse`, with player overlay); nav stack (`ondeck / section / show / season / detail`); list cache and paging; all canvas drawing for the main panel and controls panel. |
| `js/ui.js` | `Panel`: a 2D canvas → CanvasTexture plane with hit regions registered during draw and UV→region hit testing. Drawing helpers. LRU image cache. |
| `js/plex.js` | `PlexTV` (pins, user, home users, switch, resources), `connectServer` (probes HTTPS connections in parallel, preferring local > remote > relay), `Server` (sections, onDeck, paging, children, metadata, image URL, direct play URL, HLS URL, timeline, scrobble). All `X-Plex-*` values go in the query string to avoid CORS preflight. |
| `js/player.js` | Direct play vs HLS decision, hls.js setup, seek logic, `baseOffsetMs` for transcode restarts, timeline every 10s. |
| `vendor/` | three.js r170 (single-file module) and hls.js 1.5.x, both vendored so it works offline on the LAN. |
| `tests/` | `make_mock.sh` (generates VP8/VP9 media; headless Chromium has no H.264) and `e2e_mock.py` (Playwright; routes plex.tv and `*.plex.direct` to mocks). |

## Conventions

- **UI is canvas-drawn.** Add hit areas with `panel.region(x, y, w, h, { id, onClick(relX, relY) })` *while drawing*. Hover is by `id`, so ids must stay stable across redraws. Call `invalidate()` to redraw; the texture re-uploads only when a panel is dirty.
- **Main panel coordinates:** 2048×1280 px, 2.4 m wide. Content area is x 420–2020, y 130–1260. Sidebar is 380 px.
- **Controls panel coordinates:** 1600×260 px, 1.6 m wide. It's a child of `screenGroup` and sits under the video.
- **Settings** live in localStorage under the `pp.*` keys: `pp.settings`, `pp.screen`, `pp.accountToken`, `pp.lastServer`, `pp.clientId`.

## Suggested next steps

Rough priority order:
1. Deploy to Unraid (see README), test on the Pico, and work through the "NOT yet verified" list.
2. Subtitles: the stream list from `/library/metadata/{rk}` lets you add a picker. Burn in via the HLS `subtitles=burn` parameter, or use sidecar WebVTT through `/library/streams/{id}`.
3. Audio track picker: `PUT /library/parts/{partId}?audioStreamID=…` before starting.
4. Up Next / auto-play the next episode, using the `onEnded` hook in `app.afterPlayback`.
5. Better picture: render video through a WebXR Layers `XRMediaBinding` quad or cylinder layer when available, for sharper and lower-cost video.
6. 3D SBS/OU and 180/360 modes. These are per-eye UV offsets on the screen material (`layers` 1/2 for left/right eyes in three.js).
7. Search (`/hubs/search?query=`) with an in-VR keyboard.
8. Package for the Pico store via Web App Runtime (PWA manifest is already present).
