// Canvas-texture UI panels for WebXR. Each panel draws into a 2D canvas, registers hit regions while
// drawing, and is shown in 3D on a plane. Controller/mouse rays give a UV which maps back to regions.
import * as THREE from '../vendor/three.module.js';

export const C = {
  bg: 'rgba(14,14,18,0.94)',
  side: 'rgba(24,24,30,0.96)',
  card: '#22232b',
  cardHi: '#2f3140',
  text: '#f2f2f2',
  dim: '#9a9caa',
  accent: '#e5a00d',     // Plex orange
  accentDim: 'rgba(229,160,13,0.25)',
  danger: '#e5533d',
  ok: '#52c47a',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

export class Panel {
  constructor(wPx, hPx, wM, name) {
    this.name = name;
    this.W = wPx; this.H = hPx;
    this.canvas = document.createElement('canvas');
    this.canvas.width = wPx; this.canvas.height = hPx;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    const hM = wM * hPx / wPx;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(wM, hM),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 2;
    this.mesh.userData.panel = this;
    this.regions = [];
    this.hover = null;
    this.dirty = true;
    this.drawFn = null;
  }

  setDraw(fn) { this.drawFn = fn; this.dirty = true; }
  invalidate() { this.dirty = true; }

  update() {
    if (!this.dirty || !this.drawFn || !this.mesh.visible) return;
    this.dirty = false;
    this.regions = [];
    this.ctx.clearRect(0, 0, this.W, this.H);
    this.drawFn(this.ctx, this);
    this.texture.needsUpdate = true;
  }

  // opts: { id, onClick, onScroll, hoverable=true }
  region(x, y, w, h, opts) { this.regions.push({ x, y, w, h, ...opts }); }

  hitTest(uv) {
    const x = uv.x * this.W, y = (1 - uv.y) * this.H;
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { region: r, x, y };
    }
    return { region: null, x, y };
  }

  setHover(id) {
    if (this.hover !== id) { this.hover = id; this.dirty = true; }
  }
  isHover(id) { return this.hover === id; }
}

// ---------- drawing helpers ----------

export function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function fillRR(ctx, x, y, w, h, r, color) {
  rrect(ctx, x, y, w, h, r); ctx.fillStyle = color; ctx.fill();
}

export function font(ctx, size, weight = 400) {
  ctx.font = `${weight} ${size}px ${C.font}`;
}

export function text(ctx, str, x, y, { size = 28, weight = 400, color = C.text, align = 'left', maxW = 0, baseline = 'alphabetic' } = {}) {
  font(ctx, size, weight);
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline;
  str = String(str ?? '');
  if (maxW && ctx.measureText(str).width > maxW) {
    while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
    str += '…';
  }
  ctx.fillText(str, x, y);
}

export function wrap(ctx, str, x, y, maxW, lineH, maxLines, opts = {}) {
  font(ctx, opts.size || 26, opts.weight || 400);
  ctx.fillStyle = opts.color || C.dim; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const words = String(str || '').split(/\s+/);
  let line = '', n = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxW && line) {
      n++;
      if (n === maxLines) {
        let l = line;
        while (l.length && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1);
        ctx.fillText(l + '…', x, y); return y;
      }
      ctx.fillText(line, x, y); y += lineH; line = words[i];
    } else line = test;
  }
  if (line) ctx.fillText(line, x, y);
  return y;
}

export function button(ctx, panel, x, y, w, h, label, onClick, { id = 'btn:' + label, primary = false, size = 30, r = 14, disabled = false } = {}) {
  const hov = panel.isHover(id) && !disabled;
  fillRR(ctx, x, y, w, h, r, disabled ? '#1b1c22' : primary ? (hov ? '#ffb92e' : C.accent) : (hov ? C.cardHi : C.card));
  if (hov && !primary) { rrect(ctx, x, y, w, h, r); ctx.strokeStyle = C.accent; ctx.lineWidth = 3; ctx.stroke(); }
  text(ctx, label, x + w / 2, y + h / 2 + 1, { size, weight: 600, align: 'center', baseline: 'middle', color: primary ? '#111' : (disabled ? '#555' : C.text), maxW: w - 16 });
  if (!disabled) panel.region(x, y, w, h, { id, onClick });
}

export function progressBar(ctx, x, y, w, h, frac, color = C.accent) {
  fillRR(ctx, x, y, w, h, h / 2, 'rgba(0,0,0,0.6)');
  if (frac > 0) fillRR(ctx, x, y, Math.max(h, w * Math.min(1, frac)), h, h / 2, color);
}

export function checkBadge(ctx, cx, cy, r) {
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = C.accent; ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx - r * 0.45, cy); ctx.lineTo(cx - r * 0.1, cy + r * 0.38); ctx.lineTo(cx + r * 0.5, cy - r * 0.35);
  ctx.strokeStyle = '#111'; ctx.lineWidth = r * 0.25; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
}

export function countBadge(ctx, xRight, yTop, n) {
  const s = String(n);
  font(ctx, 24, 700);
  const w = Math.max(40, ctx.measureText(s).width + 20);
  fillRR(ctx, xRight - w, yTop, w, 38, 8, C.accent);
  text(ctx, s, xRight - w / 2, yTop + 20, { size: 24, weight: 700, color: '#111', align: 'center', baseline: 'middle' });
}

// Draw image to fill a box (object-fit: cover). Returns false if image not ready.
export function drawCover(ctx, img, x, y, w, h, r = 10) {
  ctx.save();
  rrect(ctx, x, y, w, h, r); ctx.clip();
  if (img) {
    const s = Math.max(w / img.width, h / img.height);
    const iw = img.width * s, ih = img.height * s;
    ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  } else {
    ctx.fillStyle = C.card; ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
  return !!img;
}

// ---------- image cache ----------
// Images must be CORS-clean or the canvas becomes tainted and WebGL refuses the texture.
// Fetch as blob -> ImageBitmap; failures are remembered and rendered as placeholders.
const cache = new Map();
let inflight = 0;
const queue = [];
const MAX_INFLIGHT = 6;
const MAX_CACHE = 600;

export function getImage(url, onReady) {
  if (!url) return null;
  let e = cache.get(url);
  if (e) {
    if (e.state === 'ok') { cache.delete(url); cache.set(url, e); return e.img; } // LRU touch
    if (e.state === 'loading') e.waiters.add(onReady);
    return null;
  }
  e = { state: 'loading', img: null, waiters: new Set([onReady]) };
  cache.set(url, e);
  queue.push(url);
  pump();
  return null;
}

function pump() {
  while (inflight < MAX_INFLIGHT && queue.length) {
    const url = queue.pop(); // LIFO: most recently requested (visible) first
    const e = cache.get(url);
    if (!e) continue;
    inflight++;
    fetch(url, { mode: 'cors' })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(b => createImageBitmap(b))
      .then(img => { e.img = img; e.state = 'ok'; })
      .catch(() => { e.state = 'fail'; })
      .finally(() => {
        inflight--;
        for (const w of e.waiters) try { w(); } catch {}
        e.waiters.clear();
        evict();
        pump();
      });
  }
}

function evict() {
  if (cache.size <= MAX_CACHE) return;
  for (const [k, v] of cache) {
    if (cache.size <= MAX_CACHE) break;
    if (v.state !== 'loading') { v.img?.close?.(); cache.delete(k); }
  }
}

export function fmtTime(ms) {
  ms = Math.max(0, ms || 0);
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtDuration(ms) {
  const m = Math.round((ms || 0) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
