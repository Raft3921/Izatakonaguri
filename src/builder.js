// Remove ES module import and use global THREE
// import * as THREE from '../libs/three/build/three.module.js';

// Ensure THREE is available globally
if (typeof THREE === 'undefined') {
  console.error('THREE.js is not loaded. Please include it in your HTML file.');
}

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070d1b);
scene.fog = new THREE.FogExp2(0x070d1b, 0.014);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.08, 700);
camera.position.set(0, 6, 14);
camera.rotation.order = 'YXZ';

const hemi = new THREE.HemisphereLight(0x9fb6ff, 0x0f172a, 0.45);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0x6e7bbd, 0.28);
scene.add(ambient);
const dir = new THREE.DirectionalLight(0xffffff, 0.7);
dir.position.set(16, 32, 14);
scene.add(dir);

const decorativeFloor = new THREE.Mesh(
  new THREE.CircleGeometry(120, 64),
  new THREE.MeshBasicMaterial({ color: 0x091326, transparent: true, opacity: 0.78 })
);
decorativeFloor.rotation.x = -Math.PI / 2;
decorativeFloor.position.y = -0.02;
scene.add(decorativeFloor);

const grid = new THREE.GridHelper(120, 120, 0x274e7e, 0x132c4f);
grid.material.opacity = 0.32;
grid.material.transparent = true;
scene.add(grid);

const basePlane = new THREE.Mesh(
  new THREE.PlaneGeometry(240, 240),
  new THREE.MeshBasicMaterial({ visible: false })
);
basePlane.rotateX(-Math.PI / 2);
basePlane.userData.isPlane = true;
scene.add(basePlane);

const BLOCK_SIZE = 1;
const boxGeometry = new THREE.BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
const blocks = new Map();
const materialCache = new Map();
const blockSpatialIndex = new Map();
const EDIT_CHUNK_SIZE = 4;
const AUTOSAVE_SUPPORTED = typeof window !== 'undefined' && 'indexedDB' in window;
const AUTOSAVE_DB_NAME = 'iza-builder';
const AUTOSAVE_DB_VERSION = 1;
const AUTOSAVE_STORE = 'structures';
let autosaveDBPromise = null;
let autosaveTimer = null;

const raycaster = new THREE.Raycaster();
const pointerCenter = new THREE.Vector2(0, 0);
const faceNormal = new THREE.Vector3();
const normalMatrix = new THREE.Matrix3();

