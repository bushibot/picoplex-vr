// Scene, WebXR session, controllers/mouse input, cinema screen. UI logic lives in app.js.
import * as THREE from '../vendor/three.module.js';
import { Panel } from './ui.js';
import { Player } from './player.js';
import { App } from './app.js';

const $ = id => document.getElementById(id);
const LSget = (k, d) => { try { const v = localStorage.getItem('pp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const LSset = (k, v) => { try { localStorage.setItem('pp.' + k, JSON.stringify(v)); } catch {} };

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFramebufferScaleFactor(Number(new URLSearchParams(location.search).get('fb')) || 1.2);
renderer.xr.setFoveation(0.3);
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const BLACK = new THREE.Color(0x000000);
scene.background = BLACK;
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 1.6, 0);
scene.add(camera);

// starfield: the "floating in space" environment
const stars = (() => {
  const N = 3000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 40);
    pos.set([v.x, v.y, v.z], i * 3);
    const b = 0.35 + Math.random() * 0.65;
    col.set([b, b, b * (0.9 + Math.random() * 0.2)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true }));
})();
scene.add(stars);

// ---------- panels ----------
const mainPanel = new Panel(2048, 1280, 2.4, 'main');
const mainGroup = new THREE.Group();
mainGroup.add(mainPanel.mesh);
scene.add(mainGroup);

const ctrlPanel = new Panel(1600, 260, 1.6, 'ctrl');

// ---------- cinema screen ----------
const video = $('video');
const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.SRGBColorSpace;
videoTex.minFilter = THREE.LinearFilter;
videoTex.generateMipmaps = false;
const screenMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: videoTex, toneMapped: false, color: 0xffffff }),
);
screenMesh.userData.isScreen = true;
const screenGroup = new THREE.Group();
screenGroup.add(screenMesh);
screenGroup.add(ctrlPanel.mesh);
screenGroup.visible = false;
scene.add(screenGroup);

const screenCfg = { width: 3.6, dist: 3.0, ...LSget('screen', {}) };
let videoAspect = 16 / 9;
function layoutScreen() {
  const w = screenCfg.width, h = w / videoAspect;
  screenMesh.scale.set(w, h, 1);
  ctrlPanel.mesh.position.set(0, -h / 2 - 0.2 - 0.08, 0.15);
}
// Blank the screen while a new source loads so the previous title's last frame never shows.
video.addEventListener('emptied', () => { screenMesh.material.color.setHex(0x000000); });
video.addEventListener('loadeddata', () => { screenMesh.material.color.setHex(0xffffff); });
video.addEventListener('loadedmetadata', () => {
  if (video.videoWidth && video.videoHeight) videoAspect = video.videoWidth / video.videoHeight;
  layoutScreen();
});
video.addEventListener('resize', () => {
  if (video.videoWidth && video.videoHeight) videoAspect = video.videoWidth / video.videoHeight;
  layoutScreen();
});
layoutScreen();

// ---------- head pose / placement ----------
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
function headPose() {
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.updateMatrixWorld(true);
  const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  cam.getWorldQuaternion(_q);
  _e.setFromQuaternion(_q, 'YXZ');
  const fwd = new THREE.Vector3(-Math.sin(_e.y), 0, -Math.cos(_e.y));
  return { pos, fwd };
}
function placeInFront(obj, dist, dy = 0) {
  const { pos, fwd } = headPose();
  obj.position.copy(pos).addScaledVector(fwd, dist);
  obj.position.y = pos.y + dy;
  obj.lookAt(pos.x, obj.position.y, pos.z);
}
function recenter() {
  placeInFront(mainGroup, 2.1, -0.05);
  placeInFront(screenGroup, screenCfg.dist, 0.1);
}

