// Plex API client: plex.tv auth/users/resources + Plex Media Server library/playback/timeline.
// All X-Plex-* values go in the query string (as Plex Web does) so requests avoid CORS preflights
// wherever possible.

const PLEX_TV = 'https://plex.tv';
export const PRODUCT = 'PicoPlex VR';
export const VERSION = '0.1.0';

function clientId() {
  let id = null;
  try { id = localStorage.getItem('pp.clientId'); } catch {}
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { localStorage.setItem('pp.clientId', id); } catch {}
  }
  return id;
}
export const CLIENT_ID = clientId();

export function plexParams(extra = {}) {
  return {
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': CLIENT_ID,
    'X-Plex-Platform': 'Chrome',
    'X-Plex-Platform-Version': '120',
    'X-Plex-Device': /Pico/i.test(navigator.userAgent) ? 'Pico' : 'Browser',
    'X-Plex-Device-Name': 'PicoPlex VR',
    'X-Plex-Model': 'webxr',
    ...extra,
  };
}

function buildUrl(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  return u.toString();
}

function xmlToObj(el) {
  const o = {};
  for (const a of el.attributes) o[a.name] = a.value;
  for (const c of el.children) (o[c.tagName] ||= []).push(xmlToObj(c));
  return o;
}

export class PlexError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function request(url, { method = 'GET', params = {}, token, timeout = 15000 } = {}) {
  const full = buildUrl(url, plexParams({ ...params, ...(token ? { 'X-Plex-Token': token } : {}) }));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(full, { method, headers: { Accept: 'application/json' }, signal: ctl.signal });
  } catch (e) {
    throw new PlexError(e.name === 'AbortError' ? 'Request timed out' : `Network error (${e.message})`, 0);
  } finally { clearTimeout(t); }
  if (!res.ok) throw new PlexError(`HTTP ${res.status} ${res.statusText}`, res.status);
  const text = await res.text();
  if (!text) return {};
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) return JSON.parse(text);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  return { [root.tagName]: xmlToObj(root) };
}

const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

// ---------------- plex.tv ----------------

export const PlexTV = {
  async createPin() {
    const d = await request(`${PLEX_TV}/api/v2/pins`, { method: 'POST', params: { strong: 'false' } });
    return { id: d.id, code: d.code, expiresIn: d.expiresIn };
  },

  async checkPin(id) {
    const d = await request(`${PLEX_TV}/api/v2/pins/${id}`);
    return d.authToken || null;
  },

  async account(token) {
    return request(`${PLEX_TV}/api/v2/user`, { token });
  },

  async homeUsers(token) {
    let list = null;
    try {
      const d = await request(`${PLEX_TV}/api/v2/home/users`, { token });
      list = Array.isArray(d) ? d : (d.users || d.homeUsers || null);
    } catch (e) { if (e.status === 401) throw e; }
    if (!list) {
      try {
        const d = await request(`${PLEX_TV}/api/home/users`, { token });
        list = d.MediaContainer?.User || [];
      } catch (e) { if (e.status === 401) throw e; list = []; }
    }
    return list.map(u => ({
      id: u.id, uuid: u.uuid,
      title: u.title || u.username || u.friendlyName || 'User',
      thumb: u.thumb,
      protected: truthy(u.protected),
      admin: truthy(u.admin),
    }));
  },

  async switchUser(token, user, pin) {
    const params = pin ? { pin } : {};
    try {
      const d = await request(`${PLEX_TV}/api/v2/home/users/${user.uuid}/switch`, { method: 'POST', token, params });
      const t = d.authToken || d.authenticationToken || d.user?.authToken;
      if (t) return t;
    } catch (e) { if (e.status === 401 || e.status === 403) throw new PlexError('Wrong PIN', e.status); }
    const d = await request(`${PLEX_TV}/api/home/users/${user.id}/switch`, { method: 'POST', token, params });
    const u = d.user || d.User?.[0] || d;
    const t = u.authToken || u.authenticationToken;
    if (!t) throw new PlexError('Switch user failed', 0);
    return t;
  },

  async servers(token) {
    const d = await request(`${PLEX_TV}/api/v2/resources`, { token, params: { includeHttps: 1, includeRelay: 1 } });
    const list = Array.isArray(d) ? d : (d.MediaContainer?.Device || []);
    return list
      .filter(r => String(r.provides || '').includes('server'))
      .map(r => ({
        name: r.name,
        machineId: r.clientIdentifier,
        accessToken: r.accessToken,
        owned: truthy(r.owned),
        publicAddressMatches: truthy(r.publicAddressMatches),
        connections: (r.connections || r.Connection || []).map(c => ({
          uri: c.uri, local: truthy(c.local), relay: truthy(c.relay), protocol: c.protocol,
        })),
      }));
  },
};