const statusEl = document.getElementById('status');
const colorPicker = document.getElementById('colorPicker');
const clearBtn = document.getElementById('clearBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const fileInput = document.getElementById('fileInput');
const structureSlotSelect = document.getElementById('structureSlot');
const structureScaleInput = document.getElementById('structureScale');
const scaleRangeInput = document.getElementById('scaleRange');
const colorHistoryEl = document.getElementById('colorHistory');
const hudEl = document.getElementById('hud');
const foldToggleBtn = document.getElementById('hudFoldToggle');
const hudTabButton = document.getElementById('hudTabButton');
const paletteTabButton = document.getElementById('paletteTabButton');
const sfxTabButton = document.getElementById('sfxTabButton');
const palettePanel = document.getElementById('palettePanel');
const sfxPanel = document.getElementById('sfxPanel');
const colorWheelCanvas = document.getElementById('colorWheelCanvas');
const colorSurfaceCanvas = document.getElementById('colorSurfaceCanvas');
const opacitySlider = document.getElementById('opacitySlider');
const paletteHexLabel = document.getElementById('paletteHexLabel');
const currentColorPreview = document.getElementById('currentColorPreview');
const buildVolumeSlider = document.getElementById('buildVolume');
const movementVolumeSlider = document.getElementById('movementVolume');
const hexInput = document.getElementById('hexInput');
const copyHexBtn = document.getElementById('copyHexBtn');
const randomColorBtn = document.getElementById('randomColorBtn');
const rgbaInputR = document.getElementById('rgbaR');
const rgbaInputG = document.getElementById('rgbaG');
const rgbaInputB = document.getElementById('rgbaB');
const rgbaInputA = document.getElementById('rgbaA');
const favoriteToggleBtn = document.getElementById('favoriteToggle');
const lightenBtn = document.getElementById('lightenBtn');
const darkenBtn = document.getElementById('darkenBtn');
const pinnedColorsEl = document.getElementById('pinnedColors');
const structureNameInput = document.getElementById('structureName');
const cameraFovInput = document.getElementById('cameraFov');
const cameraSpeedInput = document.getElementById('cameraSpeed');
const gridToggle = document.getElementById('gridToggle');
const crosshairToggle = document.getElementById('crosshairToggle');
const highlightToggle = document.getElementById('highlightToggle');
const skyThemeSelect = document.getElementById('skyTheme');
const resetCameraBtn = document.getElementById('resetCameraBtn');
const focusHighlightBtn = document.getElementById('focusHighlightBtn');
const dominantColorsEl = document.getElementById('dominantColors');
const blockSummaryEl = document.getElementById('blockSummary');
const crosshairEl = document.querySelector('.crosshair');
const builderMoveStick = document.getElementById('builderMoveStick');
const builderMoveThumb = document.getElementById('builderMoveThumb');
const builderLookPad = document.getElementById('builderLookPad');
const builderUpBtn = document.getElementById('builderUpBtn');
const builderDownBtn = document.getElementById('builderDownBtn');
const builderPlaceBtn = document.getElementById('builderPlaceBtn');
const builderRemoveBtn = document.getElementById('builderRemoveBtn');
const builderGameBtn = document.getElementById('builderGameBtn');
const builderHint = document.getElementById('builderTouchHint');

const isTouchDevice = (typeof window !== 'undefined') && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
if (isTouchDevice) {
  document.body.classList.add('is-touch');
  requestFullscreenIfNeeded();
}

const ghostMaterial = new THREE.MeshStandardMaterial({
  color: new THREE.Color(colorPicker.value),
  transparent: true,
  opacity: 0.28,
  roughness: 0.35,
  metalness: 0.05,
  depthWrite: false,
  emissive: new THREE.Color(colorPicker.value).multiplyScalar(0.28)
});
const ghostMesh = new THREE.Mesh(boxGeometry.clone(), ghostMaterial);
ghostMesh.renderOrder = 2;
ghostMesh.visible = false;
ghostMesh.userData.isGhost = true;
scene.add(ghostMesh);

const transientEffects = [];

let audioCtx;
let placeBuffer;
let removeBuffer;
let hudFoldState = 'open';
let hudAnimationTimeout;
let paletteOpen = false;
let sfxOpen = false;
const soundGains = {
  build: 1,
  movement: 0.7
};

let currentHue = 30 / 360;
let currentSaturation = 0.8;
let currentValue = 1;
let currentAlpha = 1;
let isWheelDragging = false;
let isSurfaceDragging = false;
let baseMoveSpeed = 9;
let highlightEnabled = false;
let lastPlacedPosition = null;
let structureName = 'スロット1';
let currentSlot = '1';
const structureNames = new Map([[currentSlot, structureName]]);

const colorWheelCtx = colorWheelCanvas ? colorWheelCanvas.getContext('2d') : null;
const colorSurfaceCtx = colorSurfaceCanvas ? colorSurfaceCanvas.getContext('2d') : null;
const colorWheelRadius = colorWheelCanvas ? colorWheelCanvas.width / 2 : 0;
const colorWheelInnerRadius = colorWheelRadius * 0.68;

const touchMoveInput = { x: 0, y: 0, strength: 0 };
let movePointerId = null;
const touchLookState = { pointerId: null, lastX: 0, lastY: 0 };
const TOUCH_LOOK_SPEED = 0.003;
let fullscreenRequested = false;
const touchHintsShown = new Set();

function requestFullscreenIfNeeded() {
  if (!isTouchDevice || fullscreenRequested) return;
  fullscreenRequested = true;
  const element = document.documentElement;
  if (element.requestFullscreen) {
    element.requestFullscreen().catch(() => {
      fullscreenRequested = false;
    });
  } else if (element.webkitRequestFullscreen) {
    element.webkitRequestFullscreen();
  } else {
    fullscreenRequested = false;
  }
}

function showTouchHint(type) {
  if (!isTouchDevice || !builderHint || touchHintsShown.has(type)) return;
  touchHintsShown.add(type);
  const messages = {
    move: '左スティックで移動',
    look: '右パッドで視点操作',
    place: '設置ボタンでブロック配置',
  };
  builderHint.textContent = messages[type] || 'タッチ操作';
  builderHint.classList.add('is-visible');
  setTimeout(() => {
    builderHint.classList.remove('is-visible');
  }, 1600);
}

function setOpacity(alpha, { syncSlider = true } = {}) {
  currentAlpha = Math.max(0, Math.min(1, alpha));
  if (syncSlider && opacitySlider) {
    opacitySlider.value = Math.round(currentAlpha * 100);
  }
  updateActiveColor();
}

const skyThemes = {
  night: { background: 0x070d1b, fogDensity: 0.014, hemi: 0x9fb6ff, ambient: 0x6e7bbd, dir: 0xffffff },
  dawn: { background: 0x1f2538, fogDensity: 0.01, hemi: 0xffcba4, ambient: 0xfab387, dir: 0xfff0e0 },
  noon: { background: 0xaee1ff, fogDensity: 0.006, hemi: 0xffffff, ambient: 0xdbeafe, dir: 0xffffff },
  void: { background: 0x050505, fogDensity: 0.02, hemi: 0x8b939c, ambient: 0x4b5563, dir: 0xcccccc }
};
const skyThemeLabels = {
  night: '夜明け前',
  dawn: '朝霧',
  noon: '青空',
  void: '虚空'
};

function applySkyTheme(key, { silent = false } = {}) {
  const theme = skyThemes[key] || skyThemes.night;
  scene.background = new THREE.Color(theme.background);
  scene.fog = new THREE.FogExp2(theme.background, theme.fogDensity);
  hemi.color = new THREE.Color(theme.hemi);
  ambient.color = new THREE.Color(theme.ambient);
  dir.color = new THREE.Color(theme.dir);
  if (!silent) updateStatus(`空のテーマ: ${skyThemeLabels[key] || key}`);
}

function updateHudToggleLabel() {
  if (!foldToggleBtn) return;
  const openish = hudFoldState === 'open' || hudFoldState === 'opening';
  foldToggleBtn.textContent = openish ? '⇢' : '⇠';
  foldToggleBtn.setAttribute('aria-label', openish ? 'HUD を格納' : 'HUD を展開');
  if (hudTabButton) {
    const collapsed = hudFoldState === 'collapsed' || hudFoldState === 'folding';
    hudTabButton.classList.toggle('is-active', collapsed);
  }
}

function ensureAudioContext() {
  if (typeof window.AudioContext === 'undefined' && typeof window.webkitAudioContext === 'undefined') return null;
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
    placeBuffer = designSoundBuffer(audioCtx, 0.28, ({ time, progress }) => {
      const env = Math.pow(1 - progress, 3);
      const freq = 380 + 220 * Math.sin(progress * Math.PI);
      const tone = Math.sin(2 * Math.PI * freq * time);
      const shimmer = Math.sin(2 * Math.PI * freq * 2.6 * time) * (1 - progress) * 0.6;
      return (tone * 0.7 + shimmer * 0.3) * env;
    });
    removeBuffer = designSoundBuffer(audioCtx, 0.32, ({ time, progress }) => {
      const env = Math.pow(1 - progress, 2.6);
      const freq = 220 - 60 * progress;
      const tone = Math.sin(2 * Math.PI * freq * time);
      const rumble = Math.sin(2 * Math.PI * 80 * time) * 0.4;
      return (tone * 0.6 + rumble * 0.4) * env;
    });
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function designSoundBuffer(ctx, duration, fn, options = {}) {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const time = i / sampleRate;
    const progress = i / length;
    const sample = fn({ time, progress, index: i, length });
    data[i] = Math.max(-1, Math.min(1, sample));
  }
  if (options.loop && length > 8) {
    const smooth = Math.min(512, Math.floor(length / 6));
    for (let j = 0; j < smooth; j += 1) {
      const blend = j / smooth;
      const startIndex = j;
      const endIndex = length - smooth + j;
      const mixed = data[startIndex] * blend + data[endIndex] * (1 - blend);
      data[startIndex] = mixed;
      data[endIndex] = mixed;
    }
    data[length - 1] = data[0];
  }
  return buffer;
}

function playSound(buffer, gainValue = 0.42, category = 'build') {
  const ctx = ensureAudioContext();
  if (!ctx || !buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  const categoryGain = soundGains[category] ?? 1;
  gain.gain.value = gainValue * categoryGain;
  source.connect(gain).connect(ctx.destination);
  source.start();
}

['pointerdown', 'keydown'].forEach((eventName) => {
  window.addEventListener(eventName, () => ensureAudioContext(), { once: true, passive: true });
});

function gridKey(x, y, z) {
  return `${x},${y},${z}`;
}

function chunkKeyFromGrid({ x, y, z }) {
  const cx = Math.floor(x / EDIT_CHUNK_SIZE);
  const cy = Math.floor(y / EDIT_CHUNK_SIZE);
  const cz = Math.floor(z / EDIT_CHUNK_SIZE);
  return `${cx},${cy},${cz}`;
}

function chunkKeyFromWorld(worldVec) {
  return chunkKeyFromGrid(worldToGrid(worldVec));
}

function gridToWorld({ x, y, z }) {
  return new THREE.Vector3((x + 0.5) * BLOCK_SIZE, (y + 0.5) * BLOCK_SIZE, (z + 0.5) * BLOCK_SIZE);
}

function worldToGrid(point) {
  return {
    x: Math.floor(point.x / BLOCK_SIZE),
    y: Math.floor(point.y / BLOCK_SIZE),
    z: Math.floor(point.z / BLOCK_SIZE)
  };
}

function meshToGrid(mesh) {
  return {
    x: Math.floor(mesh.position.x / BLOCK_SIZE),
    y: Math.floor(mesh.position.y / BLOCK_SIZE),
    z: Math.floor(mesh.position.z / BLOCK_SIZE)
  };
}

function clampGrid(gridPos) {
  return {
    x: gridPos.x,
    y: Math.max(0, gridPos.y),
    z: gridPos.z
  };
}

function currentSlotId() {
  const raw = structureSlotSelect.value;
  return raw && ['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(raw) ? raw : '1';
}

function getStructureScale() {
  const v = parseFloat(structureScaleInput.value);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function getOrCreateMaterial(colorHex, alpha = 1) {
  const key = `${colorHex}:${alpha.toFixed(2)}`;
  if (!materialCache.has(key)) {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      roughness: 0.42,
      metalness: 0.1,
      emissive: new THREE.Color(colorHex).multiplyScalar(0.15),
      emissiveIntensity: highlightEnabled ? 0.6 : 0.18,
      transparent: alpha < 1,
      opacity: alpha,
      depthWrite: alpha >= 1
    });
    materialCache.set(key, material);
  }
  return materialCache.get(key);
}

function spawnEffect(mesh, duration, onUpdate, cleanup) {
  transientEffects.push({ mesh, duration, elapsed: 0, onUpdate, cleanup });
  scene.add(mesh);
}

const sparkGeometry = new THREE.SphereGeometry(0.06, 8, 8);
const placementSphereGeometry = new THREE.SphereGeometry(0.45, 24, 24);

function spawnPlacementSphere(worldPos, colorHex, alpha = 1) {
  const group = new THREE.Group();
  const color = new THREE.Color(colorHex);
  const coreOpacity = Math.max(0.2, alpha * 0.35 + 0.07);
  const haloOpacity = Math.max(0.12, alpha * 0.25);
  const core = new THREE.Mesh(placementSphereGeometry, new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: coreOpacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  }));
  const halo = new THREE.Mesh(placementSphereGeometry.clone(), new THREE.MeshBasicMaterial({
    color: color.clone().offsetHSL(0, 0, 0.1),
    transparent: true,
    opacity: haloOpacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  }));
  halo.scale.setScalar(1.1);
  group.add(core);
  group.add(halo);
  group.position.copy(worldPos);

  spawnEffect(group, 0.42, (effect, delta, progress) => {
    const expand = 0.55 + progress * 0.8;
    core.scale.setScalar(expand);
    halo.scale.setScalar(expand * 1.15);
    core.material.opacity = coreOpacity * (1 - progress * 0.85);
    halo.material.opacity = haloOpacity * (1 - progress);
  }, (mesh) => {
    mesh.traverse((child) => {
      if (child.material && child.material.dispose) child.material.dispose();
    });
  });
}

