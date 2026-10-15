// Playback engine: direct play when the browser can decode the file as-is, otherwise Plex universal
// transcoder over HLS (direct-stream at source resolution). Reports timeline to PMS so watch progress
// and completion are tracked server-side.

const Hls = window.Hls;
const TIMELINE_MS = 10000;

const BROWSER_AUDIO = new Set(['aac', 'mp3']);
const MP4_CONTAINERS = new Set(['mp4', 'm4v', 'mov']);

export class Player {
  constructor(video, hooks = {}) {
    this.video = video;
    this.hooks = hooks; // onState(state), onError(msg), onEnded()
    this.hls = null;
    this.server = null;
    this.item = null;
    this.mode = null;        // 'direct' | 'hls'
    this.baseOffsetMs = 0;   // HLS transcodes restart at an offset; video.currentTime is relative to it
    this.session = null;
    this.state = 'stopped';
    this.timer = null;
    this.seekTimer = null;
    this.pendingSeekMs = null;
    this.hevc = false;
    this.triedHlsFallback = false;

    video.addEventListener('playing', () => this._setState('playing'));
    video.addEventListener('pause', () => { if (!video.ended && this.state !== 'stopped') this._setState('paused'); });
    video.addEventListener('waiting', () => this._setState('buffering'));
    video.addEventListener('ended', () => this._ended());
    video.addEventListener('error', () => this._videoError());
  }

  get durationMs() { return Number(this.item?.duration) || (isFinite(this.video.duration) ? this.video.duration * 1000 : 0); }
  get positionMs() {
    if (this.pendingSeekMs != null) return this.pendingSeekMs;
    return this.baseOffsetMs + (this.video.currentTime || 0) * 1000;
  }
  get media() { return this.item?.Media?.[0]; }

  describe() {
    const m = this.media;
    if (!m) return '';
    const res = m.videoResolution ? (/^\d+$/.test(m.videoResolution) ? m.videoResolution + 'p' : m.videoResolution.toUpperCase()) : '';
    const how = this.mode === 'direct' ? 'Direct Play' : (this.mode === 'hls' ? 'HLS (direct stream / transcode)' : '');
    return [res, (m.videoCodec || '').toUpperCase(), how].filter(Boolean).join(' · ');
  }