// ---------- view interface for App ----------
let controlsVisible = true;
let inAR = false;
const view = {
  enterPlayer() {
    mainGroup.visible = false;
    screenGroup.visible = true;
    if (!view._screenPlaced) { placeInFront(screenGroup, screenCfg.dist, 0.1); view._screenPlaced = true; }
  },
  exitPlayer() {
    screenGroup.visible = false;
    mainGroup.visible = true;
    mainPanel.invalidate();
  },
  setControlsVisible(v) {
    if (controlsVisible === v) return;
    controlsVisible = v;
    ctrlPanel.mesh.visible = v;
    if (v) ctrlPanel.invalidate();
  },
  pointerOnControls() { return pointers.some(pt => pt.hit?.panel === ctrlPanel); },
  resizeScreen(f) {
    screenCfg.width = THREE.MathUtils.clamp(screenCfg.width * f, 0.8, 30);
    layoutScreen(); LSset('screen', screenCfg);
  },
  recenter() { recenter(); view._screenPlaced = true; },
  setStars(on) { stars.visible = on && !inAR; },
};

// ---------- app ----------
const player = new Player(video);
const app = new App({ panel: mainPanel, ctrl: ctrlPanel, player, view });
window.__app = app; // debugging from devtools
if (new URLSearchParams(location.search).has('debug')) {
  window.__dbg = { THREE, mainPanel, ctrlPanel, mainGroup, screenGroup, screenMesh, camera, renderer, player };
}

// ---------- pointers (XR controllers + mouse) ----------
const raycaster = new THREE.Raycaster();
const pointers = [];
let activePointer = null;
let grab = null; // { pointer, target, offset: Matrix4 }

function makeCursor() {
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.012, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
  m.renderOrder = 10; m.visible = false; scene.add(m);
  return m;
}

for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
  c.add(line);
  scene.add(c);
  const pt = { kind: 'xr', index: i, obj: c, line, cursor: makeCursor(), hit: null, source: null, prevButtons: [], seekCooldown: 0 };
  c.addEventListener('connected', e => {
    pt.source = e.data;
    if (!activePointer || e.data.handedness === 'right') activePointer = pt;
  });
  c.addEventListener('disconnected', () => { pt.source = null; pt.hit = null; pt.cursor.visible = false; });
  c.addEventListener('selectstart', () => { activePointer = pt; });
  c.addEventListener('select', () => { activePointer = pt; click(pt); });
  c.addEventListener('squeezestart', () => startGrab(pt));
  c.addEventListener('squeezeend', () => { if (grab?.pointer === pt) endGrab(); });
  pointers.push(pt);
}

const mouse = { kind: 'mouse', ndc: new THREE.Vector2(), hit: null, cursor: null, active: false };
pointers.push(mouse);

function interactiveMeshes() {
  const out = [];
  if (mainGroup.visible) out.push(mainPanel.mesh);
  if (screenGroup.visible) { if (ctrlPanel.mesh.visible) out.push(ctrlPanel.mesh); out.push(screenMesh); }
  return out;
}

function castPointer(pt) {
  if (pt.kind === 'xr') {
    if (!pt.source || !renderer.xr.isPresenting) { pt.hit = null; pt.line.visible = false; pt.cursor.visible = false; return; }
    pt.line.visible = true;
    pt.obj.updateMatrixWorld();
    raycaster.ray.origin.setFromMatrixPosition(pt.obj.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).transformDirection(pt.obj.matrixWorld);
  } else {
    if (renderer.xr.isPresenting || !pt.active) { pt.hit = null; return; }
    raycaster.setFromCamera(pt.ndc, camera);
  }
  const hits = raycaster.intersectObjects(interactiveMeshes(), false);
  const h = hits[0];
  if (!h) {
    pt.hit = null;
    if (pt.kind === 'xr') { pt.cursor.visible = false; pt.line.scale.z = 5; }
    return;
  }
  const panel = h.object.userData.panel || null;
  let region = null, rx = 0, ry = 0;
  if (panel && h.uv) {
    const r = panel.hitTest(h.uv);
    region = r.region;
    if (region) { rx = r.x - region.x; ry = r.y - region.y; }
  }
  pt.hit = { panel, region, rx, ry, object: h.object, point: h.point, distance: h.distance };
  if (pt.kind === 'xr') {
    pt.line.scale.z = h.distance;
    pt.cursor.visible = true;
    pt.cursor.position.copy(h.point);
    h.object.getWorldQuaternion(pt.cursor.quaternion);
    pt.cursor.translateZ(0.004);
  }
}