function spawnRemovalBurst(worldPos) {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x93c5fd),
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const particles = [];
  for (let i = 0; i < 18; i += 1) {
    const spark = new THREE.Mesh(sparkGeometry, material.clone());
    const v = new THREE.Vector3(
      (Math.random() - 0.5) * 3.5,
      Math.random() * 2.6 + 0.4,
      (Math.random() - 0.5) * 3.5
    );
    particles.push({ mesh: spark, velocity: v });
    group.add(spark);
  }
  group.position.copy(worldPos);
  spawnEffect(group, 0.5, (effect, delta, progress) => {
    particles.forEach((entry) => {
      entry.mesh.position.addScaledVector(entry.velocity, delta);
      entry.mesh.material.opacity = 0.9 * (1 - progress);
    });
  }, (mesh) => {
    mesh.traverse((child) => {
      if (child.material && child.material.dispose) child.material.dispose();
    });
  });
}

function updateEffects(delta) {
  for (let i = transientEffects.length - 1; i >= 0; i -= 1) {
    const effect = transientEffects[i];
    effect.elapsed += delta;
    const progress = Math.min(1, effect.elapsed / effect.duration);
    effect.onUpdate(effect, delta, progress);
    if (effect.elapsed >= effect.duration) {
      scene.remove(effect.mesh);
      if (effect.cleanup) {
        effect.cleanup(effect.mesh);
      } else if (effect.mesh.material && effect.mesh.material.dispose) {
        effect.mesh.material.dispose();
      }
      transientEffects.splice(i, 1);
    }
  }
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

const colorHistory = [];
let pinnedColors = [];
const PINNED_STORAGE_KEY = 'builderPinnedColors';

function renderColorHistory() {
  if (!colorHistoryEl) return;
  colorHistoryEl.textContent = '';
  colorHistory.forEach(({ hex, alpha }) => {
    const { r, g, b } = hexToRgb(hex);
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.style.background = `linear-gradient(135deg, ${rgbToCss(r, g, b, 0)} 0%, ${rgbToCss(r, g, b, alpha)} 100%)`;
    swatch.title = `${hex} α${Math.round(alpha * 100)}%`;
    swatch.setAttribute('aria-label', `${hex} alpha ${Math.round(alpha * 100)} percent`);
    swatch.addEventListener('click', () => {
      currentAlpha = alpha;
      if (opacitySlider) opacitySlider.value = Math.round(currentAlpha * 100);
      setColorFromHex(hex, true);
      updateStatus(`色 ${hex}`);
    });
    colorHistoryEl.appendChild(swatch);
  });
}

function rememberColor(hex, alpha = currentAlpha) {
  if (!isHexColor(hex)) return;
  const existingIndex = colorHistory.findIndex((entry) => entry.hex === hex && Math.abs(entry.alpha - alpha) < 0.01);
  if (existingIndex >= 0) colorHistory.splice(existingIndex, 1);
  colorHistory.unshift({ hex, alpha });
  if (colorHistory.length > 28) colorHistory.pop();
  renderColorHistory();
  updateFavoriteButtonState();
}


function updateBlockInsights() {
  if (blockSummaryEl) {
    const total = blocks.size;
    if (total === 0) {
      blockSummaryEl.textContent = 'まだブロックが配置されていません。';
    } else {
      let maxHeight = 0;
      const colorCounts = new Map();
      blocks.forEach(({ grid, color, alpha }) => {
        if (grid.y > maxHeight) maxHeight = grid.y;
        const key = `${color}:${alpha.toFixed(2)}`;
        colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
      });
      blockSummaryEl.innerHTML = '';
      const totalChip = document.createElement('div');
      totalChip.className = 'insight-chip';
      totalChip.textContent = `総数 ${total}`;
      const heightChip = document.createElement('div');
      heightChip.className = 'insight-chip';
      heightChip.textContent = `最大高さ ${maxHeight}`;
      const uniqueChip = document.createElement('div');
      uniqueChip.className = 'insight-chip';
      uniqueChip.textContent = `色の種類 ${colorCounts.size}`;
      blockSummaryEl.appendChild(totalChip);
      blockSummaryEl.appendChild(heightChip);
      blockSummaryEl.appendChild(uniqueChip);
    }
  }

  if (dominantColorsEl) {
    dominantColorsEl.innerHTML = '';
    if (blocks.size === 0) {
      dominantColorsEl.textContent = '—';
      return;
    }
    const counts = new Map();
    blocks.forEach(({ color, alpha }) => {
      const key = `${color}:${alpha.toFixed(2)}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (sorted.length === 0) {
      dominantColorsEl.textContent = '—';
      return;
    }
    sorted.forEach(([key, count]) => {
      const [hex, alphaStr] = key.split(':');
      const alpha = parseFloat(alphaStr);
      const { r, g, b } = hexToRgb(hex);
      const chip = document.createElement('div');
      chip.className = 'insight-chip';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = rgbToCss(r, g, b, alpha);
      chip.appendChild(swatch);
      const label = document.createElement('span');
      label.textContent = `${hex}（${count}）`;
      chip.appendChild(label);
      dominantColorsEl.appendChild(chip);
    });
  }
}

function loadPinnedColors() {
  if (typeof localStorage === 'undefined') {
    pinnedColors = [];
    renderPinnedColors();
    return;
  }
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        pinnedColors = parsed.filter((item) => item && typeof item.hex === 'string').map((item) => ({
          hex: isHexColor(item.hex) ? item.hex.toUpperCase() : '#FFFFFF',
          alpha: typeof item.alpha === 'number' ? Math.max(0, Math.min(1, item.alpha)) : 1
        }));
      }
    }
  } catch (err) {
    pinnedColors = [];
  }
  renderPinnedColors();
}

function savePinnedColors() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinnedColors));
  } catch (err) {
    // ignore storage errors
  }
}

function colorsMatch(a, b) {
  return a && b && a.hex === b.hex && Math.abs(a.alpha - b.alpha) < 0.01;
}

function updateFavoriteButtonState() {
  if (!favoriteToggleBtn) return;
  const current = { hex: colorPicker.value.toUpperCase(), alpha: currentAlpha };
  const isPinned = pinnedColors.some((entry) => colorsMatch(entry, current));
  favoriteToggleBtn.classList.toggle('active', isPinned);
  favoriteToggleBtn.textContent = isPinned ? '★' : '☆';
  favoriteToggleBtn.setAttribute('aria-label', isPinned ? 'お気に入りから削除' : 'お気に入りに追加');
}

function renderPinnedColors() {
  if (!pinnedColorsEl) return;
  pinnedColorsEl.textContent = '';
  pinnedColors.forEach((entry, index) => {
    const { r, g, b } = hexToRgb(entry.hex);
    const button = document.createElement('button');
    button.type = 'button';
    button.style.background = `linear-gradient(135deg, ${rgbToCss(r, g, b, 0)} 0%, ${rgbToCss(r, g, b, entry.alpha)} 100%)`;
    button.title = `${entry.hex} α${Math.round(entry.alpha * 100)}%`;
    button.addEventListener('click', () => {
      currentAlpha = entry.alpha;
      if (opacitySlider) opacitySlider.value = Math.round(entry.alpha * 100);
      setColorFromHex(entry.hex, true);
      updateStatus(`お気に入り: ${entry.hex}`);
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      pinnedColors.splice(index, 1);
      renderPinnedColors();
      savePinnedColors();
      updateFavoriteButtonState();
    });
    pinnedColorsEl.appendChild(button);
  });
  updateFavoriteButtonState();
}

function updateGhostColor() {
  const hex = colorPicker.value;
  ghostMaterial.color.set(hex);
  ghostMaterial.emissive.set(hex).multiplyScalar(0.25);
  ghostMaterial.opacity = Math.max(0.15, currentAlpha * 0.4);
  ghostMaterial.transparent = true;
  ghostMaterial.depthWrite = currentAlpha >= 0.95;
  ghostMaterial.needsUpdate = true;
}

function applyHighlightMode() {
  materialCache.forEach((material) => {
    material.emissiveIntensity = highlightEnabled ? 0.6 : 0.18;
  });
  if (highlightToggle) {
    highlightToggle.checked = highlightEnabled;
  }
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const mod = i % 6;
  const map = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q]
  ][mod];
  return { r: Math.round(map[0] * 255), g: Math.round(map[1] * 255), b: Math.round(map[2] * 255) };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function hexToRgb(hex) {
  if (!isHexColor(hex)) return { r: 255, g: 255, b: 255 };
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

function rgbToHsv(r, g, b) {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rNorm) {
      h = ((gNorm - bNorm) / delta + (gNorm < bNorm ? 6 : 0)) / 6;
    } else if (max === gNorm) {
      h = ((bNorm - rNorm) / delta + 2) / 6;
    } else {
      h = ((rNorm - gNorm) / delta + 4) / 6;
    }
  }
  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

function rgbToCss(r, g, b, a = 1) {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function updateOpacitySliderVisual({ r, g, b }) {
  if (!opacitySlider) return;
  const opaque = rgbToCss(r, g, b, 1);
  const transparent = rgbToCss(r, g, b, 0);
  opacitySlider.style.background = `linear-gradient(90deg, ${transparent} 0%, ${opaque} 100%)`;
}

function drawColorSurface() {
  if (!colorSurfaceCtx || !colorSurfaceCanvas || !colorSurfaceCanvas.width) return;
  const size = colorSurfaceCanvas.width;
  const image = colorSurfaceCtx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    const v = 1 - y / (size - 1);
    for (let x = 0; x < size; x += 1) {
      const s = x / (size - 1);
      const { r, g, b } = hsvToRgb(currentHue, s, v);
      const index = (y * size + x) * 4;
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = 255;
    }
  }
  colorSurfaceCtx.putImageData(image, 0, 0);
  const cx = currentSaturation * (size - 1);
  const cy = (1 - currentValue) * (size - 1);
  colorSurfaceCtx.save();
  colorSurfaceCtx.lineWidth = 3;
  colorSurfaceCtx.strokeStyle = 'rgba(15,23,42,0.85)';
  colorSurfaceCtx.beginPath();
  colorSurfaceCtx.moveTo(cx - 6, cy);
  colorSurfaceCtx.lineTo(cx + 6, cy);
  colorSurfaceCtx.moveTo(cx, cy - 6);
  colorSurfaceCtx.lineTo(cx, cy + 6);
  colorSurfaceCtx.stroke();
  colorSurfaceCtx.strokeStyle = 'rgba(248,250,252,0.85)';
  colorSurfaceCtx.lineWidth = 1.5;
  colorSurfaceCtx.beginPath();
  colorSurfaceCtx.moveTo(cx - 6, cy);
  colorSurfaceCtx.lineTo(cx + 6, cy);
  colorSurfaceCtx.moveTo(cx, cy - 6);
  colorSurfaceCtx.lineTo(cx, cy + 6);
  colorSurfaceCtx.stroke();
  colorSurfaceCtx.restore();
}

function updateActiveColor() {
  const { r, g, b } = hsvToRgb(currentHue, currentSaturation, currentValue);
  const hex = rgbToHex(r, g, b);
  colorPicker.value = hex;
  if (paletteHexLabel) paletteHexLabel.textContent = hex;
  if (hexInput) {
    const alphaHex = currentAlpha >= 1 ? '' : Math.round(currentAlpha * 255).toString(16).padStart(2, '0');
    hexInput.value = `${hex}${alphaHex}`;
  }
  if (rgbaInputR) rgbaInputR.value = r;
  if (rgbaInputG) rgbaInputG.value = g;
  if (rgbaInputB) rgbaInputB.value = b;
  if (rgbaInputA) rgbaInputA.value = Math.round(currentAlpha * 100);
  if (currentColorPreview) {
    currentColorPreview.style.background = `linear-gradient(135deg, ${rgbToCss(r, g, b, 0)} 0%, ${rgbToCss(r, g, b, currentAlpha)} 100%)`;
  }
  if (paletteTabButton) {
    paletteTabButton.style.background = `linear-gradient(135deg, ${hex}, ${hex}CC)`;
    paletteTabButton.style.color = '#03131f';
  }
  updateOpacitySliderVisual({ r, g, b });
  drawColorSurface();
  updateGhostColor();
  updateFavoriteButtonState();
}

function setColorFromHSV(h, s, v = 1, { syncSlider = true } = {}) {
  currentHue = (h % 1 + 1) % 1;
  currentSaturation = Math.min(Math.max(s, 0), 1);
  currentValue = Math.min(Math.max(v, 0.1), 1);
  updateActiveColor();
}

function setColorFromHex(hex, focusPalette = false) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, v } = rgbToHsv(r, g, b);
  currentValue = v || 1;
  setColorFromHSV(h, s, currentValue, { syncSlider: true });
  if (focusPalette && palettePanel) {
    setPaletteOpen(true);
  }
}

function drawColorWheel() {
  if (!colorWheelCtx || !colorWheelCanvas) return;
  const size = colorWheelCanvas.width;
  const image = colorWheelCtx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - colorWheelRadius;
      const dy = y - colorWheelRadius;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const index = (y * size + x) * 4;
      if (dist < colorWheelInnerRadius - 4 || dist > colorWheelRadius) {
        image.data[index + 3] = 0;
        continue;
      }
      const angle = Math.atan2(dy, dx);
      const hue = (angle + Math.PI) / (Math.PI * 2);
      const { r, g, b } = hsvToRgb(hue, 1, 1);
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = 255;
    }
  }
  colorWheelCtx.putImageData(image, 0, 0);
}

function handleWheelPointer(event) {
  if (!colorWheelCanvas) return;
  const rect = colorWheelCanvas.getBoundingClientRect();
  const scaleX = colorWheelCanvas.width / rect.width;
  const scaleY = colorWheelCanvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const dx = x - colorWheelRadius;
  const dy = y - colorWheelRadius;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < colorWheelInnerRadius - 8 || dist > colorWheelRadius + 4) {
    return;
  }
  const angle = Math.atan2(dy, dx);
  setColorFromHSV((angle + Math.PI) / (Math.PI * 2), currentSaturation, currentValue, { syncSlider: false });
  updateStatus('カラー更新');
}

function handleSurfacePointer(event) {
  if (!colorSurfaceCanvas) return;
  const rect = colorSurfaceCanvas.getBoundingClientRect();
  const scaleX = colorSurfaceCanvas.width / rect.width;
  const scaleY = colorSurfaceCanvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const size = colorSurfaceCanvas.width - 1;
  const sat = Math.min(1, Math.max(0, x / size));
  const val = Math.min(1, Math.max(0, 1 - (y / size)));
  setColorFromHSV(currentHue, sat, val, { syncSlider: false });
  updateStatus('カラー更新');
}

function updateStatus(message) {
  const baseName = structureName ? structureName : `Slot ${currentSlot}`;
  const base = `${baseName} ｜ ${blocks.size} ブロック`;
  const slot = `スロット ${currentSlotId()}`;
  const scale = `Scale ${getStructureScale().toFixed(2)}`;
  statusEl.textContent = message ? `${base} ｜ ${slot} ｜ ${scale} ｜ ${message}` : `${base} ｜ ${slot} ｜ ${scale}`;
}

function finalizeHudCollapse(collapsed) {
  hudEl.classList.toggle('is-collapsing', false);
  hudFoldState = collapsed ? 'collapsed' : 'open';
  updateHudToggleLabel();
}

function foldHud() {
  if (!hudEl || hudFoldState !== 'open') return;
  hudFoldState = 'folding';
  updateHudToggleLabel();
  clearTimeout(hudAnimationTimeout);
  hudEl.classList.add('is-collapsing');
  hudEl.classList.add('is-collapsed');
  updateStatus('HUD を格納');
  hudAnimationTimeout = setTimeout(() => finalizeHudCollapse(true), 320);
}

function expandHud() {
  if (!hudEl || hudFoldState !== 'collapsed') return;
  hudFoldState = 'opening';
  updateHudToggleLabel();
  clearTimeout(hudAnimationTimeout);
  hudEl.classList.remove('is-collapsed');
  hudEl.classList.add('is-collapsing');
  updateStatus('HUD を展開');
  hudAnimationTimeout = setTimeout(() => finalizeHudCollapse(false), 320);
}

if (foldToggleBtn) {
  foldToggleBtn.addEventListener('click', () => {
    if (hudFoldState === 'open') {
      foldHud();
    }
  });
}

if (hudTabButton) {
  hudTabButton.addEventListener('click', () => {
    if (hudFoldState === 'collapsed') {
      expandHud();
    } else if (hudFoldState === 'open') {
      foldHud();
    }
  });
}

function setPaletteOpen(open) {
  if (!palettePanel) return;
  paletteOpen = open;
  palettePanel.classList.toggle('is-open', open);
  if (paletteTabButton) {
    paletteTabButton.classList.toggle('is-active', open);
  }
  if (open && sfxOpen) {
    setSfxOpen(false);
  }
}

if (paletteTabButton) {
  paletteTabButton.addEventListener('click', () => {
    const nextState = !paletteOpen;
    setPaletteOpen(nextState);
    updateStatus(nextState ? 'パレット表示' : 'パレット収納');
  });
}

function setSfxOpen(open) {
  if (!sfxPanel) return;
  sfxOpen = open;
  sfxPanel.classList.toggle('is-open', open);
  if (sfxTabButton) {
    sfxTabButton.classList.toggle('is-active', open);
  }
  if (open && paletteOpen) {
    setPaletteOpen(false);
  }
}

if (sfxTabButton) {
  sfxTabButton.addEventListener('click', () => {
    const nextState = !sfxOpen;
    setSfxOpen(nextState);
    updateStatus(nextState ? 'サウンド設定表示' : 'サウンド設定収納');
  });
}

document.addEventListener('pointerdown', (event) => {
  const target = event.target;
  const paletteActive = palettePanel && (palettePanel.contains(target) || (paletteTabButton && paletteTabButton.contains(target)));
  const sfxActive = sfxPanel && (sfxPanel.contains(target) || (sfxTabButton && sfxTabButton.contains(target)));
  const hudActive = (hudEl && hudEl.contains(target))
    || (palettePanel && palettePanel.contains(target))
    || (sfxPanel && sfxPanel.contains(target))
    || (hudTabButton && hudTabButton.contains(target))
    || (foldToggleBtn && foldToggleBtn.contains(target))
    || (paletteTabButton && paletteTabButton.contains(target))
    || (sfxTabButton && sfxTabButton.contains(target));
  if (paletteOpen && !paletteActive) {
    setPaletteOpen(false);
  }
  if (sfxOpen && !sfxActive) {
    setSfxOpen(false);
  }
  if (hudFoldState === 'open' && !hudActive) {
    foldHud();
  }
});

if (renderer.domElement) {
  const closeFloatingPanels = () => {
    if (hudFoldState === 'open') foldHud();
    if (paletteOpen) setPaletteOpen(false);
    if (sfxOpen) setSfxOpen(false);
  };
  renderer.domElement.addEventListener('pointerdown', closeFloatingPanels);
  renderer.domElement.addEventListener('mousedown', closeFloatingPanels);
  renderer.domElement.addEventListener('touchstart', closeFloatingPanels, { passive: true });
}

if (buildVolumeSlider) {
  const applyBuildVolume = (value) => {
    const normalized = Number.isFinite(value) ? value / 100 : 1;
    soundGains.build = Math.max(0, Math.min(1, normalized));
  };
  applyBuildVolume(parseInt(buildVolumeSlider.value, 10));
  buildVolumeSlider.addEventListener('input', (event) => {
    applyBuildVolume(parseInt(event.target.value, 10));
    updateStatus('ビルド音量調整');
  });
}

if (movementVolumeSlider) {
  const applyMovementVolume = (value) => {
    const normalized = Number.isFinite(value) ? value / 100 : 0.7;
    soundGains.movement = Math.max(0, Math.min(1, normalized));
  };
  applyMovementVolume(parseInt(movementVolumeSlider.value, 10));
  movementVolumeSlider.addEventListener('input', (event) => {
    applyMovementVolume(parseInt(event.target.value, 10));
    updateStatus('移動音量調整');
  });
}

if (structureNameInput) {
  structureNameInput.addEventListener('input', (event) => {
    structureName = event.target.value.trim() || `スロット${currentSlot}`;
    structureNames.set(currentSlot, structureName);
    updateStatus(`構造名を更新: ${structureName}`);
  });
}

if (cameraFovInput) {
  const applyFov = (value) => {
    const fov = Math.max(30, Math.min(120, parseInt(value, 10) || camera.fov));
    camera.fov = fov;
    camera.updateProjectionMatrix();
  };
  applyFov(cameraFovInput.value);
  cameraFovInput.addEventListener('input', (event) => {
    applyFov(event.target.value);
    updateStatus('視野角を調整');
  });
}

if (cameraSpeedInput) {
  const applySpeed = (value) => {
    baseMoveSpeed = Math.max(2, Math.min(30, parseFloat(value) || baseMoveSpeed));
  };
  applySpeed(cameraSpeedInput.value);
  cameraSpeedInput.addEventListener('input', (event) => {
    applySpeed(event.target.value);
    updateStatus('移動速度を調整');
  });
}

if (gridToggle) {
  gridToggle.checked = grid.visible;
  gridToggle.addEventListener('change', (event) => {
    grid.visible = !!event.target.checked;
  });
}

if (crosshairToggle && crosshairEl) {
  crosshairToggle.checked = crosshairEl.style.display !== 'none';
  crosshairToggle.addEventListener('change', (event) => {
    crosshairEl.style.display = event.target.checked ? '' : 'none';
  });
}

if (highlightToggle) {
  highlightEnabled = !!highlightToggle.checked;
  highlightToggle.addEventListener('change', (event) => {
    highlightEnabled = !!event.target.checked;
    applyHighlightMode();
    updateStatus(highlightEnabled ? 'ハイライト有効' : 'ハイライト無効');
  });
}

if (skyThemeSelect) {
  applySkyTheme(skyThemeSelect.value, { silent: true });
  skyThemeSelect.addEventListener('change', (event) => {
    applySkyTheme(event.target.value);
  });
}

if (resetCameraBtn) {
  resetCameraBtn.addEventListener('click', () => {
    camera.position.copy(defaultCameraPosition);
    yaw = defaultYaw;
    pitch = defaultPitch;
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    updateStatus('カメラをリセット');
  });
}

if (focusHighlightBtn) {
  focusHighlightBtn.addEventListener('click', () => {
    if (!lastPlacedPosition) {
      updateStatus('フォーカス対象がありません');
      return;
    }
    const offset = new THREE.Vector3(4, 5, 4);
    camera.position.copy(lastPlacedPosition).add(offset);
    camera.lookAt(lastPlacedPosition);
    const lookVec = new THREE.Vector3().subVectors(lastPlacedPosition, camera.position).normalize();
    yaw = Math.atan2(lookVec.x, lookVec.z);
    pitch = Math.asin(Math.max(-1, Math.min(1, lookVec.y)));
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    updateStatus('最新ブロックへ移動');
  });
}

if (colorWheelCanvas) {
  colorWheelCanvas.addEventListener('pointerdown', (event) => {
    ensureAudioContext();
    isWheelDragging = true;
    try { colorWheelCanvas.setPointerCapture(event.pointerId); } catch (err) { /* noop */ }
    handleWheelPointer(event);
  });
  colorWheelCanvas.addEventListener('pointermove', (event) => {
    if (!isWheelDragging) return;
    handleWheelPointer(event);
  });
  const stopWheelDrag = (event) => {
    if (event && event.pointerId !== undefined) {
      try { colorWheelCanvas.releasePointerCapture(event.pointerId); } catch (err) { /* noop */ }
    }
    isWheelDragging = false;
  };
  colorWheelCanvas.addEventListener('pointerup', stopWheelDrag);
  colorWheelCanvas.addEventListener('pointercancel', stopWheelDrag);
  colorWheelCanvas.addEventListener('pointerleave', () => { isWheelDragging = false; });
  window.addEventListener('pointerup', () => { isWheelDragging = false; });
}

if (colorSurfaceCanvas) {
  colorSurfaceCanvas.addEventListener('pointerdown', (event) => {
    ensureAudioContext();
    isSurfaceDragging = true;
    try { colorSurfaceCanvas.setPointerCapture(event.pointerId); } catch (err) { /* noop */ }
    handleSurfacePointer(event);
  });
  colorSurfaceCanvas.addEventListener('pointermove', (event) => {
    if (!isSurfaceDragging) return;
    handleSurfacePointer(event);
  });
  const stopSurfaceDrag = (event) => {
    if (event && event.pointerId !== undefined) {
      try { colorSurfaceCanvas.releasePointerCapture(event.pointerId); } catch (err) { /* noop */ }
    }
    isSurfaceDragging = false;
  };
  colorSurfaceCanvas.addEventListener('pointerup', stopSurfaceDrag);
  colorSurfaceCanvas.addEventListener('pointercancel', stopSurfaceDrag);
  colorSurfaceCanvas.addEventListener('pointerleave', () => { isSurfaceDragging = false; });
  window.addEventListener('pointerup', () => { isSurfaceDragging = false; });
}

function pickObject() {
  raycaster.setFromCamera(pointerCenter, camera);
  const blockMeshes = gatherMeshesForRay(raycaster.ray);
  const hits = raycaster.intersectObjects([basePlane, ...blockMeshes], false);
  return hits.length > 0 ? hits[0] : null;
}

const raySamplesTemp = new THREE.Vector3();
function gatherMeshesForRay(ray, maxDistance = 150) {
  if (!blockSpatialIndex.size) {
    return Array.from(blocks.values(), (entry) => entry.mesh);
  }
  const chunkKeys = new Set();
  const meshes = new Set();
  const step = Math.max(BLOCK_SIZE * EDIT_CHUNK_SIZE * 0.5, BLOCK_SIZE);
  for (let dist = 0; dist <= maxDistance; dist += step) {
    raySamplesTemp.copy(ray.direction).multiplyScalar(dist).add(ray.origin);
    const key = chunkKeyFromWorld(raySamplesTemp);
    if (!chunkKeys.has(key)) {
      chunkKeys.add(key);
      const chunk = blockSpatialIndex.get(key);
      if (chunk) {
        chunk.forEach((mesh) => meshes.add(mesh));
      }
    }
  }
  if (!meshes.size) {
    return Array.from(blocks.values(), (entry) => entry.mesh);
  }
  return Array.from(meshes);
}

function addBlock(gridPos, colorHex, alpha = currentAlpha) {
  const clamped = clampGrid(gridPos);
  const key = gridKey(clamped.x, clamped.y, clamped.z);
  if (blocks.has(key)) return;

  const material = getOrCreateMaterial(colorHex, alpha);
  const mesh = new THREE.Mesh(boxGeometry, material);
  const worldPos = gridToWorld(clamped);
  mesh.position.copy(worldPos);
  mesh.userData.isBlock = true;
  scene.add(mesh);

  const chunkKey = chunkKeyFromGrid(clamped);
  let chunk = blockSpatialIndex.get(chunkKey);
  if (!chunk) {
    chunk = new Map();
    blockSpatialIndex.set(chunkKey, chunk);
  }
  chunk.set(key, mesh);

  blocks.set(key, { grid: clamped, color: colorHex, alpha, mesh, chunkKey });
  rememberColor(colorHex, alpha);
  spawnPlacementSphere(worldPos, colorHex, alpha);
  playSound(placeBuffer, 0.42, 'build');
  lastPlacedPosition = worldPos.clone();
  updateBlockInsights();
  updateStatus('設置完了');
}

function removeBlock(gridPos) {
  const key = gridKey(gridPos.x, gridPos.y, gridPos.z);
  const entry = blocks.get(key);
  if (!entry) return;
  scene.remove(entry.mesh);
  spawnRemovalBurst(entry.mesh.position.clone());
  blocks.delete(key);
  if (entry.chunkKey) {
    const chunk = blockSpatialIndex.get(entry.chunkKey);
    if (chunk) {
      chunk.delete(key);
      if (!chunk.size) blockSpatialIndex.delete(entry.chunkKey);
    }
  }
  playSound(removeBuffer, 0.38, 'build');
  updateBlockInsights();
  updateStatus('削除しました');
}

function clearBlocks() {
  blocks.forEach(({ mesh }) => {
    spawnRemovalBurst(mesh.position.clone());
    scene.remove(mesh);
  });
  blocks.clear();
  blockSpatialIndex.clear();
  updateBlockInsights();
  updateStatus('キャンバスをクリア');
  playSound(removeBuffer, 0.5, 'build');
}

function serializeStructure() {
  const slotId = currentSlotId();
  const slotNumber = parseInt(slotId, 10);
  return JSON.stringify({
    version: 2,
    name: structureName,
    slot: slotId,
    slotNumber: Number.isFinite(slotNumber) ? slotNumber : undefined,
    targetSlot: slotId,
    structureName,
    blockSize: BLOCK_SIZE,
    createdAt: new Date().toISOString(),
    scale: getStructureScale(),
    blocks: Array.from(blocks.values(), ({ grid, color, alpha }) => ({ x: grid.x, y: grid.y, z: grid.z, color, alpha }))
  }, null, 2);
}

async function downloadStructure() {
  if (blocks.size === 0) {
    updateStatus('ブロックがありません');
    return;
  }
  const data = serializeStructure();
  const rawName = structureName || `スロット${currentSlotId()}`;
  const safeName = rawName.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
  const defaultFilename = `${safeName}.json`;

  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: defaultFilename,
        types: [
          {
            description: 'JSON Structure',
            accept: { 'application/json': ['.json'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      updateStatus('データを保存しました');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        updateStatus('保存をキャンセルしました');
        return;
      }
      console.warn('[builder] showSaveFilePicker での保存に失敗しました', err);
    }
  }

  const blob = new Blob([data], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = defaultFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
  updateStatus('データを保存しました');
}

function importStructure(data) {
  if (!data || !Array.isArray(data.blocks)) {
    updateStatus('読み込み失敗');
    return;
  }
  clearBlocks();
  (data.blocks || []).forEach((entry) => {
    if (typeof entry.x !== 'number' || typeof entry.y !== 'number' || typeof entry.z !== 'number') return;
    const color = isHexColor(entry.color) ? entry.color : '#ffffff';
    const alpha = typeof entry.alpha === 'number' ? Math.max(0, Math.min(1, entry.alpha)) : 1;
    addBlock({ x: entry.x, y: entry.y, z: entry.z }, color, alpha);
  });
  if (typeof data.slotNumber === 'number' && Number.isFinite(slotNum)) {
    const slotNum = Math.min(Math.max(Math.round(data.slotNumber), 1), 9);
    structureSlotSelect.value = String(slotNum);
  } else if (typeof data.slot === 'string') {
    const slotMatch = data.slot.match(/([1-9])/);
    if (slotMatch) structureSlotSelect.value = slotMatch[1];
  } else if (typeof data.targetSlot === 'string') {
    const slotMatch = data.targetSlot.match(/([1-9])/);
    if (slotMatch) structureSlotSelect.value = slotMatch[1];
  } else if (typeof data.name === 'string') {
    const match = data.name.match(/([1-9])/);
    if (match) structureSlotSelect.value = match[1];
  }
  currentSlot = structureSlotSelect.value;
  const importedName = typeof data.structureName === 'string' ? data.structureName : (typeof data.name === 'string' ? data.name : null);
  if (importedName) {
    structureName = importedName;
    structureNames.set(currentSlot, structureName);
    if (structureNameInput) structureNameInput.value = structureName;
  } else {
    structureName = structureNames.get(currentSlot) || `Slot ${currentSlot}`;
    if (structureNameInput) structureNameInput.value = structureName;
  }
  structureNames.set(currentSlot, structureName);
  if (typeof data.scale === 'number' && Number.isFinite(data.scale) && data.scale > 0) {
    const clamped = Math.min(Math.max(data.scale, parseFloat(structureScaleInput.min) || 0.1), parseFloat(structureScaleInput.max) || 5);
    structureScaleInput.value = clamped;
    scaleRangeInput.value = clamped;
  }
  applyHighlightMode();
  updateBlockInsights();
  updateStatus('読み込み完了');
}

function handleFileSelection(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsedData = JSON.parse(reader.result);
      importStructure(parsedData);
    } catch (err) {
      console.error('JSON parsing error:', err);
      updateStatus(`JSONエラー: ${err.message}`);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function updateGhostPreview() {
  const hit = pickObject();
  if (!hit) {
    ghostMesh.visible = false;
    return;
  }

  const point = hit.point.clone();
  if (hit.object.userData.isBlock) {
    normalMatrix.getNormalMatrix(hit.object.matrixWorld);
    faceNormal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize();
    point.addScaledVector(faceNormal, BLOCK_SIZE * 0.51);
  }

  const gridPos = clampGrid(worldToGrid(point));
  const key = gridKey(gridPos.x, gridPos.y, gridPos.z);
  if (blocks.has(key)) {
    ghostMesh.visible = false;
    return;
  }

  const worldPos = gridToWorld(gridPos);
  ghostMesh.visible = true;
  ghostMesh.position.copy(worldPos);
}

function placeBlock() {
  const hit = pickObject();
  if (!hit) return;

  const point = hit.point.clone();
  if (hit.object.userData.isBlock) {
    normalMatrix.getNormalMatrix(hit.object.matrixWorld);
    faceNormal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize();
    point.addScaledVector(faceNormal, BLOCK_SIZE * 0.51);
  }

  const gridPos = clampGrid(worldToGrid(point));
  const colorHex = colorPicker.value || '#ffffff';
  addBlock(gridPos, colorHex);
}

function deleteBlock() {
  const hit = pickObject();
  if (!hit || !hit.object.userData.isBlock) return;
  removeBlock(meshToGrid(hit.object));
}

clearBtn.addEventListener('click', clearBlocks);
exportBtn.addEventListener('click', downloadStructure);
importBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFileSelection);

structureSlotSelect.addEventListener('change', () => {
  structureNames.set(currentSlot, structureName);
  currentSlot = structureSlotSelect.value;
  structureName = structureNames.get(currentSlot) || `スロット${currentSlot}`;
  if (structureNameInput) structureNameInput.value = structureName;
  updateStatus(`スロット切替: ${structureName}`);
});

function syncScaleInputs(value) {
  structureScaleInput.value = value;
  scaleRangeInput.value = value;
  updateStatus('スケール調整');
}

structureScaleInput.addEventListener('input', (event) => {
  const value = event.target.value;
  syncScaleInputs(value);
});

scaleRangeInput.addEventListener('input', (event) => {
  syncScaleInputs(event.target.value);
});

if (opacitySlider) {
  const applyOpacity = (value) => {
    setOpacity(Math.max(0, Math.min(1, value / 100)), { syncSlider: false });
  };
  opacitySlider.value = Math.round(currentAlpha * 100);
  opacitySlider.addEventListener('input', (event) => {
    applyOpacity(parseInt(event.target.value, 10));
    updateStatus('不透明度調整');
  });
}

function parseHexInputValue(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (value[0] !== '#') value = `#${value}`;
  if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return null;
  return value.toUpperCase();
}

function applyHexInput(value) {
  const parsed = parseHexInputValue(value);
  if (!parsed) return false;
  const hex = parsed.length === 9 ? parsed.slice(0, 7) : parsed;
  const alphaHex = parsed.length === 9 ? parsed.slice(7) : null;
  if (alphaHex) {
    const alpha = parseInt(alphaHex, 16) / 255;
    setOpacity(alpha);
  }
  setColorFromHex(hex, true);
  updateStatus(`HEX 設定: ${parsed}`);
  return true;
}

function applyRgbaInputs() {
  const r = Math.max(0, Math.min(255, parseInt(rgbaInputR.value, 10) || 0));
  const g = Math.max(0, Math.min(255, parseInt(rgbaInputG.value, 10) || 0));
  const b = Math.max(0, Math.min(255, parseInt(rgbaInputB.value, 10) || 0));
  const a = Math.max(0, Math.min(100, parseInt(rgbaInputA.value, 10) || 0));
  setOpacity(a / 100, { syncSlider: true });
  const hex = rgbToHex(r, g, b);
  setColorFromHex(hex, true);
  updateStatus('RGBAを調整');
}

function randomizeColor() {
  const hue = Math.random();
  const sat = 0.4 + Math.random() * 0.6;
  const val = 0.4 + Math.random() * 0.6;
  setOpacity(0.6 + Math.random() * 0.4);
  setColorFromHSV(hue, sat, val, { syncSlider: true });
  ensureAudioContext();
  playSound(placeBuffer, 0.18, 'build');
  updateStatus('ランダムカラー生成');
}

function adjustValue(delta) {
  const nextValue = Math.max(0.05, Math.min(1, currentValue + delta));
  setColorFromHSV(currentHue, currentSaturation, nextValue, { syncSlider: true });
  updateStatus(delta > 0 ? '色を明るく' : '色を暗く');
}

function toggleFavorite() {
  const current = { hex: colorPicker.value.toUpperCase(), alpha: currentAlpha };
  const index = pinnedColors.findIndex((entry) => colorsMatch(entry, current));
  if (index >= 0) {
    pinnedColors.splice(index, 1);
    updateStatus('お気に入りから削除');
  } else {
    pinnedColors.unshift(current);
    if (pinnedColors.length > 20) pinnedColors.pop();
    updateStatus('お気に入りに追加');
  }
  renderPinnedColors();
  savePinnedColors();
  updateFavoriteButtonState();
}

if (hexInput) {
  hexInput.addEventListener('change', () => {
    if (!applyHexInput(hexInput.value)) {
      updateStatus('HEX形式が正しくありません');
      hexInput.value = colorPicker.value;
    }
  });
}

if (copyHexBtn && navigator.clipboard) {
  copyHexBtn.addEventListener('click', async () => {
    const value = hexInput ? hexInput.value : colorPicker.value;
    try {
      await navigator.clipboard.writeText(value);
      copyHexBtn.textContent = 'コピーしました';
      setTimeout(() => { copyHexBtn.textContent = 'コピー'; }, 800);
      updateStatus('カラーをコピー');
    } catch (err) {
      updateStatus('コピーできませんでした');
    }
  });
}

if (randomColorBtn) {
  randomColorBtn.addEventListener('click', randomizeColor);
}

if (rgbaInputR && rgbaInputG && rgbaInputB && rgbaInputA) {
  [rgbaInputR, rgbaInputG, rgbaInputB, rgbaInputA].forEach((input) => {
    input.addEventListener('change', applyRgbaInputs);
    input.addEventListener('blur', applyRgbaInputs);
  });
}

if (favoriteToggleBtn) {
  favoriteToggleBtn.addEventListener('click', toggleFavorite);
}

if (lightenBtn) {
  lightenBtn.addEventListener('click', () => adjustValue(0.08));
}

if (darkenBtn) {
  darkenBtn.addEventListener('click', () => adjustValue(-0.08));
}

renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

const pointerLockTarget = renderer.domElement;

function requestPointerLock() {
  if (document.pointerLockElement === pointerLockTarget) return;
  if (pointerLockTarget.requestPointerLock) {
    pointerLockTarget.requestPointerLock();
  }
}

if (!isTouchDevice) {
pointerLockTarget.addEventListener('mousedown', (event) => {
  const locked = document.pointerLockElement === pointerLockTarget;
  if (!locked) return;
  if (event.button === 0) {
    placeBlock();
    } else if (event.button === 2) {
      deleteBlock();
    }
  });

  pointerLockTarget.addEventListener('click', requestPointerLock);
}

let pointerLocked = isTouchDevice;
const keys = new Set();
let yaw = 0;
let pitch = -0.35;
const lookSensitivity = 0.00225;
const maxPitch = Math.PI / 2 - 0.02;
const minPitch = -Math.PI / 2 + 0.02;
const defaultCameraPosition = camera.position.clone();
const defaultYaw = yaw;
const defaultPitch = pitch;

if (!isTouchDevice) {
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === pointerLockTarget;
    if (!pointerLocked) {
      keys.clear();
      ghostMesh.visible = false;
    } else {
      ensureAudioContext();
    }
  });

  document.addEventListener('mousemove', (event) => {
    if (!pointerLocked) return;
    yaw -= event.movementX * lookSensitivity;
    pitch -= event.movementY * lookSensitivity;
    pitch = Math.max(minPitch, Math.min(maxPitch, pitch));
  });
}

document.addEventListener('keydown', (event) => {
  if (/^Digit[1-9]$/.test(event.code)) {
    structureSlotSelect.value = event.code.replace('Digit', '');
    event.preventDefault();
    structureSlotSelect.dispatchEvent(new Event('change'));
    return;
  }
  const locked = isTouchDevice ? true : document.pointerLockElement === pointerLockTarget;
  if (!locked) return;
  keys.add(event.code);
  if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE'].includes(event.code)) {
    event.preventDefault();
  }
});

document.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});