// Pick the best reachable connection. Page is HTTPS, so only HTTPS URIs are usable (mixed content).
export async function connectServer(resource, onStatus = () => {}) {
  const conns = resource.connections
    .filter(c => c.uri && c.uri.startsWith('https://'))
    .map(c => ({ ...c, prio: c.relay ? 2 : (c.local ? 0 : 1) }))
    .sort((a, b) => a.prio - b.prio);
  if (!conns.length) throw new PlexError('Server has no HTTPS connections (enable "Secure connections" in Plex)', 0);
  onStatus(`Probing ${conns.length} connection(s)…`);
  const results = await Promise.all(conns.map(async c => {
    try {
      await request(`${c.uri}/identity`, { token: resource.accessToken, timeout: 5000 });
      return c;
    } catch { return null; }
  }));
  const ok = results.filter(Boolean).sort((a, b) => a.prio - b.prio);
  if (!ok.length) throw new PlexError(`No connection to ${resource.name} reachable. Check DNS rebind protection for plex.direct.`, 0);
  return new Server(ok[0].uri, resource.accessToken, resource.name, ok[0]);
}

// ---------------- Plex Media Server ----------------

export class Server {
  constructor(uri, token, name, conn) {
    this.uri = uri.replace(/\/$/, '');
    this.token = token;
    this.name = name;
    this.conn = conn;
  }

  get(path, params = {}, opts = {}) {
    return request(this.uri + path, { token: this.token, params, ...opts });
  }

  async sections() {
    const d = await this.get('/library/sections');
    return (d.MediaContainer?.Directory || [])
      .filter(s => s.type === 'movie' || s.type === 'show')
      .map(s => ({ key: s.key, title: s.title, type: s.type }));
  }

  async onDeck() {
    const d = await this.get('/library/onDeck', { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 40 });
    return d.MediaContainer?.Metadata || [];
  }

  async sectionPage(key, start, size, sort = 'titleSort') {
    const d = await this.get(`/library/sections/${key}/all`, {
      sort, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size,
    });
    const mc = d.MediaContainer || {};
    return { items: mc.Metadata || [], total: Number(mc.totalSize ?? mc.size ?? 0) };
  }

  async children(ratingKey) {
    const d = await this.get(`/library/metadata/${ratingKey}/children`);
    return (d.MediaContainer?.Metadata || []);
  }

  async metadata(ratingKey) {
    const d = await this.get(`/library/metadata/${ratingKey}`);
    return d.MediaContainer?.Metadata?.[0];
  }

  imageUrl(path, w, h) {
    if (!path) return null;
    return buildUrl(`${this.uri}/photo/:/transcode`, {
      width: Math.round(w), height: Math.round(h), minSize: 1, upscale: 1,
      url: path, 'X-Plex-Token': this.token,
    });
  }

  directPlayUrl(part) {
    return buildUrl(this.uri + part.key, { 'X-Plex-Token': this.token });
  }

  // Universal transcoder in HLS. directStream=1 copies the video stream when the client profile allows it,
  // so compatible sources stay at original quality; otherwise Plex transcodes at the source resolution.
  hlsUrl({ ratingKey, offsetSec = 0, session, width, height, hevc = false }) {
    const extra = hevc
      ? 'add-transcode-target-codec(type=videoProfile&context=streaming&protocol=hls&videoCodec=hevc)'
      : undefined;
    return buildUrl(`${this.uri}/video/:/transcode/universal/start.m3u8`, plexParams({
      path: `/library/metadata/${ratingKey}`,
      mediaIndex: 0, partIndex: 0,
      protocol: 'hls',
      fastSeek: 1, copyts: 1,
      offset: Math.max(0, Math.floor(offsetSec)),
      directPlay: 0, directStream: 1, directStreamAudio: 1,
      videoQuality: 100,
      videoResolution: width && height ? `${width}x${height}` : '3840x2160',
      maxVideoBitrate: 200000,
      subtitleSize: 100, audioBoost: 100,
      session, 'X-Plex-Session-Identifier': session,
      'X-Plex-Client-Profile-Extra': extra,
      'X-Plex-Token': this.token,
    }));
  }

  stopTranscode(session) {
    return this.get('/video/:/transcode/universal/stop', { session }).catch(() => {});
  }

  timeline({ ratingKey, state, timeMs, durationMs, session }) {
    return this.get('/:/timeline', {
      ratingKey, key: `/library/metadata/${ratingKey}`,
      identifier: 'com.plexapp.plugins.library',
      state, time: Math.max(0, Math.round(timeMs)), duration: Math.round(durationMs),
      'X-Plex-Session-Identifier': session,
    }).catch(e => console.warn('timeline failed', e));
  }

  scrobble(ratingKey) {
    return this.get('/:/scrobble', { key: ratingKey, identifier: 'com.plexapp.plugins.library' });
  }

  unscrobble(ratingKey) {
    return this.get('/:/unscrobble', { key: ratingKey, identifier: 'com.plexapp.plugins.library' });
  }
}