function updateHover() {
  const pt = renderer.xr.isPresenting ? activePointer : mouse;
  const h = pt?.hit;
  for (const p of [mainPanel, ctrlPanel]) {
    const id = h && h.panel === p && h.region && h.region.hoverable !== false ? h.region.id : null;
    p.setHover(id);
  }
  renderer.domElement.style.cursor = h?.region?.onClick ? 'pointer' : 'default';
}

function click(pt) {
  app.touch();
  const h = pt.hit;
  if (!h) { if (app.inPlayer) app.controlsVisible = !app.controlsVisible; return; }
  if (h.object === screenMesh) { app.controlsVisible = !app.controlsVisible; return; }
  if (h.region?.onClick) {
    h.region.onClick(h.rx, h.ry, h.region);
    h.panel.invalidate();
  }
}

// ---------- grabbing: squeeze to move the panel/screen; thumbstick Y pushes/pulls while held ----------
const _m = new THREE.Matrix4();
function startGrab(pt) {
  const h = pt.hit;
  if (!h) return;
  const target = (h.object === mainPanel.mesh) ? mainGroup : screenGroup;
  pt.obj.updateMatrixWorld(); target.updateMatrixWorld();
  grab = { pointer: pt, target, offset: _m.copy(pt.obj.matrixWorld).invert().multiply(target.matrixWorld).clone() };
}
function endGrab() {
  if (grab?.target === screenGroup) { view._screenPlaced = true; screenCfg.dist = headPose().pos.distanceTo(screenGroup.position); LSset('screen', screenCfg); }
  grab = null;
}
function updateGrab() {
  if (!grab) return;
  const pt = grab.pointer;
  pt.obj.updateMatrixWorld();
  _m.multiplyMatrices(pt.obj.matrixWorld, grab.offset);
  _m.decompose(grab.target.position, grab.target.quaternion, _v);
  // keep it upright: only yaw toward the viewer
  const head = headPose().pos;
  grab.target.lookAt(head.x, grab.target.position.y, head.z);
}

// ---------- gamepads ----------
// xr-standard mapping: 0 trigger, 1 squeeze, 3 thumbstick press, 4 A/X, 5 B/Y; axes 2/3 thumbstick
function pollGamepads(dt, now) {
  for (const pt of pointers) {
    if (pt.kind !== 'xr' || !pt.source?.gamepad) continue;
    const gp = pt.source.gamepad;
    const b = gp.buttons.map(x => x.pressed);
    const rising = i => b[i] && !pt.prevButtons[i];
    if (rising(4)) app.onPrimary();
    if (rising(5)) app.onBack();
    pt.prevButtons = b;

    const ax = gp.axes;
    let sx = ax.length >= 4 ? ax[2] : ax[0], sy = ax.length >= 4 ? ax[3] : ax[1];
    if (Math.abs(sx) < 0.15) sx = 0;
    if (Math.abs(sy) < 0.15) sy = 0;
    if (!sx && !sy) { pt.seekCooldown = 0; continue; }
    app.touch();

    if (grab?.pointer === pt) {
      // push/pull along the controller ray
      grab.offset.premultiply(_m.makeTranslation(0, 0, sy * dt * 2.5));
      continue;
    }
    if (app.inPlayer) {
      if (Math.abs(sx) > 0.7 && Math.abs(sx) > Math.abs(sy) && now > pt.seekCooldown) {
        player.seekBy(sx > 0 ? 10000 : -10000);
        app.controlsVisible = true; ctrlPanel.invalidate();
        pt.seekCooldown = now + 350;
      } else if (Math.abs(sy) > Math.abs(sx)) {
        view.resizeScreen(1 - sy * dt * 0.9);
      }
    } else {
      app.scroll(sy * dt * 1600);
    }
  }
}