function setupTouchControls() {
  if (!isTouchDevice) return;

  const resetMove = () => {
    touchMoveInput.x = 0;
    touchMoveInput.y = 0;
    touchMoveInput.strength = 0;
    movePointerId = null;
    if (builderMoveThumb) builderMoveThumb.style.transform = 'translate(0, 0)';
  };

  if (builderMoveStick) {
    const updateMove = (event) => {
      const rect = builderMoveStick.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      let dx = (event.clientX - centerX) / (rect.width / 2);
      let dy = (event.clientY - centerY) / (rect.height / 2);
      const length = Math.hypot(dx, dy);
      if (length > 1) {
        dx /= length;
        dy /= length;
      }
      touchMoveInput.x = dx;
      touchMoveInput.y = -dy;
      touchMoveInput.strength = Math.min(1, Math.hypot(dx, dy));
      if (builderMoveThumb) {
        const radius = rect.width / 2;
        builderMoveThumb.style.transform = `translate(${dx * radius * 0.45}px, ${dy * radius * 0.45}px)`;
      }
    };

    builderMoveStick.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      requestFullscreenIfNeeded();
      if (movePointerId !== null) return;
      movePointerId = event.pointerId;
      builderMoveStick.setPointerCapture(event.pointerId);
      updateMove(event);
      showTouchHint('move');
    });

    builderMoveStick.addEventListener('pointermove', (event) => {
      if (event.pointerId !== movePointerId) return;
      event.preventDefault();
      updateMove(event);
    });

    const stopMove = (event) => {
      if (event.pointerId !== movePointerId) return;
      event.preventDefault();
      resetMove();
    };

    builderMoveStick.addEventListener('pointerup', stopMove);
    builderMoveStick.addEventListener('pointercancel', stopMove);
    builderMoveStick.addEventListener('lostpointercapture', () => {
      resetMove();
    });
  }

  if (builderLookPad) {
    builderLookPad.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      requestFullscreenIfNeeded();
      if (touchLookState.pointerId !== null) return;
      touchLookState.pointerId = event.pointerId;
      touchLookState.lastX = event.clientX;
      touchLookState.lastY = event.clientY;
      builderLookPad.setPointerCapture(event.pointerId);
      showTouchHint('look');
    });

    builderLookPad.addEventListener('pointermove', (event) => {
      if (event.pointerId !== touchLookState.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - touchLookState.lastX;
      const dy = event.clientY - touchLookState.lastY;
      touchLookState.lastX = event.clientX;
      touchLookState.lastY = event.clientY;
      yaw -= dx * TOUCH_LOOK_SPEED;
      pitch -= dy * TOUCH_LOOK_SPEED;
      pitch = Math.max(minPitch, Math.min(maxPitch, pitch));
    });

    const stopLook = (event) => {
      if (event.pointerId !== touchLookState.pointerId) return;
      event.preventDefault();
      touchLookState.pointerId = null;
    };

    builderLookPad.addEventListener('pointerup', stopLook);
    builderLookPad.addEventListener('pointercancel', stopLook);
    builderLookPad.addEventListener('lostpointercapture', stopLook);
  }

  if (builderUpBtn) {
    builderUpBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      requestFullscreenIfNeeded();
      keys.add('Space');
    });
    const releaseUp = (event) => {
      event.preventDefault();
      keys.delete('Space');
    };
    builderUpBtn.addEventListener('pointerup', releaseUp);
    builderUpBtn.addEventListener('pointercancel', releaseUp);
    builderUpBtn.addEventListener('pointerleave', releaseUp);
  }

  if (builderDownBtn) {
    builderDownBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      requestFullscreenIfNeeded();
      keys.add('ShiftLeft');
    });
    const releaseDown = (event) => {
      event.preventDefault();
      keys.delete('ShiftLeft');
    };
    builderDownBtn.addEventListener('pointerup', releaseDown);
    builderDownBtn.addEventListener('pointercancel', releaseDown);
    builderDownBtn.addEventListener('pointerleave', releaseDown);
  }

  if (builderPlaceBtn) {
    builderPlaceBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      requestFullscreenIfNeeded();
      placeBlock();
      showTouchHint('place');
    });
  }

  if (builderRemoveBtn) {
    builderRemoveBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      requestFullscreenIfNeeded();
      deleteBlock();
    });
  }

  if (builderGameBtn) {
    builderGameBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      requestFullscreenIfNeeded();
      window.location.href = './index.html';
    });
  }
}

