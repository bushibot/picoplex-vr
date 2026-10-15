// App state machine + all panel drawing. 3D/XR plumbing lives in main.js and talks to this via `view`.
import { PlexTV, connectServer, PlexError } from './plex.js';
import {
  C, text, wrap, button, fillRR, rrect, progressBar, checkBadge, countBadge, drawCover, getImage,
  fmtTime, fmtDuration, font,
} from './ui.js';

const LS = {
  get(k, d = null) { try { const v = localStorage.getItem('pp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pp.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('pp.' + k); } catch {} },
};

// Main panel layout (canvas px)
const W = 2048, H = 1280;
const SIDE_W = 380;
const CX = 420, CY = 130, CW = 1600, CH = 1130;
const GRID_COLS = 7, GAP = 24;
const CARD_W = (CW - GAP * (GRID_COLS - 1)) / GRID_COLS;
const POSTER_H = Math.round(CARD_W * 1.5);
const ROW_H = POSTER_H + 84;
const EP_ROW_H = 210;
const PAGE = 150;

export class App {
  constructor({ panel, ctrl, player, view }) {
    this.panel = panel;
    this.ctrl = ctrl;
    this.player = player;
    this.view = view;

    this.settings = { hevc: false, stars: true, ...LS.get('settings', {}) };
    this.accountToken = LS.get('accountToken');
    this.screen = 'boot';
    this.msg = null;
    this.toast = null;
    this.users = [];
    this.servers = [];
    this.server = null;
    this.sections = [];
    this.stack = [];
    this.lists = new Map();    // key -> { items, total, loading, error }
    this.details = new Map();  // ratingKey -> full metadata
    this.pinEntry = '';
    this.loginPin = null;
    this.status = '';
    this.inPlayer = false;
    this.controlsVisible = true;
    this.lastInteract = performance.now();
    this.needsUnmute = false;
    this.playerMsg = null;
    this.lastCtrlDraw = 0;

    panel.setDraw((ctx, p) => this.drawMain(ctx, p));
    ctrl.setDraw((ctx, p) => this.drawControls(ctx, p));

    player.hooks = {
      onState: () => this.ctrl.invalidate(),
      onError: m => { this.playerMsg = m; this.ctrl.invalidate(); },
      onEnded: () => this.afterPlayback(),
      onNeedsUnmute: () => { this.needsUnmute = true; this.ctrl.invalidate(); },
    };
    view.setStars(this.settings.stars);
  }

  inv() { this.panel.invalidate(); }
  saveSettings() { LS.set('settings', this.settings); }
  showToast(m, ms = 4000) { this.toast = { m, until: performance.now() + ms }; this.inv(); }
  fail(e, prefix = '') {
    console.error(e);
    this.showToast(prefix + (e?.message || String(e)), 6000);
  }

  // ---------------- flow ----------------

  async start() {
    if (!this.accountToken) return this.beginLogin();
    this.setScreen('busy', 'Checking Plex account…');
    try {
      this.account = await PlexTV.account(this.accountToken);
      await this.loadUsers();
    } catch (e) {
      if (e.status === 401) { LS.del('accountToken'); this.accountToken = null; return this.beginLogin(); }
      this.message('Could not reach plex.tv', e.message, [['Retry', () => this.start()]]);
    }
  }

  setScreen(s, status = '') { this.screen = s; this.status = status; this.inv(); }

  message(title, body, actions) {
    this.msg = { title, body, actions };
    this.setScreen('message');
  }

  async beginLogin() {
    clearTimeout(this.pinTimer);
    this.setScreen('login');
    this.loginPin = null;
    try {
      this.loginPin = await PlexTV.createPin();
      this.loginPin.expires = Date.now() + (this.loginPin.expiresIn || 900) * 1000;
      this.inv();
      this.pollPin();
    } catch (e) {
      this.message('Could not reach plex.tv', e.message, [['Retry', () => this.beginLogin()]]);
    }
  }

  pollPin() {
    clearTimeout(this.pinTimer);
    this.pinTimer = setTimeout(async () => {
      if (this.screen !== 'login' || !this.loginPin) return;
      if (Date.now() > this.loginPin.expires) return this.beginLogin();
      try {
        const tok = await PlexTV.checkPin(this.loginPin.id);
        if (tok) {
          this.accountToken = tok;
          LS.set('accountToken', tok);
          return this.start();
        }
      } catch (e) { console.warn('pin poll', e); }
      this.pollPin();
    }, 2000);
  }

  signOut() {
    this.player.stop(false);
    LS.del('accountToken'); LS.del('lastServer');
    this.accountToken = null; this.server = null; this.lists.clear(); this.details.clear();
    this.beginLogin();
  }

  async loadUsers() {
    this.setScreen('busy', 'Loading users…');
    let users = await PlexTV.homeUsers(this.accountToken);
    if (!users.length) {
      users = [{ self: true, title: this.account?.title || this.account?.username || 'Me', thumb: this.account?.thumb }];
    }
    this.users = users;
    if (users.length === 1 && !users[0].protected) return this.selectUser(users[0]);
    this.setScreen('users');
  }

  async selectUser(u, pin) {
    this.setScreen('busy', `Switching to ${u.title}…`);
    try {
      const tok = u.self ? this.accountToken : await PlexTV.switchUser(this.accountToken, u, pin);
      this.user = u;
      this.userToken = tok;
      this.lists.clear(); this.details.clear();
      await this.loadServers();
    } catch (e) {
      if (u.protected && (e.status === 401 || e.status === 403 || /PIN/i.test(e.message))) {
        this.pinEntry = '';
        this.pinUser = u;
        this.setScreen('pin');
        this.showToast('Wrong PIN');
      } else {
        this.message('Could not switch user', e.message, [['Back', () => this.setScreen('users')]]);
      }
    }
  }

  async loadServers() {
    this.setScreen('busy', 'Finding servers…');
    this.servers = await PlexTV.servers(this.userToken);
    if (!this.servers.length) {
      return this.message('No Plex servers', 'This user has no accessible Plex Media Server.', [['Switch user', () => this.setScreen('users')]]);
    }
    const last = LS.get('lastServer');
    const pick = this.servers.find(s => s.machineId === last) || (this.servers.length === 1 ? this.servers[0] : null);
    if (pick) return this.connect(pick);
    this.setScreen('servers');
  }

  async connect(res) {
    this.setScreen('busy', `Connecting to ${res.name}…`);
    try {
      this.server = await connectServer(res, s => { this.status = `${res.name}: ${s}`; this.inv(); });
      LS.set('lastServer', res.machineId);
      this.sections = await this.server.sections();
      this.stack = [{ kind: 'ondeck', title: 'On Deck', scroll: 0 }];
      this.setScreen('browse');
    } catch (e) {
      this.message(`Can't connect to ${res.name}`, e.message,
        [['Retry', () => this.connect(res)], ['Servers', () => this.setScreen('servers')], ['Switch user', () => this.setScreen('users')]]);
    }
  }

  // ---------------- data ----------------

  list(key, loader, { paged = false } = {}) {
    let l = this.lists.get(key);
    if (!l) {
      l = { items: [], total: 0, loading: false, error: null, done: false, paged, loader };
      this.lists.set(key, l);
      this.loadMore(l);
    }
    return l;
  }

  async loadMore(l) {
    if (l.loading || l.done) return;
    l.loading = true; this.inv();
    try {
      if (l.paged) {
        const r = await l.loader(l.items.length, PAGE);
        l.items.push(...r.items);
        l.total = r.total;
        if (!r.items.length || l.items.length >= l.total) l.done = true;
      } else {
        l.items = await l.loader();
        l.total = l.items.length;
        l.done = true;
      }
    } catch (e) { l.error = e.message; l.done = true; this.fail(e); }
    l.loading = false; this.inv();
  }

  async detail(rk) {
    if (this.details.has(rk)) return this.details.get(rk);
    const m = await this.server.metadata(rk);
    this.details.set(rk, m);
    return m;
  }

  // Patch updated watch state into every cached list that contains the item.
  patchItem(m) {
    if (!m) return;
    for (const l of this.lists.values()) {
      const i = l.items.findIndex(x => x.ratingKey === m.ratingKey);
      if (i >= 0) {
        const old = l.items[i];
        l.items[i] = { ...old, viewOffset: m.viewOffset, viewCount: m.viewCount, leafCount: m.leafCount ?? old.leafCount, viewedLeafCount: m.viewedLeafCount ?? old.viewedLeafCount };
      }
    }
    this.inv();
  }

  async refreshWatchState(item) {
    if (!item || !this.server) return;
    this.lists.delete('ondeck');
    const keys = [item.ratingKey, item.parentRatingKey, item.grandparentRatingKey].filter(Boolean);
    for (const rk of keys) {
      try {
        const m = await this.server.metadata(rk);
        if (rk === item.ratingKey) this.details.set(rk, m);
        this.patchItem(m);
        for (const e of this.stack) if (e.item?.ratingKey === rk) e.item = { ...e.item, ...m };
      } catch (e) { console.warn('refresh', e); }
    }
    this.inv();
  }

  // ---------------- navigation ----------------

  top() { return this.stack[this.stack.length - 1]; }
  push(e) { this.stack.push({ scroll: 0, ...e }); this.inv(); }
  goRoot(e) { this.stack = [{ scroll: 0, ...e }]; this.inv(); }

  openItem(it) {
    const t = it.type;
    if (t === 'show') this.push({ kind: 'show', item: it, title: it.title });
    else if (t === 'season') this.push({ kind: 'season', item: it, title: `${it.parentTitle || ''} · ${it.title}` });
    else if (t === 'movie' || t === 'episode') this.push({ kind: 'detail', item: it, title: t === 'episode' ? it.grandparentTitle : it.title });
  }

  onBack() {
    this.touch();
    if (this.inPlayer) return this.stopPlayback();
    if (this.screen === 'browse' && this.stack.length > 1) { this.stack.pop(); this.inv(); return; }
    if (this.screen === 'pin' || this.screen === 'servers') return this.setScreen('users');
  }

  onPrimary() { // A / X button
    this.touch();
    if (this.inPlayer) { this.player.togglePause(); this.controlsVisible = true; this.ctrl.invalidate(); }
  }

  scroll(dy) {
    if (this.screen !== 'browse') return;
    const e = this.top();
    if (!e || e.kind === 'detail') return;
    e.scroll = Math.max(0, Math.min(e.maxScroll ?? 0, e.scroll + dy));
    this.inv();
  }

  touch() { this.lastInteract = performance.now(); }

  // ---------------- playback ----------------

  async startPlayback(item, offsetMs) {
    try {
      const m = item.Media ? item : await this.detail(item.ratingKey);
      this.playItem = m;
      this.inPlayer = true;
      this.playerMsg = null;
      this.needsUnmute = false;
      this.controlsVisible = true;
      this.touch();
      this.view.enterPlayer();
      await this.player.play(this.server, m, offsetMs, { hevc: this.settings.hevc });
      this.ctrl.invalidate();
    } catch (e) { this.fail(e, 'Playback failed: '); this.view.exitPlayer(); this.inPlayer = false; }
  }

  async stopPlayback() {
    await this.player.stop(true);
    this.afterPlayback();
  }

  afterPlayback() {
    if (!this.inPlayer) return;
    this.inPlayer = false;
    this.view.exitPlayer();
    this.refreshWatchState(this.playItem);
  }

  tick(now) {
    if (this.toast && now > this.toast.until) { this.toast = null; this.inv(); }
    if (this.inPlayer) {
      const playing = this.player.state === 'playing';
      if (this.controlsVisible && playing && !this.view.pointerOnControls() && now - this.lastInteract > 5000) {
        this.controlsVisible = false;
      }
      this.view.setControlsVisible(this.controlsVisible);
      if (this.controlsVisible && now - this.lastCtrlDraw > 500) { this.lastCtrlDraw = now; this.ctrl.invalidate(); }
    }
  }

  // ---------------- drawing: main panel ----------------

  drawMain(ctx, p) {
    fillRR(ctx, 0, 0, W, H, 40, C.bg);
    switch (this.screen) {
      case 'boot': case 'busy': this.drawBusy(ctx, p); break;
      case 'login': this.drawLogin(ctx, p); break;
      case 'users': this.drawUsers(ctx, p); break;
      case 'pin': this.drawPin(ctx, p); break;
      case 'servers': this.drawServers(ctx, p); break;
      case 'message': this.drawMessage(ctx, p); break;
      case 'browse': this.drawBrowse(ctx, p); break;
    }
    if (this.toast) {
      font(ctx, 32, 600);
      const w = Math.min(1600, ctx.measureText(this.toast.m).width + 80);
      fillRR(ctx, (W - w) / 2, H - 120, w, 76, 38, 'rgba(229,83,61,0.95)');
      text(ctx, this.toast.m, W / 2, H - 82, { size: 32, weight: 600, align: 'center', baseline: 'middle', maxW: w - 40 });
    }
  }

  drawLogo(ctx, x, y, size = 56) {
    text(ctx, 'Pico', x, y, { size, weight: 800 });
    font(ctx, size, 800);
    const w = ctx.measureText('Pico').width;
    text(ctx, 'Plex', x + w, y, { size, weight: 800, color: C.accent });
    const w2 = ctx.measureText('Plex').width;
    text(ctx, ' VR', x + w + w2, y, { size, weight: 300, color: C.dim });
  }

  drawBusy(ctx) {
    this.drawLogo(ctx, W / 2 - 170, 500, 72);
    text(ctx, this.status || 'Loading…', W / 2, 640, { size: 38, align: 'center', color: C.dim });
  }

  drawLogin(ctx, p) {
    this.drawLogo(ctx, W / 2 - 170, 230, 72);
    text(ctx, 'On your phone or computer, go to', W / 2, 380, { size: 40, align: 'center', color: C.dim });
    text(ctx, 'plex.tv/link', W / 2, 470, { size: 72, weight: 700, align: 'center', color: C.accent });
    text(ctx, 'and enter this code:', W / 2, 560, { size: 40, align: 'center', color: C.dim });
    const code = this.loginPin?.code || '····';
    const bw = 170, gap = 30, total = code.length * bw + (code.length - 1) * gap;
    for (let i = 0; i < code.length; i++) {
      const x = W / 2 - total / 2 + i * (bw + gap);
      fillRR(ctx, x, 620, bw, 210, 24, C.card);
      text(ctx, code[i], x + bw / 2, 727, { size: 130, weight: 700, align: 'center', baseline: 'middle' });
    }
    text(ctx, this.loginPin ? 'Waiting for you to link this device…' : 'Requesting code…', W / 2, 920, { size: 34, align: 'center', color: C.dim });
    button(ctx, p, W / 2 - 180, 1000, 360, 90, 'Get new code', () => this.beginLogin());
  }

  drawUsers(ctx, p) {
    this.drawLogo(ctx, 80, 120, 52);
    text(ctx, "Who's watching?", W / 2, 300, { size: 72, weight: 700, align: 'center' });
    const n = this.users.length, tile = 260, gap = 60;
    const perRow = Math.min(n, 6);
    const rows = Math.ceil(n / perRow);
    const startY = rows > 1 ? 380 : 470;
    this.users.forEach((u, i) => {
      const r = Math.floor(i / perRow), c = i % perRow;
      const inRow = Math.min(perRow, n - r * perRow);
      const x = W / 2 - (inRow * tile + (inRow - 1) * gap) / 2 + c * (tile + gap);
      const y = startY + r * (tile + 140);
      const id = 'user:' + i;
      const hov = p.isHover(id);
      const img = getImage(u.thumb, () => this.inv());
      ctx.save();
      ctx.beginPath(); ctx.arc(x + tile / 2, y + tile / 2, tile / 2, 0, Math.PI * 2); ctx.clip();
      if (img) ctx.drawImage(img, x, y, tile, tile);
      else {
        ctx.fillStyle = `hsl(${(i * 67) % 360} 45% 38%)`; ctx.fillRect(x, y, tile, tile);
        text(ctx, (u.title || '?')[0].toUpperCase(), x + tile / 2, y + tile / 2 + 4, { size: 120, weight: 700, align: 'center', baseline: 'middle' });
      }
      ctx.restore();
      ctx.beginPath(); ctx.arc(x + tile / 2, y + tile / 2, tile / 2 + 4, 0, Math.PI * 2);
      ctx.strokeStyle = hov ? C.accent : 'rgba(255,255,255,0.1)'; ctx.lineWidth = hov ? 10 : 4; ctx.stroke();
      text(ctx, u.title + (u.protected ? '  🔒' : ''), x + tile / 2, y + tile + 64, { size: 38, weight: hov ? 700 : 500, align: 'center', maxW: tile + gap - 10 });
      p.region(x - 10, y - 10, tile + 20, tile + 90, {
        id, onClick: () => {
          if (u.protected) { this.pinUser = u; this.pinEntry = ''; this.setScreen('pin'); }
          else this.selectUser(u);
        },
      });
    });
    button(ctx, p, W - 300, 60, 240, 80, 'Sign out', () => this.signOut(), { size: 28 });
  }

  drawPin(ctx, p) {
    text(ctx, `Enter PIN for ${this.pinUser?.title || ''}`, W / 2, 200, { size: 56, weight: 700, align: 'center' });
    for (let i = 0; i < 4; i++) {
      const cx = W / 2 - 165 + i * 110;
      ctx.beginPath(); ctx.arc(cx, 300, 28, 0, Math.PI * 2);
      ctx.fillStyle = i < this.pinEntry.length ? C.accent : C.card; ctx.fill();
    }
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Cancel', '0', '⌫'];
    const bw = 220, bh = 170, gap = 28;
    const x0 = W / 2 - (3 * bw + 2 * gap) / 2;
    keys.forEach((k, i) => {
      const x = x0 + (i % 3) * (bw + gap), y = 390 + Math.floor(i / 3) * (bh + gap);
      button(ctx, p, x, y, bw, bh, k, () => {
        if (k === 'Cancel') return this.setScreen('users');
        if (k === '⌫') this.pinEntry = this.pinEntry.slice(0, -1);
        else if (this.pinEntry.length < 4) this.pinEntry += k;
        this.inv();
        if (this.pinEntry.length === 4) this.selectUser(this.pinUser, this.pinEntry);
      }, { id: 'pin:' + k, size: k.length > 1 ? 36 : 64 });
    });
  }

  drawServers(ctx, p) {
    text(ctx, 'Choose a server', W / 2, 220, { size: 64, weight: 700, align: 'center' });
    this.servers.forEach((s, i) => {
      const y = 320 + i * 130;
      const id = 'srv:' + i, hov = p.isHover(id);
      fillRR(ctx, W / 2 - 600, y, 1200, 110, 18, hov ? C.cardHi : C.card);
      text(ctx, s.name, W / 2 - 560, y + 68, { size: 44, weight: 600 });
      text(ctx, s.owned ? 'Owned' : 'Shared', W / 2 + 560, y + 68, { size: 32, align: 'right', color: C.dim });
      p.region(W / 2 - 600, y, 1200, 110, { id, onClick: () => this.connect(s) });
    });
    button(ctx, p, 60, 60, 260, 80, '‹ Users', () => this.setScreen('users'));
  }

  drawMessage(ctx, p) {
    const m = this.msg || {};
    text(ctx, m.title || '', W / 2, 420, { size: 64, weight: 700, align: 'center', maxW: 1800 });
    ctx.save(); ctx.textAlign = 'left';
    wrap(ctx, m.body || '', W / 2 - 750, 530, 1500, 50, 6, { size: 36 });
    ctx.restore();
    const acts = m.actions || [];
    const bw = 340, gap = 40, tot = acts.length * bw + (acts.length - 1) * gap;
    acts.forEach(([label, fn], i) => button(ctx, p, W / 2 - tot / 2 + i * (bw + gap), 900, bw, 96, label, fn, { primary: i === 0 }));
  }

  // ---------------- browse ----------------

  drawSidebar(ctx, p) {
    ctx.save();
    rrect(ctx, 0, 0, SIDE_W, H, [40, 0, 0, 40]); ctx.fillStyle = C.side; ctx.fill();
    ctx.restore();
    this.drawLogo(ctx, 40, 90, 46);
    const root = this.stack[0];
    const entries = [
      { label: 'On Deck', active: root.kind === 'ondeck', fn: () => this.goRoot({ kind: 'ondeck', title: 'On Deck' }) },
      ...this.sections.map(s => ({
        label: s.title, active: root.kind === 'section' && root.section.key === s.key,
        fn: () => this.goRoot({ kind: 'section', section: s, title: s.title }),
      })),
    ];
    let y = 160;
    entries.forEach((e, i) => {
      const id = 'nav:' + i, hov = p.isHover(id);
      if (e.active || hov) fillRR(ctx, 20, y, SIDE_W - 40, 80, 14, e.active ? C.accentDim : C.card);
      if (e.active) fillRR(ctx, 20, y + 16, 8, 48, 4, C.accent);
      text(ctx, e.label, 52, y + 52, { size: 34, weight: e.active ? 700 : 500, color: e.active ? C.text : (hov ? C.text : C.dim), maxW: SIDE_W - 90 });
      p.region(20, y, SIDE_W - 40, 80, { id, onClick: e.fn });
      y += 88;
    });

    const bottom = [
      [`HEVC: ${this.settings.hevc ? 'On' : 'Off'}`, () => { this.settings.hevc = !this.settings.hevc; this.saveSettings(); this.inv(); }],
      [`Stars: ${this.settings.stars ? 'On' : 'Off'}`, () => { this.settings.stars = !this.settings.stars; this.saveSettings(); this.view.setStars(this.settings.stars); this.inv(); }],
      ['Recenter', () => this.view.recenter()],
      ['Switch user', () => { this.player.stop(false); this.setScreen('users'); }],
    ];
    let by = H - 140 - bottom.length * 76;
    for (const [label, fn] of bottom) {
      button(ctx, p, 30, by, SIDE_W - 60, 64, label, fn, { size: 28 });
      by += 76;
    }
    text(ctx, this.user?.title || '', 40, H - 70, { size: 30, weight: 600, maxW: SIDE_W - 80 });
    const conn = this.server?.conn;
    const how = conn ? (conn.relay ? 'relay' : conn.local ? 'local' : 'remote') : '';
    text(ctx, [this.server?.name, how].filter(Boolean).join(' · '), 40, H - 34, { size: 24, color: how === 'relay' ? C.danger : C.dim, maxW: SIDE_W - 80 });
  }

  drawBrowse(ctx, p) {
    this.drawSidebar(ctx, p);
    const e = this.top();
    // header
    let tx = CX;
    if (this.stack.length > 1) {
      button(ctx, p, CX, 30, 80, 80, '‹', () => this.onBack(), { id: 'back', size: 56, r: 40 });
      tx = CX + 110;
    }
    text(ctx, e.title || '', tx, 90, { size: 52, weight: 700, maxW: CW - 500 });

    ctx.save();
    ctx.beginPath(); ctx.rect(CX - 10, CY, CW + 30, CH + 20); ctx.clip();
    switch (e.kind) {
      case 'ondeck': {
        const l = this.list('ondeck', () => this.server.onDeck());
        this.drawGrid(ctx, p, e, l, 'Nothing on deck.');
        break;
      }
      case 'section': {
        const s = e.section;
        const l = this.list('sec:' + s.key, (start, size) => this.server.sectionPage(s.key, start, size), { paged: true });
        this.drawGrid(ctx, p, e, l, 'Library is empty.');
        this.headerCount(ctx, l);
        break;
      }
      case 'show': {
        const l = this.list('kids:' + e.item.ratingKey, () => this.server.children(e.item.ratingKey));
        this.drawGrid(ctx, p, e, l, 'No seasons.');
        break;
      }
      case 'season': {
        const l = this.list('kids:' + e.item.ratingKey, () => this.server.children(e.item.ratingKey));
        this.drawEpisodes(ctx, p, e, l);
        break;
      }
      case 'detail': this.drawDetail(ctx, p, e); break;
    }
    ctx.restore();
  }

  headerCount(ctx, l) {
    if (l.total) text(ctx, `${l.items.length < l.total ? l.items.length + ' / ' : ''}${l.total} items`, W - 50, 90, { size: 30, color: C.dim, align: 'right' });
  }

  emptyOrLoading(ctx, l, emptyMsg) {
    if (l.loading && !l.items.length) { text(ctx, 'Loading…', CX + CW / 2, CY + 300, { size: 40, align: 'center', color: C.dim }); return true; }
    if (l.error && !l.items.length) { text(ctx, l.error, CX + CW / 2, CY + 300, { size: 36, align: 'center', color: C.danger, maxW: CW }); return true; }
    if (!l.items.length) { text(ctx, emptyMsg, CX + CW / 2, CY + 300, { size: 40, align: 'center', color: C.dim }); return true; }
    return false;
  }

  drawGrid(ctx, p, e, l, emptyMsg) {
    if (this.emptyOrLoading(ctx, l, emptyMsg)) { e.maxScroll = 0; return; }
    const n = l.items.length;
    const rows = Math.ceil(n / GRID_COLS);
    e.maxScroll = Math.max(0, rows * ROW_H - CH + 40);
    e.scroll = Math.min(e.scroll, e.maxScroll);
    const firstRow = Math.max(0, Math.floor(e.scroll / ROW_H) - 1);
    const lastRow = Math.min(rows - 1, Math.ceil((e.scroll + CH) / ROW_H) + 1);
    p.region(CX, CY, CW, CH, { id: 'scrollarea', hoverable: false });
    for (let r = firstRow; r <= lastRow; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const i = r * GRID_COLS + c;
        if (i >= n) break;
        const x = CX + c * (CARD_W + GAP), y = CY + 10 + r * ROW_H - e.scroll;
        this.drawCard(ctx, p, l.items[i], x, y, i);
      }
    }
    // infinite scroll for paged libraries
    if (l.paged && !l.done && !l.loading && (lastRow + 3) * GRID_COLS >= n) this.loadMore(l);
    if (l.loading && n) text(ctx, 'Loading more…', CX + CW / 2, CY + CH - 10, { size: 28, align: 'center', color: C.dim });
  }

  drawCard(ctx, p, it, x, y, i) {
    const id = 'item:' + it.ratingKey;
    const hov = p.isHover(id);
    const thumb = it.type === 'episode' ? (it.grandparentThumb || it.parentThumb || it.thumb)
      : it.type === 'season' ? (it.thumb || it.parentThumb) : it.thumb;
    const img = getImage(this.server.imageUrl(thumb, CARD_W * 1.4, POSTER_H * 1.4), () => this.inv());
    drawCover(ctx, img, x, y, CARD_W, POSTER_H, 10);
    if (!img) wrap(ctx, it.type === 'episode' ? it.grandparentTitle : it.title, x + 16, y + 50, CARD_W - 32, 34, 5, { size: 28, color: C.dim });
    if (hov) { rrect(ctx, x - 3, y - 3, CARD_W + 6, POSTER_H + 6, 12); ctx.strokeStyle = C.accent; ctx.lineWidth = 6; ctx.stroke(); }

    const leaf = Number(it.leafCount || 0), viewedLeaf = Number(it.viewedLeafCount || 0);
    const offset = Number(it.viewOffset || 0), dur = Number(it.duration || 0);
    if (it.type === 'show' || it.type === 'season') {
      if (leaf && viewedLeaf >= leaf) checkBadge(ctx, x + CARD_W - 28, y + 28, 20);
      else if (leaf - viewedLeaf > 0) countBadge(ctx, x + CARD_W - 8, y + 8, leaf - viewedLeaf);
    } else {
      if (offset > 0 && dur) progressBar(ctx, x + 10, y + POSTER_H - 22, CARD_W - 20, 10, offset / dur);
      else if (Number(it.viewCount || 0) > 0) checkBadge(ctx, x + CARD_W - 28, y + 28, 20);
      else if (it.type === 'movie' || it.type === 'episode') {
        // unwatched corner triangle (Plex style)
        ctx.beginPath(); ctx.moveTo(x + CARD_W - 44, y); ctx.lineTo(x + CARD_W - 10, y); ctx.quadraticCurveTo(x + CARD_W, y, x + CARD_W, y + 10); ctx.lineTo(x + CARD_W, y + 44); ctx.closePath();
        ctx.fillStyle = C.accent; ctx.fill();
      }
    }
    const title = it.type === 'episode' ? it.grandparentTitle : it.title;
    const sub = it.type === 'episode' ? `S${it.parentIndex ?? '?'} · E${it.index ?? '?'}  ${it.title || ''}`
      : it.type === 'season' ? `${leaf} episode${leaf === 1 ? '' : 's'}`
      : it.type === 'show' ? `${it.year || ''}${it.childCount ? ` · ${it.childCount} season${it.childCount == 1 ? '' : 's'}` : ''}`
      : (it.year || '');
    text(ctx, title, x + 2, y + POSTER_H + 38, { size: 28, weight: 600, maxW: CARD_W - 4, color: hov ? C.accent : C.text });
    text(ctx, sub, x + 2, y + POSTER_H + 72, { size: 24, color: C.dim, maxW: CARD_W - 4 });
    p.region(x, y, CARD_W, POSTER_H + 80, { id, onClick: () => this.openItem(it) });
  }

  drawEpisodes(ctx, p, e, l) {
    if (this.emptyOrLoading(ctx, l, 'No episodes.')) { e.maxScroll = 0; return; }
    const n = l.items.length;
    e.maxScroll = Math.max(0, n * EP_ROW_H - CH + 40);
    e.scroll = Math.min(e.scroll, e.maxScroll);
    p.region(CX, CY, CW, CH, { id: 'scrollarea', hoverable: false });
    const first = Math.max(0, Math.floor(e.scroll / EP_ROW_H) - 1);
    const last = Math.min(n - 1, Math.ceil((e.scroll + CH) / EP_ROW_H) + 1);
    const TW = 320, TH = 180;
    for (let i = first; i <= last; i++) {
      const it = l.items[i];
      const y = CY + 10 + i * EP_ROW_H - e.scroll;
      const id = 'item:' + it.ratingKey, hov = p.isHover(id);
      if (hov) fillRR(ctx, CX - 10, y - 10, CW + 20, TH + 20, 16, C.card);
      const img = getImage(this.server.imageUrl(it.thumb, TW * 1.5, TH * 1.5), () => this.inv());
      drawCover(ctx, img, CX, y, TW, TH, 10);
      const offset = Number(it.viewOffset || 0), dur = Number(it.duration || 0);
      if (offset > 0 && dur) progressBar(ctx, CX + 10, y + TH - 20, TW - 20, 10, offset / dur);
      else if (Number(it.viewCount || 0) > 0) checkBadge(ctx, CX + TW - 26, y + 26, 18);
      text(ctx, `${it.index ?? ''}. ${it.title || ''}`, CX + TW + 30, y + 44, { size: 34, weight: 600, maxW: CW - TW - 220, color: hov ? C.accent : C.text });
      text(ctx, dur ? fmtDuration(dur) : '', CX + CW - 10, y + 44, { size: 28, color: C.dim, align: 'right' });
      wrap(ctx, it.summary, CX + TW + 30, y + 92, CW - TW - 60, 36, 3, { size: 26 });
      p.region(CX, y, CW, TH, { id, onClick: () => this.openItem(it) });
    }
  }

  drawDetail(ctx, p, e) {
    e.maxScroll = 0;
    const base = e.item;
    if (!this.details.has(base.ratingKey) && !e.loading) {
      e.loading = true;
      this.detail(base.ratingKey).then(() => this.inv()).catch(err => this.fail(err)).finally(() => { e.loading = false; });
    }
    const it = this.details.get(base.ratingKey) || base;
    const PW = 440, PH = 660;
    const thumb = it.type === 'episode' ? (it.thumb) : it.thumb;
    const isEp = it.type === 'episode';
    const iw = isEp ? 600 : PW, ih = isEp ? 338 : PH;
    const img = getImage(this.server.imageUrl(thumb, iw * 1.3, ih * 1.3), () => this.inv());
    drawCover(ctx, img, CX, CY + 20, iw, ih, 14);

    const x = CX + iw + 60, maxW = CW - iw - 60;
    let y = CY + 80;
    if (isEp) {
      text(ctx, `Season ${it.parentIndex ?? '?'} · Episode ${it.index ?? '?'}`, x, y, { size: 32, color: C.accent, weight: 600 }); y += 66;
    }
    text(ctx, it.title, x, y, { size: 60, weight: 700, maxW }); y += 60;
    const m = it.Media?.[0];
    const res = m?.videoResolution ? (/^\d+$/.test(m.videoResolution) ? m.videoResolution + 'p' : m.videoResolution.toUpperCase()) : '';
    const meta = [it.year, it.duration ? fmtDuration(it.duration) : '', it.contentRating, res,
      m ? `${(m.videoCodec || '').toUpperCase()} ${(m.audioCodec || '').toUpperCase()} ${m.audioChannels ? m.audioChannels + 'ch' : ''}`.trim() : ''].filter(Boolean).join('  ·  ');
    text(ctx, meta, x, y, { size: 30, color: C.dim, maxW }); y += 70;

    const offset = Number(it.viewOffset || 0), dur = Number(it.duration || 0);
    const watched = Number(it.viewCount || 0) > 0 && !offset;
    if (offset > 0 && dur) {
      progressBar(ctx, x, y - 20, Math.min(600, maxW), 12, offset / dur);
      text(ctx, `${fmtTime(offset)} of ${fmtTime(dur)}`, x + Math.min(600, maxW) + 24, y - 6, { size: 26, color: C.dim });
      y += 30;
    } else if (watched) {
      checkBadge(ctx, x + 18, y - 14, 18);
      text(ctx, 'Watched', x + 50, y - 4, { size: 28, color: C.dim });
      y += 30;
    }

    const by = y + 10;
    const acts = [];
    if (offset > 0) {
      acts.push([380, `▶  Resume ${fmtTime(offset)}`, () => this.startPlayback(it, offset), { primary: true, id: 'resume' }]);
      acts.push([330, 'Play from start', () => this.startPlayback(it, 0), { id: 'restart' }]);
    } else {
      acts.push([300, '▶  Play', () => this.startPlayback(it, 0), { primary: true, id: 'play' }]);
    }
    acts.push([330, watched ? 'Mark unwatched' : 'Mark watched', async () => {
      try {
        if (watched) await this.server.unscrobble(it.ratingKey); else await this.server.scrobble(it.ratingKey);
        this.details.delete(it.ratingKey);
        await this.refreshWatchState(it);
      } catch (err) { this.fail(err); }
    }, { id: 'markwatched' }]);
    const bgap = 24;
    const fit = Math.min(1, (maxW - bgap * (acts.length - 1)) / acts.reduce((a, b) => a + b[0], 0));
    let bx = x;
    for (const [bw, label, fn, opts] of acts) {
      const w = Math.floor(bw * fit);
      button(ctx, p, bx, by, w, 96, label, fn, { size: fit < 1 ? 26 : 30, ...opts });
      bx += w + bgap;
    }

    y = by + 170;
    wrap(ctx, it.summary || '', x, y, maxW, 44, isEp ? 12 : 11, { size: 32, color: '#c9cad3' });

    if (!it.Media && e.loading) text(ctx, 'Loading details…', x, CY + CH - 40, { size: 26, color: C.dim });
  }

  // ---------------- drawing: player controls ----------------

  drawControls(ctx, p) {
    const CWp = p.W, CHp = p.H;
    fillRR(ctx, 0, 0, CWp, CHp, 30, 'rgba(14,14,18,0.92)');
    const it = this.playItem;
    const pl = this.player;
    if (!it) return;
    const title = it.type === 'episode' ? `${it.grandparentTitle} · S${it.parentIndex}E${it.index} · ${it.title}` : `${it.title}${it.year ? ` (${it.year})` : ''}`;
    text(ctx, title, 30, 52, { size: 32, weight: 700, maxW: 950 });
    const status = this.playerMsg || ({ buffering: 'Buffering…', paused: 'Paused' }[pl.state] || '') || pl.describe();
    text(ctx, status, CWp - 30, 52, { size: 26, align: 'right', color: this.playerMsg ? C.danger : C.dim, maxW: 600 });

    // seek bar
    const sx = 150, sw = CWp - 300, sy = 92;
    const dur = pl.durationMs, pos = pl.positionMs;
    text(ctx, fmtTime(pos), sx - 20, sy + 12, { size: 26, align: 'right', color: C.dim });
    text(ctx, fmtTime(dur), sx + sw + 20, sy + 12, { size: 26, color: C.dim });
    const hovSeek = p.isHover('seek');
    progressBar(ctx, sx, sy, sw, hovSeek ? 18 : 12, dur ? pos / dur : 0);
    if (dur) {
      ctx.beginPath(); ctx.arc(sx + sw * Math.min(1, pos / dur), sy + (hovSeek ? 9 : 6), hovSeek ? 16 : 11, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    p.region(sx, sy - 24, sw, 60, { id: 'seek', onClick: (rx) => { this.touch(); pl.seekTo(dur * Math.max(0, Math.min(1, rx / sw))); } });

    const btns = [
      ['■ Stop', () => this.stopPlayback()],
      ['−30s', () => pl.seekBy(-30000)],
      ['−10s', () => pl.seekBy(-10000)],
      [pl.video.paused ? 'Play' : 'Pause', () => pl.togglePause()],
      ['+10s', () => pl.seekBy(10000)],
      ['+30s', () => pl.seekBy(30000)],
      ['Size −', () => this.view.resizeScreen(1 / 1.15)],
      ['Size +', () => this.view.resizeScreen(1.15)],
      ['Recenter', () => this.view.recenter()],
      this.needsUnmute
        ? ['Unmute', () => { pl.unmute(); this.needsUnmute = false; }]
        : [`Stars ${this.settings.stars ? 'On' : 'Off'}`, () => { this.settings.stars = !this.settings.stars; this.saveSettings(); this.view.setStars(this.settings.stars); }],
    ];
    const bw = 140, gap = 16, bx0 = (CWp - (btns.length * bw + (btns.length - 1) * gap)) / 2;
    btns.forEach(([label, fn], i) => button(ctx, p, bx0 + i * (bw + gap), 150, bw, 84, label, () => { this.touch(); fn(); p.invalidate(); },
      { id: 'c:' + i, size: 26, primary: i === 3 }));
  }
}