// ---------- desktop mouse / keyboard (testing without a headset) ----------
const el = renderer.domElement;
el.addEventListener('pointermove', e => {
  mouse.active = true;
  mouse.ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
});
el.addEventListener('pointerleave', () => { mouse.active = false; });
el.addEventListener('click', () => click(mouse));
el.addEventListener('wheel', e => {
  e.preventDefault();
  if (app.inPlayer) view.resizeScreen(e.deltaY > 0 ? 1 / 1.05 : 1.05);
  else app.scroll(e.deltaY);
}, { passive: false });
window.addEventListener('keydown', e => {
  if (renderer.xr.isPresenting) return;
  if (e.key === 'Escape' || e.key === 'Backspace') app.onBack();
  else if (e.key === ' ') { e.preventDefault(); app.onPrimary(); }
  else if (e.key === 'ArrowRight' && app.inPlayer) player.seekBy(10000);
  else if (e.key === 'ArrowLeft' && app.inPlayer) player.seekBy(-10000);
  else if (e.key === 'ArrowDown') app.scroll(300);
  else if (e.key === 'ArrowUp') app.scroll(-300);
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- XR session ----------
let recenterFrames = -1;
async function enterXR(mode) {
  try {
    const session = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    inAR = mode === 'immersive-ar';
    scene.background = inAR ? null : BLACK;
    renderer.setClearColor(0x000000, inAR ? 0 : 1);
    stars.visible = app.settings.stars && !inAR;
    await renderer.xr.setSession(session);
    $('overlay').classList.add('hidden');
    recenterFrames = 0;
    // Prime the video element inside the user gesture so later play() with audio is allowed.
    video.play().catch(() => {});
    session.addEventListener('end', () => {
      inAR = false;
      scene.background = BLACK;
      renderer.setClearColor(0x000000, 1);
      stars.visible = app.settings.stars;
      $('overlay').classList.remove('hidden');
      camera.position.set(0, 1.6, 0); camera.rotation.set(0, 0, 0);
      recenter();
    });
  } catch (e) {
    console.error(e);
    $('status').textContent = `Could not start ${mode}: ${e.message}`;
  }
}

async function setupButtons() {
  const vr = $('enter-vr'), ar = $('enter-ar');
  if (!window.isSecureContext) {
    $('status').textContent = 'WebXR needs HTTPS. Serve this page over https:// (Pico browser has no insecure-origin override).';
  }
  if (!navigator.xr) { $('status').textContent ||= 'WebXR not available in this browser — desktop mode only (mouse + wheel).'; return; }
  if (await navigator.xr.isSessionSupported('immersive-vr').catch(() => false)) {
    vr.hidden = false; vr.onclick = () => enterXR('immersive-vr');
  }
  if (await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)) {
    ar.hidden = false; ar.onclick = () => enterXR('immersive-ar');
  }
}
setupButtons();
$('hide-overlay').onclick = () => $('overlay').classList.add('hidden');

// ---------- loop ----------
let last = performance.now();
recenter();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (recenterFrames >= 0 && renderer.xr.isPresenting) {
    if (++recenterFrames > 3) { recenter(); recenterFrames = -1; } // wait for a real head pose
  }
  pollGamepads(dt, now);
  updateGrab();
  for (const pt of pointers) castPointer(pt);
  updateHover();
  app.tick(now);
  mainPanel.texture.anisotropy = ctrlPanel.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  mainPanel.update();
  ctrlPanel.update();
  renderer.render(scene, camera);
});

app.start();