setupTouchControls();
const clock = new THREE.Clock();
const velocity = new THREE.Vector3();
const desiredVelocity = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
const targetVelocity = new THREE.Vector3();

function moveCamera(delta) {
  desiredVelocity.set(0, 0, 0);
  let keyboardActive = false;
  if (keys.has('KeyW')) { desiredVelocity.z += 1; keyboardActive = true; }
  if (keys.has('KeyS')) { desiredVelocity.z -= 1; keyboardActive = true; }
  if (keys.has('KeyA')) { desiredVelocity.x -= 1; keyboardActive = true; }
  if (keys.has('KeyD')) { desiredVelocity.x += 1; keyboardActive = true; }

  let analogStrength = 0;
  if (isTouchDevice && touchMoveInput.strength > 0.05) {
    desiredVelocity.z += touchMoveInput.y;
    desiredVelocity.x += touchMoveInput.x;
    analogStrength = touchMoveInput.strength;
  }

  const combinedLength = desiredVelocity.length();
  if (combinedLength > 1) {
    desiredVelocity.divideScalar(combinedLength);
  }
  const moveStrength = keyboardActive ? 1 : analogStrength;

  let vertical = 0;
  if (keys.has('Space')) vertical += 1;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) vertical -= 1;

  if (desiredVelocity.lengthSq() > 0) desiredVelocity.normalize();

  const baseSpeed = keys.has('KeyQ') ? baseMoveSpeed * 0.35 : keys.has('KeyE') ? baseMoveSpeed * 1.8 : baseMoveSpeed;
  forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.crossVectors(forward, worldUp).normalize();

  targetVelocity.set(0, 0, 0);
  const speedScale = moveStrength > 0 ? THREE.MathUtils.clamp(moveStrength, 0.35, 1) : 0;
  targetVelocity.addScaledVector(forward, desiredVelocity.z * baseSpeed * speedScale);
  targetVelocity.addScaledVector(right, desiredVelocity.x * baseSpeed * speedScale);
  targetVelocity.y = vertical * baseSpeed;

  velocity.lerp(targetVelocity, Math.min(1, delta * 8));
  camera.position.addScaledVector(velocity, delta);
  camera.position.y = Math.max(0.35, camera.position.y);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}

function animate() {
  const delta = clock.getDelta();
  moveCamera(delta);
  if (pointerLocked || isTouchDevice) updateGhostPreview();
  updateEffects(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

if (colorWheelCanvas) {
  drawColorWheel();
  setColorFromHex(colorPicker.value || '#F97316');
} else {
  updateGhostColor();
}

setPaletteOpen(false);
setSfxOpen(false);
loadPinnedColors();
rememberColor(colorPicker.value, currentAlpha);
if (scaleRangeInput) scaleRangeInput.value = structureScaleInput.value;
applyHighlightMode();
updateFavoriteButtonState();
updateBlockInsights();
if (structureNameInput) structureNameInput.value = structureName;
updateStatus();
updateHudToggleLabel();
animate();
