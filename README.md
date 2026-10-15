# PicoPlex VR

A WebXR Plex client for Pico 4 (and any WebXR headset). It's a static site with no build step and no backend.

**What it does:**
- Plex PIN login (plex.tv/link)
- Plex Home user picker with PIN-protected users
- Library browsing: On Deck, Movies, TV → Seasons → Episodes
- Watch-state badges
- Full-resolution playback on a movable, resizable screen in a black/starfield void
- Progress and watched status written back to your Plex server

## Deploy (Unraid, Plex at 192.168.1.8)

The page must be served over **HTTPS with a certificate the Pico trusts**, because the Pico browser only allows WebXR on secure origins. The page itself never talks to `192.168.1.8` directly. It discovers your server through plex.tv and connects to its `https://192-168-1-8.<hash>.plex.direct:32400` address. That certificate is valid, so there are no mixed-content or cert problems on the Plex side.

**Option A: nginx container behind your existing reverse proxy (recommended)**

```bash
# on Unraid
mkdir -p /mnt/user/appdata/picoplex && cd /mnt/user/appdata/picoplex
# copy this folder's contents here (scp / SMB), then:
docker run -d --name picoplex --restart unless-stopped \
  -p 8089:80 -v /mnt/user/appdata/picoplex:/usr/share/nginx/html:ro nginx:alpine
```

Then point a proxy host at `http://192.168.1.8:8089` with a real certificate, for example `plexvr.yourdomain.tld`. This works with Nginx Proxy Manager, SWAG, or Caddy.

**Option B: any public static host** (GitHub Pages, Cloudflare Pages). Because it's a pure static client, this works too. The Plex traffic still stays on your LAN via plex.direct.

## Network gotcha: DNS rebind protection

`*.plex.direct` names resolve to private IPs. OPNsense Unbound blocks that by default, and if it does, the app can only reach the server over the remote or relay path, or not at all.

To fix it: **OPNsense → Services → Unbound DNS → Advanced → Private Domains → add `plex.direct`**, then apply.

The sidebar shows how the app connected: `Unraid · local`, `remote`, or `relay`. If it says relay or remote while you're at home, rebind protection is the likely cause. You can confirm by running `nslookup 192-168-1-8.<hash>.plex.direct` from a LAN machine; it should answer 192.168.1.8. The `<hash>` is visible in the server URL in devtools: `__app.server.uri`.

## Plex server settings

- **Settings → Network → Secure connections:** `Preferred` (the default) or `Required`. With `Disabled`, there are no HTTPS connections and the app can't connect.
- **Video played threshold** (Settings → Library) decides when a title counts as watched from timeline reports. The default is 90%.
- Transcoding to H.264 at source resolution uses your RTX 3060 if hardware transcoding is enabled.

## Using it on the Pico 4

1. Open the URL in the Pico browser and press **Enter VR**. If the headset supports it, **Enter Passthrough** is also offered.
2. Link the device at plex.tv/link using the code shown. You only do this once; the token is stored in browser localStorage.
3. Pick a user. Protected users get an in-VR PIN pad.

| Input | Action |
|---|---|
| Trigger | Click |
| Thumbstick ↕ (browsing) | Scroll |
| Thumbstick ↔ (playing) | Seek ±10s |
| Thumbstick ↕ (playing) | Resize screen |
| Grip (hold) + move | Move the panel or screen. While gripping, thumbstick ↕ pushes or pulls it. |
| A / X | Play / pause |
| B / Y | Back, or stop playback |
| Click the video | Show or hide controls (they auto-hide after 5s) |

On desktop, use the mouse to click, the wheel to scroll (or resize while playing), Esc for back, Space for play/pause, and ←/→ to seek.

URL parameters: `?fb=1.0` sets the XR framebuffer scale (default 1.2). Lower it if the Pico drops frames on 4K. `?debug` exposes `window.__dbg`.

## How playback works

| Source | Path |
|---|---|
| MP4/MOV + H.264 + AAC/MP3 | **Direct Play**: the original file over HTTP range requests. Native seeking. |
| Everything else (MKV, HEVC, AC3/EAC3/DTS/TrueHD audio…) | **Universal transcoder over HLS** with `directStream=1` and `videoResolution` = source resolution. H.264 video in MKV is remuxed untouched. HEVC is transcoded to H.264 at full resolution unless **HEVC: On** is set in the sidebar, which adds an HEVC transcode target. Seeking outside the buffer restarts the transcode at the new offset. |

Progress is reported to `/:/timeline` every 10s and on play, pause, seek, and stop. That keeps Continue Watching, On Deck, and the watched flag correct in every Plex client. **Mark watched / unwatched** on the detail page uses `/:/scrobble` and `/:/unscrobble`.

## Tests

```bash
pip install playwright pillow && playwright install chromium   # plus ffmpeg
tests/make_mock.sh && python3 tests/e2e_mock.py
```

This runs the full flow in headless Chromium against a mocked plex.tv and PMS:
- login
- wrong and correct PIN
- connection selection
- paging
- direct play with seek
- refused-stream error
- real HLS with in-buffer and restart seeks
- the TV hierarchy

Screenshots go to `tests/shots/`.