  canDirectPlay(m) {
    if (!m || !m.Part?.[0]) return false;
    const v = (m.videoCodec || '').toLowerCase();
    const a = (m.audioCodec || '').toLowerCase();
    const okVideo = v === 'h264' || (this.hevc && v === 'hevc' && this.video.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"'));
    return MP4_CONTAINERS.has((m.container || '').toLowerCase()) && okVideo && BROWSER_AUDIO.has(a);
  }

  async play(server, item, startMs = 0, { hevc = false } = {}) {
    await this.stop(false);
    this.server = server;
    this.item = item;
    this.hevc = hevc;
    this.triedHlsFallback = false;
    this.session = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    if (this.canDirectPlay(this.media)) this._startDirect(startMs);
    else this._startHls(startMs);
    this.timer = setInterval(() => this._report(), TIMELINE_MS);
  }

  _startDirect(startMs) {
    this.mode = 'direct';
    this.baseOffsetMs = 0;
    const v = this.video;
    v.crossOrigin = 'anonymous';
    v.src = this.server.directPlayUrl(this.media.Part[0]);
    const seek = () => { v.currentTime = startMs / 1000; v.removeEventListener('loadedmetadata', seek); };
    if (startMs > 0) v.addEventListener('loadedmetadata', seek);
    this._setState('buffering');
    this._doPlay();
  }

  _startHls(startMs) {
    this.mode = 'hls';
    this._destroyHls();
    const v = this.video;
    v.removeAttribute('src'); v.load();
    v.crossOrigin = 'anonymous';
    this.baseOffsetMs = startMs;
    const m = this.media || {};
    const url = this.server.hlsUrl({
      ratingKey: this.item.ratingKey, offsetSec: startMs / 1000, session: this.session,
      width: m.width, height: m.height, hevc: this.hevc,
    });
    this._setState('buffering');
    if (Hls && Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30, maxMaxBufferLength: 90, backBufferLength: 30,
        enableWorker: true, lowLatencyMode: false,
        manifestLoadingTimeOut: 30000, manifestLoadingMaxRetry: 4, // first segment can take a while on transcode start
        levelLoadingTimeOut: 30000, fragLoadingTimeOut: 60000,
        // Sub-playlists/segments in Plex's master playlist are relative and carry no token.
        // Append it to every request to this server so auth never depends on session cookies.
        xhrSetup: (xhr, reqUrl) => {
          let u = reqUrl;
          try {
            const p = new URL(reqUrl);
            if (reqUrl.startsWith(this.server.uri) && !p.searchParams.has('X-Plex-Token')) {
              p.searchParams.set('X-Plex-Token', this.server.token);
              u = p.toString();
            }
          } catch {}
          xhr.open('GET', u, true);
        },
      });
      this.hls = hls;
      let recovered = false;
      hls.on(Hls.Events.ERROR, (_, data) => {
        console.warn('hls error', data);
        if (!data.fatal) return;
        const manifest = /^manifest/i.test(data.details || '');
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !manifest && !recovered) { recovered = true; hls.startLoad(); return; }
        const code = data.response?.code ? ` (HTTP ${data.response.code})` : '';
        this._destroyHls();
        this._setState('error');
        this.hooks.onError?.(`${manifest ? 'Server refused stream' : 'Stream error'}: ${data.details}${code}`);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => this._doPlay());
      hls.loadSource(url);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url; this._doPlay();
    } else {
      this.hooks.onError?.('HLS not supported in this browser');
    }
  }

  async _doPlay() {
    const v = this.video;
    v.muted = false;
    try { await v.play(); }
    catch (e) {
      if (e.name === 'NotAllowedError') {
        // No user activation for audio: start muted and let the UI offer unmute.
        v.muted = true;
        try { await v.play(); } catch {}
        this.hooks.onNeedsUnmute?.();
      } else console.warn('play failed', e);
    }
  }

  _videoError() {
    const err = this.video.error;
    if (!this.item || this.state === 'stopped') return;
    if (this.mode === 'direct' && !this.triedHlsFallback) {
      // e.g. no CORS on /library/parts or codec the browser rejects -> fall back to HLS
      this.triedHlsFallback = true;
      console.warn('direct play failed, falling back to HLS', err);
      this._startHls(this.positionMs);
      return;
    }
    if (this.mode === 'hls' && this.hls) return; // hls.js reports its own errors
    this.hooks.onError?.(`Video error ${err?.code ?? ''} ${err?.message ?? ''}`);
  }

  togglePause() {
    const v = this.video;
    if (v.paused) this._doPlay(); else v.pause();
    this._report();
  }

  unmute() { this.video.muted = false; }

  seekBy(deltaMs) { this.seekTo((this.pendingSeekMs ?? this.positionMs) + deltaMs); }

  // Direct play seeks natively. HLS seeks within the already-loaded range natively; otherwise restart the
  // transcode at the new offset (debounced so repeated +/- presses coalesce into one restart).
  seekTo(ms) {
    const dur = this.durationMs;
    ms = Math.max(0, Math.min(dur ? dur - 2000 : ms, ms));
    if (this.mode === 'direct') { this.video.currentTime = ms / 1000; this._report(); return; }
    const rel = (ms - this.baseOffsetMs) / 1000;
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (rel >= b.start(i) && rel <= b.end(i) - 1) { this.video.currentTime = rel; this._report(); return; }
    }
    this.pendingSeekMs = ms;
    clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => {
      const target = this.pendingSeekMs;
      this.pendingSeekMs = null;
      const old = this.session;
      this.session = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
      this.server.stopTranscode(old);
      this._startHls(target);
    }, 700);
    this.hooks.onState?.(this.state);
  }

  _setState(s) {
    if (this.state === s) return;
    if (this.state === 'stopped' && s !== 'buffering' && s !== 'playing') return;
    this.state = s;
    this.hooks.onState?.(s);
    if (s === 'playing' || s === 'paused') this._report();
  }

  _report(stateOverride) {
    if (!this.server || !this.item) return;
    const st = stateOverride || (this.state === 'buffering' ? 'buffering' : this.video.paused ? 'paused' : 'playing');
    return this.server.timeline({
      ratingKey: this.item.ratingKey, state: st,
      timeMs: this.positionMs, durationMs: this.durationMs, session: this.session,
    });
  }

  async _ended() {
    if (!this.item || this.state === 'stopped') return;
    // Report full duration so PMS crosses its played threshold and marks the item watched.
    this.pendingSeekMs = this.durationMs;
    await this.stop(true);
    this.hooks.onEnded?.();
  }

  // report=true sends a final 'stopped' timeline (used for progress/watched status).
  async stop(report = true) {
    clearInterval(this.timer); this.timer = null;
    clearTimeout(this.seekTimer);
    const wasActive = this.item && this.state !== 'stopped';
    if (report && wasActive) await this._report('stopped');
    this.pendingSeekMs = null;
    if (this.mode === 'hls' && this.server && this.session) this.server.stopTranscode(this.session);
    this._destroyHls();
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
    this.state = 'stopped';
    this.mode = null;
    this.hooks.onState?.('stopped');
  }

  _destroyHls() { if (this.hls) { this.hls.destroy(); this.hls = null; } }
}
