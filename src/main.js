/* global THREE, CANNON, gsap */

// Minimal prototype scaffold
const appEl = document.getElementById('app');
const lockBtn = document.getElementById('lockBtn');
const loadStructuresBtn = document.getElementById('loadStructuresBtn');
const structuresDirInput = document.getElementById('structuresDirInput');
const qualitySelect = document.getElementById('qualitySelect');
const shadowToggle = document.getElementById('shadowToggle');
const moveStick = document.getElementById('moveStick');
const moveStickThumb = document.getElementById('moveStickThumb');
const lookPad = document.getElementById('lookPad');
const jumpBtn = document.getElementById('jumpBtn');
const dashBtn = document.getElementById('dashBtn');
const actionBtn = document.getElementById('actionBtn');
const modeBtn = document.getElementById('modeBtn');
const altActionBtn = document.getElementById('altActionBtn');
const slotPrevBtn = document.getElementById('slotPrevBtn');
const slotNextBtn = document.getElementById('slotNextBtn');

const isTouchDevice = (typeof window !== 'undefined') && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
if (isTouchDevice) {
  document.body.classList.add('is-touch');
}

const QUALITY_PRESETS = {
  low: {
    renderScale: 0.65,
    pixelRatio: 0.9,
    shadows: false,
    targetShadows: false,
    shadowMapSize: 512,
    structureBatchSize: 30,
  },
  medium: {
    renderScale: 0.8,
    pixelRatio: 1,
    shadows: false,
    targetShadows: false,
    shadowMapSize: 768,
    structureBatchSize: 45,
  },
  high: {
    renderScale: 1,
    pixelRatio: 1,
    shadows: true,
    targetShadows: true,
    shadowMapSize: 1024,
    structureBatchSize: 75,
  },
};

const renderSettings = {
  quality: 'medium',
  renderScale: QUALITY_PRESETS.medium.renderScale,
  pixelRatio: QUALITY_PRESETS.medium.pixelRatio,
  shadows: QUALITY_PRESETS.medium.shadows,
  targetShadows: QUALITY_PRESETS.medium.targetShadows,
  shadowMapSize: QUALITY_PRESETS.medium.shadowMapSize,
  structureBatchSize: QUALITY_PRESETS.medium.structureBatchSize,
};

let dynamicScale = 1;
const DYNAMIC_SCALE_MIN = 0.45;
const DYNAMIC_SCALE_MAX = 1.12;
const TARGET_FRAME_MS = 16.7;
const FRAME_SAMPLE_COUNT = 60;
const frameTimes = [];
const spawnedTargets = [];
const spawnedStructures = [];
const structureBreakQueue = [];
let structureBreakHandle = 0;
const STRUCTURE_BREAK_BATCH_SIZE = 40;
const STRUCTURE_BREAK_TIME_BUDGET_MS = 4.2;
const queueFrame = typeof requestAnimationFrame === 'function'
  ? (cb) => requestAnimationFrame(cb)
  : (cb) => setTimeout(() => cb(performance.now()), 16);
const STRUCTURE_CHUNK_SIZE = 8;
const STRUCTURE_CHUNK_CULL_DISTANCE = 120;
const FRAGMENT_ACTIVE_DURATION = 6500;
const FRAGMENT_SLEEP_DISTANCE = 62;
const FRAGMENT_REMOVE_DISTANCE = 220;
const FRAGMENT_REMOVE_HEIGHT = 140;
const FRAGMENT_REMOVE_TIMEOUT = 3000;

const structureMaterialCache = new Map();
const chunkFrustum = new THREE.Frustum();
const chunkProjMatrix = new THREE.Matrix4();
const tempVec3 = new THREE.Vector3();

const touchMoveInput = { x: 0, y: 0, strength: 0 };
let movePointerId = null;
const touchLookState = { pointerId: null, lastX: 0, lastY: 0 };
const TOUCH_LOOK_SPEED = 0.0032;

function scheduleStructureBreakProcessing() {
  if (structureBreakHandle) return;
  structureBreakHandle = queueFrame(processStructureBreakQueue);
}

function clampImpulseVector(vec, maxMagnitude = 120) {
  if (!vec) return vec;
  const length = vec.length?.() ?? Math.sqrt((vec.x || 0) ** 2 + (vec.y || 0) ** 2 + (vec.z || 0) ** 2);
  if (!Number.isFinite(length) || length <= maxMagnitude || length <= 0) return vec;
  const factor = maxMagnitude / length;
  if (typeof vec.scale === 'function') {
    vec.scale(factor, vec);
  } else {
    vec.x *= factor;
    vec.y *= factor;
    vec.z *= factor;
  }
  return vec;
}

function applyImpulseClamped(body, impulseVec, point = null, maxMagnitude = 120) {
  if (!body || !impulseVec) return;
  const impulse = impulseVec.clone?.() || new CANNON.Vec3(impulseVec.x || 0, impulseVec.y || 0, impulseVec.z || 0);
  clampImpulseVector(impulse, maxMagnitude);
  try {
    body.applyImpulse(impulse, point || body.position);
  } catch (err) {
    console.warn('[impulse] Failed to apply clamped impulse', err);
  }
}

function scheduleImpulse(body, impulseVec, point = null, delayMs = 0) {
  if (!body || !impulseVec) return;
  const apply = () => {
    if (!body.world) return;
    try {
      const impulse = impulseVec.clone?.() || new CANNON.Vec3(impulseVec.x || 0, impulseVec.y || 0, impulseVec.z || 0);
      clampImpulseVector(impulse);
      body.applyImpulse(impulse, point || body.position);
    } catch (err) {
      console.warn('[impulse] Failed to apply impulse', err);
    }
  };
  const clampedDelay = Math.max(0, Math.min(delayMs || 0, 50));
  if (clampedDelay > 1) {
    setTimeout(apply, clampedDelay);
  } else {
    apply();
  }
}

function setDynamicScale(value) {
  const clamped = THREE.MathUtils.clamp(value, DYNAMIC_SCALE_MIN, DYNAMIC_SCALE_MAX);
  if (Math.abs(clamped - dynamicScale) > 0.01) {
    dynamicScale = clamped;
    updateRendererSize();
  } else {
    dynamicScale = clamped;
  }
}

function resetDynamicScale() {
  dynamicScale = 1;
  updateRendererSize();
}

function recordFrameTime(ms) {
  frameTimes.push(ms);
  if (frameTimes.length > FRAME_SAMPLE_COUNT) frameTimes.shift();
  if (frameTimes.length === FRAME_SAMPLE_COUNT) adjustDynamicResolution();
}

function adjustDynamicResolution() {
  const avg = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
  const upper = TARGET_FRAME_MS * 1.12;
  const lower = TARGET_FRAME_MS * 0.65;
  if (avg > upper) {
    setDynamicScale(dynamicScale * 0.92);
  } else if (avg < lower && getEffectiveRenderScale() < 1.08) {
    setDynamicScale(dynamicScale * 1.04);
  }
}

function applyMeshShadow(mesh, { cast = true, receive = false } = {}) {
  if (!mesh) return;
  const allowShadows = !!renderSettings.shadows;
  mesh.castShadow = allowShadows && !!cast;
  mesh.receiveShadow = allowShadows && !!receive;
}

const textureLoader = new THREE.TextureLoader();
function loadTexture(path) {
  const data = (typeof window !== 'undefined' && window.ASSET_IMAGES_BASE64 && window.ASSET_IMAGES_BASE64[path]) || path;
  const tex = textureLoader.load(data);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const raftTextures = {
  idle: loadTexture('assets/player.png'),
  run: [loadTexture('assets/player-run1.png'), loadTexture('assets/player-run2.png')],
  jump: [loadTexture('assets/player-jump1.png'), loadTexture('assets/player-jump2.png')],
};

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
// Adaptive resolution targeting HD quality
function getEffectiveRenderScale() {
  const qualityScale = THREE.MathUtils.clamp(renderSettings.renderScale || 1, 0.4, 1.15);
  return THREE.MathUtils.clamp(qualityScale * dynamicScale, DYNAMIC_SCALE_MIN, DYNAMIC_SCALE_MAX);
}

function updateRendererSize() {
  const targetH = 1080;
  const baseScale = Math.min(1, targetH / window.innerHeight);
  const effectiveScale = Math.min(1.1, baseScale * getEffectiveRenderScale());
  const w = Math.floor(window.innerWidth * effectiveScale);
  const h = Math.floor(window.innerHeight * effectiveScale);
  renderer.setPixelRatio(renderSettings.pixelRatio || 1);
  renderer.setSize(w, h, false);
}
updateRendererSize();
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = !!renderSettings.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
appEl.appendChild(renderer.domElement);
// Upscale canvas to fill window while keeping internal buffer resolution
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';

// Scene
const scene = new THREE.Scene();
// Light sky background
scene.background = new THREE.Color(0xbfd1e5);

// Camera rig (for head/camera + hands)
const playerRig = new THREE.Object3D();
playerRig.position.set(0, 1.7, 4);
scene.add(playerRig);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
playerRig.add(camera);

// Lights
const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6b8aa6, 0.7);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 0.7);
dir.position.set(5, 8, 5);
dir.castShadow = true;
dir.shadow.mapSize.set(1024, 1024);
scene.add(dir);

// Ground mesh
const groundGeo = new THREE.PlaneGeometry(200, 200);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x22cc44, roughness: 1, metalness: 0 });
const groundMesh = new THREE.Mesh(groundGeo, groundMat);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

// Physics world
const DEFAULT_GRAVITY = { x: 0, y: -9.82, z: 0 };
const world = new CANNON.World({ gravity: new CANNON.Vec3(DEFAULT_GRAVITY.x, DEFAULT_GRAVITY.y, DEFAULT_GRAVITY.z) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;

function setWorldGravity(x, y, z) {
  world.gravity.set(x, y, z);
}

function restoreDefaultGravity() {
  setWorldGravity(DEFAULT_GRAVITY.x, DEFAULT_GRAVITY.y, DEFAULT_GRAVITY.z);
  antiGravityActive = false;
}

function setBodyTag(body, info) {
  if (!body) return;
  body.userData = Object.assign({}, info);
}

function registerSpawnedTarget(mesh, body, extras = {}) {
  const record = { mesh, body };
  if (extras.lod) {
    record.lod = extras.lod;
  } else {
    const lod = setupTargetLOD(mesh, extras.lodOptions || {});
    if (lod) record.lod = lod;
  }
  if (extras.metadata && typeof extras.metadata === 'object') {
    record.metadata = Object.assign({}, extras.metadata);
  }
  spawnedTargets.push(record);

  let tag = null;
  if (extras.bodyTag && typeof extras.bodyTag === 'object') {
    tag = Object.assign({}, extras.bodyTag);
    if (!('ref' in tag)) tag.ref = record;
  } else {
    const kind = extras.kind || 'target';
    const ref = extras.bodyRef || record;
    tag = { kind, ref };
  }

  record.kind = tag.kind;
  setBodyTag(body, tag);
  return record;
}

function handleRaftHitBody(body) {
  if (!body || !body.userData) return;
  if (body.userData.kind === 'raft') {
    const raft = body.userData.ref;
    if (!raft) return;
    const now = performance.now();
    if (now - (raft.lastHit || 0) < 200) return;
    raft.lastHit = now;
    raft.stateTimer = 400;
    setRaftTexture(raft, 'attack');
  }
}

function setRaftTexture(raft, state) {
  if (raft.state === state && state !== 'attack') return;
  raft.state = state;
  raft.animFrame = 0;
  raft.animTimer = 0;
  let texture = raftTextures.idle;
  if (state === 'run') {
    texture = raftTextures.run[0];
  } else if (state === 'attack') {
    texture = raftTextures.jump[0];
  }
  raft.mesh.material.map = texture;
  raft.mesh.material.needsUpdate = true;
}

function updateRaftAnimation(raft, dt) {
  const state = raft.state || 'idle';
  raft.animTimer += dt * 1000;
  const frames = state === 'run' ? raftTextures.run : state === 'attack' ? raftTextures.jump : [raftTextures.idle];
  const interval = state === 'run' ? 160 : state === 'attack' ? 180 : 500;
  if (frames.length > 1 && raft.animTimer >= interval) {
    raft.animTimer = 0;
    raft.animFrame = (raft.animFrame + 1) % frames.length;
    raft.mesh.material.map = frames[raft.animFrame];
    raft.mesh.material.needsUpdate = true;
  }
}

// Materials
const groundPhysicsMaterial = new CANNON.Material('ground');
const fistPhysicsMaterial = new CANNON.Material('fist');
const bustPhysicsMaterial = new CANNON.Material('bust');
// Collision groups
const COLLISION_GROUPS = { GROUND: 1, PLAYER: 2, FIST: 4, TARGET: 8 };

world.addContactMaterial(new CANNON.ContactMaterial(groundPhysicsMaterial, bustPhysicsMaterial, {
  friction: 0.4,
  restitution: 0.2,
}));
world.addContactMaterial(new CANNON.ContactMaterial(fistPhysicsMaterial, bustPhysicsMaterial, {
  friction: 0.2,
  restitution: 0.05,
}));

// Ground body
const groundBody = new CANNON.Body({
  mass: 0,
  shape: new CANNON.Plane(),
  material: groundPhysicsMaterial,
});
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
groundBody.collisionFilterGroup = COLLISION_GROUPS.GROUND;
groundBody.collisionFilterMask = 0xFFFF;
world.addBody(groundBody);

// Target on a pole with spring-like recovery
const bustParams = { hardness: 0.6, mass: 8, durability: 100 };
const boxSize = { x: 0.6, y: 0.6, z: 0.6 };
const poleHeight = 0.9;
const poleRadius = 0.04;
const targetMat = new THREE.MeshStandardMaterial({ color: 0xb39ddb, roughness: 0.6, metalness: 0.05 });
// Pole visual (bending tube rebuilt each frame)
let poleMesh = new THREE.Mesh(new THREE.CylinderGeometry(poleRadius, poleRadius, 1, 8), new THREE.MeshStandardMaterial({ color: 0x444b52, roughness: 0.9 }));
poleMesh.visible = true;
scene.add(poleMesh);
// スロットシステム
let selectedSlotIndex = 0;
const slotsContainer = document.getElementById('slotsContainer');

// 武器・ツールタイプの定義
const primaryWeaponSlots = [
  { name: 'fist', attackIcon: '👊', spawnIcon: '⬜', type: 'weapon', action: 'punch' },
  { name: 'sword', attackIcon: '⚔️', spawnIcon: '🔺', type: 'weapon', action: 'slash' },
  { name: 'bow', attackIcon: '🏹', spawnIcon: '⚪', type: 'weapon', action: 'shoot' },
  { name: 'bomb', attackIcon: '💣', spawnIcon: '🔵', type: 'weapon', action: 'throw' },
  { name: 'spear', attackIcon: '🔱', spawnIcon: '🔸', type: 'weapon', action: 'stab' },
  { name: 'gravity', attackIcon: '⚫', spawnIcon: '🍩', type: 'tool', action: 'gravity' },
  { name: 'megaphone', attackIcon: '📢', spawnIcon: '💎', type: 'tool', action: 'blast' },
  { name: 'magnet', attackIcon: '🧲', spawnIcon: '🔷', type: 'tool', action: 'magnet' },
  { name: 'creative', attackIcon: '✨', spawnIcon: '⚽', type: 'tool', action: 'fly' }
];

const primarySpawnSlots = [
  { name: 'cube', spawnIcon: '⬜', spawnFn: spawnCubeTarget },
  { name: 'pyramid', spawnIcon: '🔺', spawnFn: spawnPyramidTarget },
  { name: 'sphere', spawnIcon: '⚪', spawnFn: spawnSphereTarget },
  { name: 'cylinder', spawnIcon: '🔘', spawnFn: spawnCylinderTarget },
  { name: 'cone', spawnIcon: '🔻', spawnFn: spawnConeTarget },
  { name: 'torus', spawnIcon: '🍩', spawnFn: spawnTorusTarget },
  { name: 'octahedron', spawnIcon: '💎', spawnFn: spawnOctahedronTarget },
  { name: 'tetrahedron', spawnIcon: '🔶', spawnFn: spawnTetrahedronTarget },
  { name: 'dodecahedron', spawnIcon: '🔷', spawnFn: spawnDodecahedronTarget },
];

const secondarySpawnSlots = [
  { name: 'prism', spawnIcon: '🔻', spawnFn: spawnPrismTarget },
  { name: 'icosahedron', spawnIcon: '💠', spawnFn: spawnIcosahedronTarget },
  { name: 'capsule', spawnIcon: '🧋', spawnFn: spawnCapsuleTarget },
  { name: 'torusKnot', spawnIcon: '🪢', spawnFn: spawnTorusKnotTarget },
  { name: 'twinOrb', spawnIcon: '🔮', spawnFn: spawnTwinOrbTarget },
  { name: 'ringStack', spawnIcon: '🌀', spawnFn: spawnRingStackTarget },
  { name: 'cross', spawnIcon: '✖️', spawnFn: spawnCrossTarget },
  { name: 'disk', spawnIcon: '💿', spawnFn: spawnDiskTarget },
  { name: 'cluster', spawnIcon: '🧱', spawnFn: spawnClusterTarget },
];

const spawnPages = [primarySpawnSlots, secondarySpawnSlots];
let spawnPage = 0;

const structureDataCache = new Map();
const IS_FILE_PROTOCOL = typeof window !== 'undefined' && window.location && window.location.protocol === 'file:';
let fist = null;
const STORED_STRUCTURES_KEY = 'iza-tako-structures-v1';

function loadStoredStructureState() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORED_STRUCTURES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

let storedStructureState = loadStoredStructureState();

function saveStoredStructureState() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORED_STRUCTURES_KEY, JSON.stringify(storedStructureState));
  } catch (_) {}
}

function rememberStructureSlot(slot, data, { sourceName = '', sourceType = 'local' } = {}) {
  if (!slot || !slot.id || !data) return;
  storedStructureState[slot.id] = {
    data: cloneStructureData(data),
    sourceName: sourceName || slot.activeFilename || slot.id,
    sourceType,
    savedAt: Date.now(),
  };
  saveStoredStructureState();
}

function getStructureMaterial(colorHex, alpha = 1, { doubleSided = false } = {}) {
  const key = `${colorHex}|${alpha.toFixed(3)}|${doubleSided ? 1 : 0}`;
  if (structureMaterialCache.has(key)) return structureMaterialCache.get(key);
  const material = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.55,
    metalness: 0.05,
    transparent: alpha < 0.999,
    opacity: alpha,
    depthWrite: alpha >= 0.999,
    side: doubleSided || alpha < 0.999 ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (alpha < 0.999) material.depthWrite = false;
  material.userData.reusable = true;
  structureMaterialCache.set(key, material);
  return material;
}

function hydrateSlotFromStored(slot) {
  if (!slot || !slot.id) return;
  const stored = storedStructureState[slot.id];
  if (!stored || !stored.data) return;
  slot.localData = cloneStructureData(stored.data);
  slot.localFilename = stored.sourceName || slot.id;
  slot.data = cloneStructureData(stored.data);
  slot.activeFilename = stored.sourceName || slot.id;
  slot.loading = false;
}

function applyStoredStructuresToSlots(slots) {
  if (!Array.isArray(slots)) return;
  slots.forEach((slot) => hydrateSlotFromStored(slot));
}

const BUILTIN_STRUCTURES = {
  '1': {
    name: 'Column',
    blockSize: 1,
    blocks: Array.from({ length: 4 }, (_, y) => ({ x: 0, y, z: 0, color: '#5c6bc0' })),
  },
  '2': {
    name: 'Arch',
    blockSize: 1,
    blocks: [
      { x: -1, y: 0, z: 0, color: '#8bc34a' },
      { x: 0, y: 0, z: 0, color: '#8bc34a' },
      { x: 1, y: 0, z: 0, color: '#8bc34a' },
      { x: -1, y: 1, z: 0, color: '#cddc39' },
      { x: 1, y: 1, z: 0, color: '#cddc39' },
      { x: -1, y: 2, z: 0, color: '#ffeb3b' },
      { x: 0, y: 2, z: 0, color: '#ffeb3b' },
      { x: 1, y: 2, z: 0, color: '#ffeb3b' },
    ],
  },
  '3': {
    name: 'Pyramid',
    blockSize: 1,
    blocks: [
      { x: 0, y: 0, z: 0, color: '#ff7043' },
      { x: 1, y: 0, z: 0, color: '#ff7043' },
      { x: 0, y: 0, z: 1, color: '#ff7043' },
      { x: 1, y: 0, z: 1, color: '#ff7043' },
      { x: 0, y: 1, z: 0, color: '#ffa726' },
      { x: 1, y: 1, z: 0, color: '#ffa726' },
      { x: 0, y: 1, z: 1, color: '#ffa726' },
      { x: 1, y: 1, z: 1, color: '#ffa726' },
      { x: 0, y: 2, z: 0, color: '#ffcc80' },
      { x: 1, y: 2, z: 0, color: '#ffcc80' },
      { x: 0, y: 2, z: 1, color: '#ffcc80' },
      { x: 1, y: 2, z: 1, color: '#ffcc80' },
      { x: 0, y: 3, z: 0, color: '#ffe0b2' },
    ],
  },
  '4': {
    name: 'Wall',
    blockSize: 1,
    blocks: Array.from({ length: 3 }, (_, y) => [
      { x: -1, y, z: 0, color: '#90caf9' },
      { x: 0, y, z: 0, color: '#64b5f6' },
      { x: 1, y, z: 0, color: '#42a5f5' },
    ]).flat().concat([
      { x: -1, y: 1, z: 0, color: '#1e88e5' },
      { x: 0, y: 2, z: 0, color: '#1565c0' },
      { x: 1, y: 1, z: 0, color: '#1e88e5' },
    ]),
  },
  '5': {
    name: 'Bridge',
    blockSize: 1,
    blocks: [
      { x: -2, y: 0, z: 0, color: '#bcaaa4' },
      { x: -1, y: 0, z: 0, color: '#bcaaa4' },
      { x: 0, y: 0, z: 0, color: '#bcaaa4' },
      { x: 1, y: 0, z: 0, color: '#bcaaa4' },
      { x: 2, y: 0, z: 0, color: '#bcaaa4' },
      { x: -2, y: 1, z: 0, color: '#a1887f' },
      { x: 2, y: 1, z: 0, color: '#a1887f' },
      { x: -2, y: 2, z: 0, color: '#8d6e63' },
      { x: 2, y: 2, z: 0, color: '#8d6e63' },
      { x: -1, y: 1, z: 0, color: '#d7ccc8' },
      { x: 0, y: 1, z: 0, color: '#d7ccc8' },
      { x: 1, y: 1, z: 0, color: '#d7ccc8' },
    ],
  },
  '6': {
    name: 'Tree',
    blockSize: 1,
    blocks: [
      { x: 0, y: 0, z: 0, color: '#8d6e63' },
      { x: 0, y: 1, z: 0, color: '#8d6e63' },
      { x: 0, y: 2, z: 0, color: '#8d6e63' },
      { x: 0, y: 3, z: 0, color: '#4caf50' },
      { x: 1, y: 3, z: 0, color: '#66bb6a' },
      { x: -1, y: 3, z: 0, color: '#66bb6a' },
      { x: 0, y: 3, z: 1, color: '#66bb6a' },
      { x: 0, y: 3, z: -1, color: '#66bb6a' },
      { x: 0, y: 4, z: 0, color: '#81c784' },
    ],
  },
  '7': {
    name: 'Bench',
    blockSize: 1,
    blocks: [
      { x: -1, y: 0, z: 0, color: '#6d4c41' },
      { x: 1, y: 0, z: 0, color: '#6d4c41' },
      { x: -1, y: 1, z: 0, color: '#a1887f' },
      { x: 0, y: 1, z: 0, color: '#a1887f' },
      { x: 1, y: 1, z: 0, color: '#a1887f' },
      { x: -1, y: 2, z: 0, color: '#d7ccc8' },
      { x: 1, y: 2, z: 0, color: '#d7ccc8' },
    ],
  },
  '8': {
    name: 'PillarFrame',
    blockSize: 1,
    blocks: [
      { x: -1, y: 0, z: -1, color: '#b0bec5' },
      { x: -1, y: 1, z: -1, color: '#90a4ae' },
      { x: -1, y: 2, z: -1, color: '#78909c' },
      { x: 1, y: 0, z: -1, color: '#b0bec5' },
      { x: 1, y: 1, z: -1, color: '#90a4ae' },
      { x: 1, y: 2, z: -1, color: '#78909c' },
      { x: -1, y: 0, z: 1, color: '#b0bec5' },
      { x: -1, y: 1, z: 1, color: '#90a4ae' },
      { x: -1, y: 2, z: 1, color: '#78909c' },
      { x: 1, y: 0, z: 1, color: '#b0bec5' },
      { x: 1, y: 1, z: 1, color: '#90a4ae' },
      { x: 1, y: 2, z: 1, color: '#78909c' },
      { x: 0, y: 3, z: 0, color: '#eceff1' },
    ],
  },
  '9': {
    name: 'Pad',
    blockSize: 1,
    blocks: [
      { x: -1, y: 0, z: -1, color: '#ffb300' },
      { x: 0, y: 0, z: -1, color: '#ffca28' },
      { x: 1, y: 0, z: -1, color: '#ffd54f' },
      { x: -1, y: 0, z: 0, color: '#ffe082' },
      { x: 0, y: 0, z: 0, color: '#fff8e1' },
      { x: 1, y: 0, z: 0, color: '#ffe082' },
      { x: -1, y: 0, z: 1, color: '#ffd54f' },
      { x: 0, y: 0, z: 1, color: '#ffca28' },
      { x: 1, y: 0, z: 1, color: '#ffb300' },
      { x: 0, y: 1, z: 0, color: '#fff59d' },
    ],
  },
};

for (let i = 1; i <= 9; i++) {
  const key = String(i);
  if (BUILTIN_STRUCTURES[key]) {
    BUILTIN_STRUCTURES[`slot${i}`] = BUILTIN_STRUCTURES[key];
  }
}

if (qualitySelect) {
  qualitySelect.value = renderSettings.quality;
  qualitySelect.addEventListener('change', (event) => {
    updateQualitySetting(event.target.value);
  });
}

if (shadowToggle) {
  shadowToggle.checked = !!renderSettings.shadows;
  shadowToggle.addEventListener('change', () => {
    renderSettings.shadows = shadowToggle.checked;
    renderSettings.targetShadows = shadowToggle.checked;
    applyRenderSettings();
  });
}

function setDynamicScale(value) {
  const clamped = THREE.MathUtils.clamp(value, DYNAMIC_SCALE_MIN, DYNAMIC_SCALE_MAX);
  if (Math.abs(clamped - dynamicScale) > 0.01) {
    dynamicScale = clamped;
    updateRendererSize();
  } else {
    dynamicScale = clamped;
  }
}

function resetDynamicScale() {
  dynamicScale = 1;
  updateRendererSize();
}

function recordFrameTime(ms) {
  frameTimes.push(ms);
  if (frameTimes.length > FRAME_SAMPLE_COUNT) frameTimes.shift();
  if (frameTimes.length === FRAME_SAMPLE_COUNT) adjustDynamicResolution();
}

function adjustDynamicResolution() {
  const avg = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
  const upper = TARGET_FRAME_MS * 1.12;
  const lower = TARGET_FRAME_MS * 0.65;
  if (avg > upper) {
    setDynamicScale(dynamicScale * 0.92);
  } else if (avg < lower && getEffectiveRenderScale() < 1.08) {
    setDynamicScale(dynamicScale * 1.04);
  }
}

function applyRenderSettings() {
  renderer.shadowMap.enabled = !!renderSettings.shadows;
  const size = Math.max(256, renderSettings.shadowMapSize || 512);
  dir.castShadow = !!renderSettings.shadows;
  dir.shadow.mapSize.set(size, size);
  dir.shadow.needsUpdate = true;
  updateRendererSize();
  if (groundMesh) applyMeshShadow(groundMesh, { cast: false, receive: true });
  if (targetMesh) applyMeshShadow(targetMesh, { cast: renderSettings.targetShadows, receive: true });
  if (fist) applyMeshShadow(fist, { cast: renderSettings.targetShadows, receive: false });
  if (bucketCarry && bucketCarry.mesh) applyMeshShadow(bucketCarry.mesh, { cast: renderSettings.targetShadows, receive: false });
  spawnedTargets.forEach((entry) => {
    if (entry && entry.mesh) applyMeshShadow(entry.mesh, { cast: renderSettings.targetShadows, receive: false });
  });
  spawnedStructures.forEach((structure) => {
    if (!structure) return;
    if (structure.instanced) applyMeshShadow(structure.instanced, { cast: false, receive: true });
    if (structure.chunks && structure.chunks.length) {
      structure.chunks.forEach((chunk) => {
        if (!chunk || !chunk.instancedMeshes) return;
        chunk.instancedMeshes.forEach(({ mesh }) => {
          if (mesh) applyMeshShadow(mesh, { cast: false, receive: true });
        });
      });
    }
    if (!structure.parts) return;
    structure.parts.forEach((part) => {
      if (part && part.mesh) applyMeshShadow(part.mesh, { cast: renderSettings.targetShadows, receive: true });
    });
  });
}

function updateQualitySetting(value) {
  const preset = QUALITY_PRESETS[value] || QUALITY_PRESETS.medium;
  renderSettings.quality = value;
  renderSettings.renderScale = preset.renderScale;
  renderSettings.pixelRatio = preset.pixelRatio;
  renderSettings.shadowMapSize = preset.shadowMapSize;
  renderSettings.structureBatchSize = preset.structureBatchSize;

  const allowShadows = !!preset.shadows;
  if (shadowToggle) {
    shadowToggle.disabled = !allowShadows;
    if (!allowShadows) {
      shadowToggle.checked = false;
    }
  }

  const shadowsEnabled = allowShadows && (!shadowToggle || shadowToggle.checked);
  if (shadowToggle && allowShadows) {
    shadowToggle.checked = shadowsEnabled;
  }
  renderSettings.shadows = shadowsEnabled;
  renderSettings.targetShadows = shadowsEnabled && !!preset.targetShadows;

  resetDynamicScale();
  applyRenderSettings();
  if (typeof updateSlotAppearance === 'function') updateSlotAppearance();
}

const customStructureSlots = Array.from({ length: 9 }, (_, index) => {
  const slotNumber = index + 1;
  return {
    id: `slot${slotNumber}`,
    number: slotNumber,
    filenames: [`${slotNumber}`, `slot${slotNumber}`],
    data: null,
    activeFilename: null,
    loading: false,
    localData: null,
    localFilename: null,
  };
});

applyStoredStructuresToSlots(customStructureSlots);

const secondaryWeaponSlots = [
  { name: 'megaBomb', attackIcon: '🧨', type: 'weapon', action: 'megaBomb' },
  { name: 'superMagnet', attackIcon: '🌀', type: 'tool', action: 'superMagnet' },
  { name: 'shotgun', attackIcon: '🔫', type: 'weapon', action: 'shotgun' },
  { name: 'hammer', attackIcon: '🔨', type: 'weapon', action: 'hammer' },
  { name: 'trash', attackIcon: '🗑️', type: 'tool', action: 'trash' },
  { name: 'antiGravity', attackIcon: '🪐', type: 'tool', action: 'antiGravity' },
  { name: 'fingerSnap', attackIcon: '🫰', type: 'tool', action: 'fingerSnap' },
  { name: 'bucket', attackIcon: '🪣', type: 'tool', action: 'bucket' },
  { name: 'raft', attackIcon: '🐾', type: 'tool', action: 'raft' }
];

// 武器システムの状態
let currentWeapon = primaryWeaponSlots[0];
let arrows = []; // 矢の配列
let bombs = []; // 爆弾の配列
let antiGravityActive = false;
let bucketCarry = null;
const raftEntities = [];
const pellets = [];
let creativeMode = false;
let swordCutDirection = 'vertical'; // 剣の切り方: 'vertical' または 'horizontal'
const maxCuts = 3; // 最大切断回数
const originalTargetSize = { x: 1, y: 1, z: 1 }; // 元々のターゲットサイズ
const minTargetSize = 0.1; // 最小ターゲットサイズ（これより小さくならない）
const maxSplitCount = 5; // 最大分割回数（無制限分割を防ぐ）
const crosshairEl = document.getElementById('crosshair');

// ターゲットの分割回数を計算する関数
function calculateSplitCount(currentSize) {
  const volumeRatio = (originalTargetSize.x * originalTargetSize.y * originalTargetSize.z) / 
                     (currentSize.x * currentSize.y * currentSize.z);
  return Math.round(Math.log2(volumeRatio));
}

// ターゲットが分割可能かチェックする関数
function canSplitTarget(currentSize) {
  // 最小サイズより小さい場合は分割不可
  if (currentSize.x <= minTargetSize || currentSize.y <= minTargetSize || currentSize.z <= minTargetSize) {
    console.log('ターゲットが最小サイズに達しました。削除します。');
    return false;
  }
  
  // 分割回数が上限に達している場合は分割不可
  const splitCount = calculateSplitCount(currentSize);
  if (splitCount >= maxSplitCount) {
    console.log(`ターゲットの分割回数が上限(${maxSplitCount}回)に達しました。削除します。`);
    return false;
  }
  
  return true;
}

// モード管理
const modeSequence = ['attack', 'spawn', 'structure'];
let currentModeIndex = 0;
let currentMode = modeSequence[currentModeIndex]; // 'attack' | 'spawn' | 'structure'
let attackPage = 0; // 0: primary, 1: secondary

// 武器の3Dモデル
let currentWeaponMesh = null;

// スロットを作成
const slots = Array.from({ length: 9 }, (_, index) => {
  const slot = document.createElement('div');
  slot.classList.add('slot');
  slot.innerHTML = `<div class="object-icon">${primaryWeaponSlots[index].attackIcon}</div>`;
  slot.addEventListener('click', () => {
    selectSlot(index);
  });
  slotsContainer.appendChild(slot);
  return slot;
});

// スロット選択関数
function getAttackWeapon(index) {
  const list = attackPage === 0 ? primaryWeaponSlots : secondaryWeaponSlots;
  return list[index] || primaryWeaponSlots[index];
}

function getSpawnDefinition(index) {
  const page = spawnPages[spawnPage] || spawnPages[0];
  if (!page) return primarySpawnSlots[index] || primarySpawnSlots[0];
  return page[index] || page[0] || primarySpawnSlots[0];
}

function selectSlot(index) {
  selectedSlotIndex = Math.max(0, Math.min(index, primaryWeaponSlots.length - 1));

  if (currentMode === 'attack') {
    currentWeapon = getAttackWeapon(selectedSlotIndex);
    creativeMode = currentWeapon.action === 'fly';
  } else if (currentMode === 'spawn') {
    creativeMode = false;
  } else {
    const selectedWeapon = primaryWeaponSlots[selectedSlotIndex];
    if (selectedWeapon) {
      currentWeapon = selectedWeapon;
      creativeMode = selectedWeapon.action === 'fly';
    }
  }

  if (antiGravityActive && (!currentWeapon || currentWeapon.action !== 'antiGravity')) {
    restoreDefaultGravity();
  }

  slots.forEach((slot, i) => {
    slot.classList.toggle('selected', i === selectedSlotIndex);
  });

  if (currentMode === 'attack') {
    createWeaponMesh(currentWeapon.name);
  } else if (currentWeaponMesh) {
    handGroup.remove(currentWeaponMesh);
    currentWeaponMesh = null;
  }

  if (currentMode !== 'attack' && antiGravityActive) {
    restoreDefaultGravity();
  }

  updateSlotAppearance();
}

function selectSlotRelative(offset) {
  const total = slots.length;
  if (total === 0) return;
  const nextIndex = (selectedSlotIndex + offset + total) % total;
  selectSlot(nextIndex);
}

// スロットの見た目を更新
function updateSlotAppearance() {
  slots.forEach((slot, index) => {
    let icon = '⬜';
    let background = 'rgba(0, 0, 0, 0.6)';
    let title = '';

    if (currentMode === 'attack') {
      const weapon = getAttackWeapon(index);
      icon = weapon.attackIcon;
      background = 'rgba(0, 0, 0, 0.7)';
      title = `${weapon.name} (攻撃${attackPage === 0 ? '1' : '2'})`;
    } else if (currentMode === 'spawn') {
      const spawnDef = getSpawnDefinition(index);
      icon = spawnDef && spawnDef.spawnIcon ? spawnDef.spawnIcon : '⬜';
      background = spawnPage === 0 ? 'rgba(0, 100, 0, 0.7)' : 'rgba(0, 70, 140, 0.7)';
      const pageLabel = spawnPage === 0 ? '1' : '2';
      title = spawnDef ? `${spawnDef.name} (生成${pageLabel})` : `生成${pageLabel}`;
    } else {
      const structureSlot = customStructureSlots[index];
      const hasData = structureSlot && structureSlot.data;
      const isLoading = structureSlot && structureSlot.loading;
      icon = hasData ? '🟩' : isLoading ? '⏳' : '⬛';
      background = hasData ? 'rgba(120, 41, 169, 0.75)' : 'rgba(55, 20, 75, 0.45)';
      const slotLabel = structureSlot ? structureSlot.number : index + 1;
      const sourceHint = hasData ? structureSlot.activeFilename || structureSlot.number : structureSlot ? structureSlot.number : index + 1;
      if (hasData) {
        title = `${structureSlot.data.name || `構造 ${slotLabel}`} (structures/${sourceHint}.json)`;
      } else if (isLoading) {
        title = `スロット${slotLabel} 読み込み中…`;
      } else {
        title = `スロット${slotLabel} 未設定`;
      }
    }

    slot.innerHTML = `<div class="object-icon">${icon}</div>`;
    slot.style.background = background;
    if (title) slot.title = title;
    slot.classList.toggle('selected', index === selectedSlotIndex);
  });
}

// モード切り替え関数
function switchMode(mode) {
  const nextIndex = modeSequence.indexOf(mode);
  currentModeIndex = nextIndex >= 0 ? nextIndex : 0;
  currentMode = modeSequence[currentModeIndex];

  if (currentMode === 'attack') {
    currentWeapon = getAttackWeapon(selectedSlotIndex);
    creativeMode = currentWeapon.action === 'fly';
    createWeaponMesh(currentWeapon.name);
  } else if (currentMode === 'spawn') {
    spawnPage = Math.min(spawnPage, spawnPages.length - 1);
  } else if (currentWeaponMesh) {
    handGroup.remove(currentWeaponMesh);
    currentWeaponMesh = null;
  }

  if (currentMode === 'structure') {
    customStructureSlots.forEach((slot) => {
      if (!slot.data && !slot.loading) {
        loadStructureSlot(slot);
      }
    });
  }

  updateSlotAppearance();
}

function cycleMode(step = 1) {
  const nextIndex = (currentModeIndex + step + modeSequence.length) % modeSequence.length;
  switchMode(modeSequence[nextIndex]);
}

// 武器の3Dモデルを作成
function createWeaponMesh(weaponType) {
  // 既存の武器メッシュを削除
  if (currentWeaponMesh) {
    handGroup.remove(currentWeaponMesh);
  }
  
  let weaponMesh;
  
  switch (weaponType) {
    case 'fist':
      // パンチは既存の手を使用
      return null;
      
    case 'sword':
      // 剣を作成（直方体のみ）
      const swordGroup = new THREE.Group();
      
      // 剣身
      const bladeGeometry = new THREE.BoxGeometry(0.05, 0.02, 0.8);
      const bladeMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.2 });
      const blade = new THREE.Mesh(bladeGeometry, bladeMaterial);
      blade.position.y = 0;
      blade.position.z = -0.5;
      swordGroup.add(blade);
      
      // 柄
      const swordHandleGeometry = new THREE.BoxGeometry(0.04, 0.04, 0.5);
      const swordHandleMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 });
      const swordHandle = new THREE.Mesh(swordHandleGeometry, swordHandleMaterial);
      swordHandle.position.y = 0;
      swordGroup.add(swordHandle);
      
      // 鍔
      const guardGeometry = new THREE.BoxGeometry(0.4, 0.02, 0.05);
      const guardMaterial = new THREE.MeshStandardMaterial({ color: 0x666666 });
      const guard = new THREE.Mesh(guardGeometry, guardMaterial);
      guard.position.y = 0;
      guard.position.z = -0.2;
      swordGroup.add(guard);
      
      // 剣を奥に90度傾ける（刺すように）
      swordGroup.rotation.x = Math.PI / 2;
      
      weaponMesh = swordGroup;
      break;
      
    case 'bow':
      // 弓を作成（直方体のみ）
      const bowGroup = new THREE.Group();
      
      // 弓の本体（直方体で表現）
      const bowGeometry = new THREE.BoxGeometry(0.6, 0.04, 0.02);
      const bowMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 });
      const bow = new THREE.Mesh(bowGeometry, bowMaterial);
      bowGroup.add(bow);
      
      // 弦（細い直方体）
      const stringGeometry = new THREE.BoxGeometry(0.6, 0.002, 0.002);
      const stringMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
      const string = new THREE.Mesh(stringGeometry, stringMaterial);
      string.position.y = 0.1;
      bowGroup.add(string);
      
      // 弓をY軸で右に90度傾ける
      bowGroup.rotation.y = Math.PI / 2;
      
      weaponMesh = bowGroup;
      break;
      
    case 'spear':
      // 槍を作成（直方体のみ）
      const spearGroup = new THREE.Group();
      
      // 槍の穂先（細長い直方体）
      const spearHeadGeometry = new THREE.BoxGeometry(0.02, 0.15, 0.02);
      const spearHeadMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.2 });
      const spearHead = new THREE.Mesh(spearHeadGeometry, spearHeadMaterial);
      spearHead.position.y = 0.5;
      spearGroup.add(spearHead);
      
      // 槍の柄
      const spearShaftGeometry = new THREE.BoxGeometry(0.02, 0.8, 0.02);
      const spearShaftMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 });
      const spearShaft = new THREE.Mesh(spearShaftGeometry, spearShaftMaterial);
      spearShaft.position.y = 0.1;
      spearGroup.add(spearShaft);
      
      // 槍を奥に90度傾ける（剣と同じように）
      spearGroup.rotation.x = Math.PI / 2;
      
      weaponMesh = spearGroup;
      break;
      
    case 'bomb':
      // 爆弾を作成（直方体のみ）
      const bombGroup = new THREE.Group();
      
      // 爆弾本体（立方体）
      const bombGeometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
      const bombMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
      const bomb = new THREE.Mesh(bombGeometry, bombMaterial);
      bombGroup.add(bomb);
      
      // 導火線（細い直方体）
      const fuseGeometry = new THREE.BoxGeometry(0.01, 0.15, 0.01);
      const fuseMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 });
      const fuse = new THREE.Mesh(fuseGeometry, fuseMaterial);
      fuse.position.y = 0.15;
      bombGroup.add(fuse);
      
      weaponMesh = bombGroup;
      break;
      
    case 'megaphone':
      // 拡声器を作成（直方体のみ）
      const megaphoneGroup = new THREE.Group();
      
      // 拡声器の本体（台形のような直方体）
      const megaphoneGeometry = new THREE.BoxGeometry(0.3, 0.3, 0.15);
      const megaphoneMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
      const megaphone = new THREE.Mesh(megaphoneGeometry, megaphoneMaterial);
      megaphone.position.y = 0.15;
      megaphone.position.z = -0.2;
      megaphoneGroup.add(megaphone);
      
      // 持ち手
      const megaphoneHandleGeometry = new THREE.BoxGeometry(0.04, 0.2, 0.04);
      const megaphoneHandleMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
      const megaphoneHandle = new THREE.Mesh(megaphoneHandleGeometry, megaphoneHandleMaterial);
      megaphoneHandle.position.y = -0.1;
      megaphoneHandle.rotation.z = Math.PI / 4;
      megaphoneGroup.add(megaphoneHandle);
      
      // 拡声器を広がりが奥になるよう回転
      megaphoneGroup.rotation.x = Math.PI / 2;
      
      weaponMesh = megaphoneGroup;
      break;
      
    case 'magnet':
      // マグネットを作成（直方体のみ）
      const magnetGroup = new THREE.Group();
      
      // マグネット本体（U字型）
      const magnetBodyGeometry = new THREE.BoxGeometry(0.15, 0.1, 0.05);
      const magnetBodyMaterial = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8, roughness: 0.2 });
      const magnetBody = new THREE.Mesh(magnetBodyGeometry, magnetBodyMaterial);
      magnetGroup.add(magnetBody);
      
      // マグネットの極（N極）
      const northPoleGeometry = new THREE.BoxGeometry(0.05, 0.05, 0.05);
      const northPoleMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
      const northPole = new THREE.Mesh(northPoleGeometry, northPoleMaterial);
      northPole.position.x = 0.05;
      magnetGroup.add(northPole);
      
      // マグネットの極（S極）
      const southPoleGeometry = new THREE.BoxGeometry(0.05, 0.05, 0.05);
      const southPoleMaterial = new THREE.MeshStandardMaterial({ color: 0x0000ff });
      const southPole = new THREE.Mesh(southPoleGeometry, southPoleMaterial);
      southPole.position.x = -0.05;
      magnetGroup.add(southPole);
      
      // マグネットを奥に90度傾ける
      magnetGroup.rotation.x = Math.PI / 2;
      
      weaponMesh = magnetGroup;
      break;

    case 'megaBomb':
      const megaBombMesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0x440000 }));
      weaponMesh = megaBombMesh;
      break;

    case 'superMagnet':
      const superMagnet = new THREE.Group();
      const superBody = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.04, 8, 16), new THREE.MeshStandardMaterial({ color: 0x11aaff, metalness: 0.8, roughness: 0.2 }));
      superMagnet.add(superBody);
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x2299ff }));
      superMagnet.add(core);
      weaponMesh = superMagnet;
      break;

    case 'shotgun':
      const shotgun = new THREE.Group();
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.08), new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.6, roughness: 0.3 }));
      barrel.position.z = -0.15;
      shotgun.add(barrel);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 0.08), new THREE.MeshStandardMaterial({ color: 0x5c3a21 }));
      grip.position.set(0, -0.1, 0.05);
      shotgun.add(grip);
      weaponMesh = shotgun;
      break;

    case 'hammer':
      const hammer = new THREE.Group();
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.12), new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.4 }));
      head.position.z = -0.15;
      hammer.add(head);
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 12), new THREE.MeshStandardMaterial({ color: 0x7b3f00 }));
      handle.rotation.x = Math.PI / 2;
      handle.position.z = 0.05;
      hammer.add(handle);
      weaponMesh = hammer;
      break;

    case 'trash':
      const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.18, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.2 }));
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.02, 12), new THREE.MeshStandardMaterial({ color: 0x888888 }));
      lid.position.y = 0.1;
      const garbage = new THREE.Group();
      garbage.add(bin);
      garbage.add(lid);
      weaponMesh = garbage;
      break;

    case 'antiGravity':
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), new THREE.MeshStandardMaterial({ color: 0x00ccff, emissive: 0x113355 }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.02, 8, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x00aaff }));
      weaponMesh = new THREE.Group();
      weaponMesh.add(orb);
      ring.rotation.x = Math.PI / 2;
      weaponMesh.add(ring);
      break;

    case 'fingerSnap':
      const snap = new THREE.Group();
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.04), new THREE.MeshStandardMaterial({ color: 0xffd4a3 }));
      snap.add(palm);
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.04), new THREE.MeshStandardMaterial({ color: 0xffc499 }));
      finger.position.x = 0.05;
      finger.rotation.z = -Math.PI / 6;
      snap.add(finger);
      weaponMesh = snap;
      break;

    case 'bucket':
      const bucket = new THREE.Group();
      const bucketBody = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.16, 16), new THREE.MeshStandardMaterial({ color: 0x1e88e5, roughness: 0.5 }));
      bucket.add(bucketBody);
      const handleCurve = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.01, 8, 16, Math.PI), new THREE.MeshStandardMaterial({ color: 0xcccccc }));
      handleCurve.rotation.z = Math.PI / 2;
      handleCurve.position.y = 0.08;
      bucket.add(handleCurve);
      weaponMesh = bucket;
      break;

    case 'raft':
      const raft = new THREE.Group();
      const plank = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.6), new THREE.MeshStandardMaterial({ color: 0x8d5524 }));
      raft.add(plank);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0x5c3a21 }));
      mast.position.y = 0.2;
      raft.add(mast);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.18), new THREE.MeshStandardMaterial({ color: 0xfff176, side: THREE.DoubleSide }));
      flag.position.set(0.1, 0.25, 0);
      flag.rotation.y = Math.PI / 2;
      raft.add(flag);
      weaponMesh = raft;
      break;
      
    default:
      return null;
  }
  
  if (weaponMesh) {
    weaponMesh.position.set(0, 0, 0);
    weaponMesh.rotation.set(0, 0, 0);
    handGroup.add(weaponMesh);
    currentWeaponMesh = weaponMesh;
  }
  
  return weaponMesh;
}

function normalizeStructureData(slotRef, raw, sourceName = '') {
  if (!raw || !Array.isArray(raw.blocks) || !raw.blocks.length) return null;
  const blockSize = typeof raw.blockSize === 'number' && raw.blockSize > 0 ? raw.blockSize : 1;
  const scale = typeof raw.scale === 'number' && Number.isFinite(raw.scale) && raw.scale > 0 ? raw.scale : 1;
  const sanitized = [];
  const seen = new Set();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  let hasTranslucentBlocks = false;

  raw.blocks.forEach((block) => {
    const gx = Math.round(block.x);
    const gy = Math.round(block.y);
    const gz = Math.round(block.z);
    const key = `${gx},${gy},${gz}`;
    if (seen.has(key)) return;
    seen.add(key);

    let colorHex = '#ffffff';
    if (typeof block.color === 'string') {
      try {
        const c = new THREE.Color(block.color);
        colorHex = `#${c.getHexString()}`;
      } catch (_) {
        colorHex = '#ffffff';
      }
    }

    let alpha = 1;
    if (typeof block.alpha === 'number' && Number.isFinite(block.alpha)) {
      alpha = THREE.MathUtils.clamp(block.alpha, 0, 1);
    } else if (typeof block.opacity === 'number' && Number.isFinite(block.opacity)) {
      alpha = THREE.MathUtils.clamp(block.opacity, 0, 1);
    }
    if (alpha < 1) hasTranslucentBlocks = true;

    sanitized.push({ x: gx, y: gy, z: gz, color: colorHex, alpha });
    minX = Math.min(minX, gx);
    minY = Math.min(minY, gy);
    minZ = Math.min(minZ, gz);
    maxX = Math.max(maxX, gx);
    maxY = Math.max(maxY, gy);
    maxZ = Math.max(maxZ, gz);
  });

  if (!sanitized.length) return null;

  const scaledBlockSize = blockSize * scale;
  const width = (maxX - minX + 1) * scaledBlockSize;
  const depth = (maxZ - minZ + 1) * scaledBlockSize;
  const centerX = ((minX + maxX + 1) / 2) * scaledBlockSize;
  const centerZ = ((minZ + maxZ + 1) / 2) * scaledBlockSize;

  const slotId = slotRef.id;
  return {
    slot: slotId,
    name: typeof raw.name === 'string' ? raw.name : slotId,
    blockSize,
    scale,
    scaledBlockSize,
    blocks: sanitized,
    hasTranslucentBlocks,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    dimensions: { width, depth },
    center: { x: centerX, z: centerZ },
    sourceName: sourceName || raw.name || slotId,
  };
}

function cloneStructureData(data) {
  return data ? JSON.parse(JSON.stringify(data)) : null;
}

async function loadStructureSlot(slot) {
  const { id, filenames } = slot;
  if (slot.localData) {
    slot.data = cloneStructureData(slot.localData);
    slot.activeFilename = slot.localFilename;
    slot.loading = false;
    if (currentMode === 'structure') updateSlotAppearance();
    rememberStructureSlot(slot, slot.data, { sourceName: slot.localFilename || slot.id, sourceType: 'local-cache' });
    return true;
  }

  slot.data = null;
  slot.activeFilename = null;
  slot.loading = true;

  const candidateKeys = filenames.map((name) => name.toLowerCase());
  candidateKeys.push(id.toLowerCase());

  const tryBuiltinStructure = () => {
    for (let i = 0; i < candidateKeys.length; i++) {
      const key = candidateKeys[i];
      const builtin = BUILTIN_STRUCTURES[key];
      if (!builtin) continue;
      const normalized = normalizeStructureData(slot, builtin, key);
      if (!normalized) continue;
      const cacheKey = `builtin:${key}`;
      structureDataCache.set(cacheKey, cloneStructureData(normalized));
      slot.data = cloneStructureData(normalized);
      slot.activeFilename = key;
      slot.loading = false;
      if (currentMode === 'structure') updateSlotAppearance();
      console.info(`[structures] ${id}: 内蔵データ ${key} を読み込みました (${normalized.blocks.length} ブロック)`);
      rememberStructureSlot(slot, slot.data, { sourceName: key, sourceType: 'builtin' });
      return true;
    }
    return false;
  };

  if (IS_FILE_PROTOCOL) {
    for (let i = 0; i < candidateKeys.length; i++) {
      const key = candidateKeys[i];
      const cacheKey = `builtin:${key}`;
      if (structureDataCache.has(cacheKey)) {
        const cached = structureDataCache.get(cacheKey);
        slot.data = cloneStructureData(cached);
        slot.activeFilename = key;
        slot.loading = false;
        if (currentMode === 'structure') updateSlotAppearance();
        console.info(`[structures] ${id}: キャッシュされた内蔵データ ${key} を読み込みました`);
        rememberStructureSlot(slot, slot.data, { sourceName: key, sourceType: 'builtin-cache' });
        return true;
      }
    }
    if (tryBuiltinStructure()) return true;
  }

  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];
    const cacheKey = `remote:${filename.toLowerCase()}`;
    if (structureDataCache.has(cacheKey)) {
      const cached = structureDataCache.get(cacheKey);
      slot.data = cloneStructureData(cached);
      slot.activeFilename = filename;
      slot.loading = false;
      if (currentMode === 'structure') updateSlotAppearance();
      console.info(`[structures] ${id}: ${filename}.json をキャッシュから読み込みました (${cached.blocks.length} ブロック)`);
      rememberStructureSlot(slot, slot.data, { sourceName: filename, sourceType: 'remote-cache' });
      return true;
    }

    try {
      const json = await fetchStructureFile(filename);
      if (!json) continue;
      const normalized = normalizeStructureData(slot, json, filename);
      if (!normalized) {
        console.warn(`[structures] ${id}: データにブロックがありません (${filename}.json)`);
        continue;
      }
      structureDataCache.set(cacheKey, cloneStructureData(normalized));
      slot.data = cloneStructureData(normalized);
      slot.activeFilename = filename;
      slot.loading = false;
      if (currentMode === 'structure') updateSlotAppearance();
      console.info(`[structures] ${id}: ${filename}.json から ${normalized.blocks.length} ブロックを読み込みました`);
      rememberStructureSlot(slot, slot.data, { sourceName: filename, sourceType: 'remote' });
      return true;
    } catch (err) {
      console.warn(`[structures] ${id}: 読み込みに失敗しました (${filename}.json)`, err);
    }
  }

  if (IS_FILE_PROTOCOL && tryBuiltinStructure()) return true;
  console.info(`[structures] ${id}: 対応するファイルが見つかりませんでした (${filenames.map((f) => `${f}.json`).join(', ')})`);
  slot.loading = false;
  if (currentMode === 'structure') updateSlotAppearance();
  return false;
}

function structureSlotHint(slot) {
  if (!slot) return 'structures/1.json〜9.json';
  if (slot.activeFilename) return `structures/${slot.activeFilename}.json`;
  return slot.filenames.map((name) => `structures/${name}.json`).join(' / ');
}

function applyLocalStructure(slot, raw, filename) {
  const normalized = normalizeStructureData(slot, raw, filename);
  if (!normalized) return false;
  const cacheKey = `local:${filename || slot.id}`;
  structureDataCache.set(cacheKey, cloneStructureData(normalized));
  slot.localData = cloneStructureData(normalized);
  slot.localFilename = filename;
  slot.data = cloneStructureData(normalized);
  slot.activeFilename = filename;
  slot.loading = false;
  rememberStructureSlot(slot, slot.data, { sourceName: filename || slot.id, sourceType: 'local-file' });
  return true;
}

function inferSlotNumberFromData(data, filename = '') {
  if (data && typeof data === 'object') {
    const candidates = [data.slot, data.targetSlot, data.slotId, data.slotNumber];
    for (let i = 0; i < candidates.length; i++) {
      const value = candidates[i];
      if (typeof value === 'number' && Number.isFinite(value)) {
        const num = Math.round(value);
        if (num >= 1 && num <= 9) return num;
      }
      if (typeof value === 'string' && value) {
        const match = value.match(/([1-9])/);
        if (match) return parseInt(match[1], 10);
      }
    }
  }

  if (typeof filename === 'string' && filename) {
    const lower = filename.toLowerCase();
    const match = lower.match(/(?:slot)?([1-9])\.json$/);
    if (match) return parseInt(match[1], 10);
  }

  return null;
}

async function fetchStructureFile(filename) {
  if (!filename) return null;
  const url = `./structures/${filename}.json`;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (response.ok) {
      return await response.json();
    }
    if (response.status === 404) return null;
    console.warn(`[structures] fetch ${filename}.json failed with status ${response.status}`);
  } catch (err) {
    if (!IS_FILE_PROTOCOL) {
      console.warn(`[structures] fetch ${filename}.json failed`, err);
      return null;
    }
  }

  if (!IS_FILE_PROTOCOL) return null;

  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.overrideMimeType('application/json');
      xhr.responseType = 'text';
      xhr.onload = () => {
        if (xhr.status !== 0 && xhr.status !== 200) {
          resolve(null);
          return;
        }
        const text = typeof xhr.response === 'string' && xhr.response
          ? xhr.response
          : xhr.responseText;
        if (!text) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (parseErr) {
          console.warn(`[structures] JSON parse error for ${filename}.json`, parseErr);
          resolve(null);
        }
      };
      xhr.onerror = () => resolve(null);
      xhr.send();
    } catch (err) {
      console.warn(`[structures] XHR error for ${filename}.json`, err);
      resolve(null);
    }
  });
}

function loadStructuresFromFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  const tasks = [];

  files.forEach((file) => {
    if (!file.name.toLowerCase().endsWith('.json')) return;

    const reader = new FileReader();
    const task = new Promise((resolve) => {
      reader.onload = () => {
        let parsed = null;
        try {
          parsed = JSON.parse(reader.result);
        } catch (err) {
          console.warn(`[structures] JSON の解析に失敗しました (${file.name})`, err);
          resolve();
          return;
        }

        const slotNumber = inferSlotNumberFromData(parsed, file.name);
        if (!slotNumber) {
          console.warn(`[structures] スロット情報が見つかりません (${file.name})`);
          resolve();
          return;
        }

        const slot = customStructureSlots[slotNumber - 1];
        if (!slot) {
          console.warn(`[structures] 無効なスロット番号 ${slotNumber} (${file.name})`);
          resolve();
          return;
        }

        slot.loading = true;

        if (applyLocalStructure(slot, parsed, file.name)) {
          slot.activeFilename = file.name.replace(/\.json$/i, '');
          console.info(`[structures] slot${slot.number}: ローカルファイル ${file.name} を読み込みました`);
        } else {
          console.warn(`[structures] slot${slot.number}: ${file.name} にブロックが含まれていません`);
          slot.loading = false;
        }
        resolve();
      };
      reader.onerror = () => {
        console.warn(`[structures] ${file.name} の読み込みに失敗しました`);
        resolve();
      };
      reader.readAsText(file, 'utf-8');
    });

    tasks.push(task);
  });

  if (tasks.length === 0) {
    console.warn('[structures] 有効な JSON ファイルが見つかりませんでした');
    return;
  }

  Promise.all(tasks).then(() => {
    if (structuresDirInput) structuresDirInput.value = '';
    updateSlotAppearance();
  });
}

function createMergedPhysicsShapes(blockEntries, blockSize) {
  if (!Array.isArray(blockEntries) || !blockEntries.length) return [];

  const rows = new Map();
  blockEntries.forEach((entry) => {
    if (!entry || !entry.grid) return;
    const key = `${entry.grid.y}|${entry.grid.z}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(entry);
  });

  const shapes = [];
  rows.forEach((entries) => {
    entries.sort((a, b) => a.grid.x - b.grid.x);
    let index = 0;
    while (index < entries.length) {
      const start = entries[index];
      let end = start;
      let cursor = index + 1;
      while (cursor < entries.length && entries[cursor].grid.x === end.grid.x + 1) {
        end = entries[cursor];
        cursor += 1;
      }

      const blockCount = end.grid.x - start.grid.x + 1;
      const halfX = (blockCount * blockSize) / 2;
      const offsetX = (start.localOffset.x + end.localOffset.x) * 0.5;
      const offsetY = start.localOffset.y;
      const offsetZ = start.localOffset.z;

      shapes.push({
        halfExtents: new CANNON.Vec3(halfX, blockSize / 2, blockSize / 2),
        offset: new CANNON.Vec3(offsetX, offsetY, offsetZ),
      });

      index = cursor;
    }
  });

  if (shapes.length) return shapes;

  return blockEntries.map((entry) => ({
    halfExtents: new CANNON.Vec3(blockSize / 2, blockSize / 2, blockSize / 2),
    offset: new CANNON.Vec3(entry.localOffset.x, entry.localOffset.y, entry.localOffset.z),
  }));
}

function spawnStructureFromSlot(slot) {
  if (!slot || !slot.data) return false;

  const preset = slot.data;
  const { bounds } = preset;
  const baseBlockSize = preset.blockSize || 1;
  const scale = preset.scale || 1;
  const blockSize = baseBlockSize * scale;
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();

  const width = (bounds.maxX - bounds.minX + 1) * blockSize;
  const depth = (bounds.maxZ - bounds.minZ + 1) * blockSize;
  const spread = Math.max(width, depth) || blockSize;
  const spawnDistance = 1.6 + Math.max(0, spread - blockSize) * 0.5;
  const origin = new THREE.Vector3(playerBody.position.x, 0, playerBody.position.z).add(forward.multiplyScalar(spawnDistance));

  const baseY = Math.max(blockSize * 0.5, blockSize * 0.5 - bounds.minY * blockSize);
  const centerX = ((bounds.minX + bounds.maxX + 1) / 2) * blockSize;
  const centerZ = ((bounds.minZ + bounds.maxZ + 1) / 2) * blockSize;

  const geometry = new THREE.BoxGeometry(blockSize, blockSize, blockSize);
  const instancedGroup = new THREE.Group();
  instancedGroup.name = `structure-${slot.id}`;

  const chunkMap = new Map();
  const blockEntries = [];
  const translationMatrix = new THREE.Matrix4();

  preset.blocks.forEach((block) => {
    const alpha = typeof block.alpha === 'number' && Number.isFinite(block.alpha)
      ? THREE.MathUtils.clamp(block.alpha, 0, 1)
      : 1;

    const localX = (block.x + 0.5) * blockSize - centerX;
    const localZ = (block.z + 0.5) * blockSize - centerZ;
    const localY = (block.y - bounds.minY) * blockSize;
    const worldPos = new THREE.Vector3(origin.x + localX, baseY + localY, origin.z + localZ);

    const chunkKey = `${Math.floor(block.x / STRUCTURE_CHUNK_SIZE)}|${Math.floor(block.y / STRUCTURE_CHUNK_SIZE)}|${Math.floor(block.z / STRUCTURE_CHUNK_SIZE)}`;
    const entry = {
      grid: { x: block.x, y: block.y, z: block.z },
      color: block.color,
      alpha,
      localOffset: new THREE.Vector3(localX, localY, localZ),
      worldPos,
      chunkKey,
    };
    blockEntries.push(entry);

    let chunk = chunkMap.get(chunkKey);
    if (!chunk) {
      chunk = {
        entries: [],
        sumX: 0,
        sumY: 0,
        sumZ: 0,
      };
      chunkMap.set(chunkKey, chunk);
    }
    chunk.entries.push(entry);
    chunk.sumX += worldPos.x;
    chunk.sumY += worldPos.y;
    chunk.sumZ += worldPos.z;
  });

  const chunkList = [];
  chunkMap.forEach((chunkData, key) => {
    const entryCount = chunkData.entries.length;
    if (!entryCount) return;

    const chunkGroup = new THREE.Group();
    chunkGroup.name = `${instancedGroup.name}-chunk-${key}`;

    const colorBuckets = new Map();
    chunkData.entries.forEach((entry) => {
      const bucketKey = `${entry.color}|${entry.alpha.toFixed(3)}`;
      if (!colorBuckets.has(bucketKey)) colorBuckets.set(bucketKey, []);
      colorBuckets.get(bucketKey).push(entry);
    });

    const chunkMeshes = [];
    colorBuckets.forEach((entries, bucketKey) => {
      const [colorHex, alphaStr] = bucketKey.split('|');
      const alpha = parseFloat(alphaStr);
      const material = getStructureMaterial(colorHex, alpha, { doubleSided: alpha < 0.999 });

      const instanced = new THREE.InstancedMesh(geometry, material, entries.length);
      instanced.castShadow = false;
      instanced.receiveShadow = true;

      entries.forEach((entry, index) => {
        translationMatrix.makeTranslation(entry.worldPos.x, entry.worldPos.y, entry.worldPos.z);
        instanced.setMatrixAt(index, translationMatrix);
      });
      instanced.instanceMatrix.needsUpdate = true;
      applyMeshShadow(instanced, { cast: false, receive: true });
      chunkGroup.add(instanced);
      chunkMeshes.push({ mesh: instanced, material });
    });

    const center = new THREE.Vector3(
      chunkData.sumX / entryCount,
      chunkData.sumY / entryCount,
      chunkData.sumZ / entryCount
    );
    let radius = 0;
    chunkData.entries.forEach((entry) => {
      radius = Math.max(radius, center.distanceTo(entry.worldPos));
    });

    instancedGroup.add(chunkGroup);
    const boundingSphere = new THREE.Sphere(center.clone(), (radius || 0) + blockSize * 0.75);

    chunkList.push({
      key,
      group: chunkGroup,
      entries: chunkData.entries,
      instancedMeshes: chunkMeshes,
      center,
      radius,
      boundingSphere,
    });
  });

  scene.add(instancedGroup);

  const staticBody = new CANNON.Body({
    mass: 0,
    material: bustPhysicsMaterial,
    type: CANNON.Body.STATIC,
  });
  staticBody.position.set(origin.x, baseY, origin.z);
  staticBody.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  staticBody.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER | COLLISION_GROUPS.TARGET;

  const mergedShapes = createMergedPhysicsShapes(blockEntries, blockSize);
  mergedShapes.forEach(({ halfExtents, offset }) => {
    staticBody.addShape(new CANNON.Box(halfExtents), offset);
  });
  world.addBody(staticBody);

  const structureRecord = {
    slot: slot.id,
    data: preset,
    blockSize,
    baseY,
    origin: origin.clone(),
    center: { x: centerX, z: centerZ },
    bounds,
    instanced: instancedGroup,
    chunks: chunkList,
    instancedGeometry: geometry,
    staticBody,
    parts: [],
    blockEntries,
    createdAt: performance.now(),
    state: 'static',
  };

  setBodyTag(staticBody, { kind: 'structureStatic', ref: structureRecord });
  spawnedStructures.push(structureRecord);
  return true;
}

function breakStructure(structure, options = {}) {
  if (!structure) return [];

  if (structure.state === 'fragments' || structure.state === 'breaking') {
    if (options.computeImpulse && structure.parts && structure.parts.length) {
      structure.parts.forEach((part) => {
        if (!part || !part.body) return;
        const sourceEntry = part.blockEntry || { worldPos: part.mesh?.position || null };
        const impulse = options.computeImpulse(sourceEntry);
        if (!impulse || !impulse.vector) return;
        const vector = impulse.vector instanceof CANNON.Vec3
          ? impulse.vector
          : new CANNON.Vec3(impulse.vector.x || 0, impulse.vector.y || 0, impulse.vector.z || 0);
        const point = impulse.point
          ? new CANNON.Vec3(impulse.point.x || 0, impulse.point.y || 0, impulse.point.z || 0)
          : part.body.position;
        scheduleImpulse(part.body, vector, point, Math.max(0, impulse.delayMs || 0));
      });
    }
    return structure.parts || [];
  }

  if (structure.state !== 'static') return structure.parts || [];

  if (structure.staticBody) {
    world.removeBody(structure.staticBody);
    structure.staticBody.userData = null;
    structure.staticBody = null;
  }

  if (structure.instanced) {
    scene.remove(structure.instanced);
    structure.instanced = null;
  }
  if (structure.chunks && structure.chunks.length) {
    structure.chunks.forEach((chunk) => {
      if (!chunk) return;
      if (chunk.group && chunk.group.parent) {
        chunk.group.parent.remove(chunk.group);
      }
      if (chunk.instancedMeshes && chunk.instancedMeshes.length) {
        chunk.instancedMeshes.forEach(({ mesh, material }) => {
          mesh?.dispose?.();
          if (material && !(material.userData && material.userData.reusable)) {
            material.dispose?.();
          }
        });
        chunk.instancedMeshes.length = 0;
      }
    });
    structure.chunks = [];
  }
  if (structure.instancedGeometry) {
    structure.instancedGeometry.dispose?.();
    structure.instancedGeometry = null;
  }

  const blockSize = structure.blockSize || 1;
  const geometry = new THREE.BoxGeometry(blockSize, blockSize, blockSize);
  structure.fragmentMaterials = [];
  structure.fragmentGeometry = geometry;
  structure.parts = [];

  const entries = Array.isArray(options.entries) && options.entries.length
    ? options.entries
    : structure.blockEntries;

  const queue = entries.map((entry) => {
    const taskEntry = { entry };
    if (options.computeImpulse) {
      try {
        const result = options.computeImpulse(entry);
        if (result && result.vector) {
          const vec = result.vector instanceof CANNON.Vec3
            ? result.vector
            : { x: result.vector.x || 0, y: result.vector.y || 0, z: result.vector.z || 0 };
          const point = result.point
            ? (result.point instanceof CANNON.Vec3
              ? result.point
              : { x: result.point.x || 0, y: result.point.y || 0, z: result.point.z || 0 })
            : null;
          taskEntry.impulse = {
            vector: vec,
            point,
            delayMs: Math.max(0, result.delayMs || 0),
          };
        }
      } catch (err) {
        console.warn('[structures] computeImpulse failed', err);
      }
    }
    return taskEntry;
  });

  const breakTask = {
    structure,
    queue,
    geometry,
    materialCache: new Map(),
    blockSize,
    onPartCreated: typeof options.onPartCreated === 'function' ? options.onPartCreated : null,
  };

  structure.state = 'breaking';
  structure.breakTask = breakTask;
  structureBreakQueue.push(breakTask);
  scheduleStructureBreakProcessing();
  return structure.parts;
}

function processStructureBreakQueue() {
  structureBreakHandle = 0;
  const start = performance.now();

  while (structureBreakQueue.length) {
    const task = structureBreakQueue[0];
    const { structure, queue, geometry, materialCache, blockSize, onPartCreated } = task;
    if (!structure) {
      structureBreakQueue.shift();
      continue;
    }

    let processed = 0;
    while (queue.length && processed < STRUCTURE_BREAK_BATCH_SIZE) {
      const item = queue.shift();
      const entry = item && item.entry;
      if (!entry || !entry.worldPos) {
        processed++;
        continue;
      }

      const alpha = typeof entry.alpha === 'number' ? entry.alpha : 1;
      const cacheKey = `${entry.color}|${alpha.toFixed(3)}`;
      let material = materialCache.get(cacheKey);
      if (!material) {
        material = getStructureMaterial(entry.color, alpha, { doubleSided: alpha < 0.999 });
        materialCache.set(cacheKey, material);
        if (!Array.isArray(structure.fragmentMaterials)) structure.fragmentMaterials = [];
        if (!structure.fragmentMaterials.includes(material)) structure.fragmentMaterials.push(material);
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(entry.worldPos);
      mesh.quaternion.set(0, 0, 0, 1);
      mesh.matrixAutoUpdate = true;
      scene.add(mesh);
      applyMeshShadow(mesh, { cast: renderSettings.targetShadows, receive: true });

      const mass = Math.max(0.4, blockSize * 0.5);
      const body = new CANNON.Body({
        mass,
        material: bustPhysicsMaterial,
        linearDamping: 0.08,
        angularDamping: 0.06,
        type: CANNON.Body.DYNAMIC,
      });
      body.addShape(new CANNON.Box(new CANNON.Vec3(blockSize / 2, blockSize / 2, blockSize / 2)));
      body.position.set(entry.worldPos.x, entry.worldPos.y, entry.worldPos.z);
      body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
      body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.PLAYER | COLLISION_GROUPS.TARGET | COLLISION_GROUPS.FIST;
      body.allowSleep = true;
      world.addBody(body);

      const part = { mesh, body, blockSize, color: entry.color, alpha, structure, blockEntry: entry, spawnedAt: performance.now(), dynamicState: 'active' };
      setBodyTag(body, { kind: 'structurePart', ref: part });
      body.userData.structure = structure;

      const targetRecord = registerSpawnedTarget(mesh, body, {
        bodyTag: { kind: 'structurePart', ref: part },
        metadata: { source: 'structure', slot: structure.slot },
        lodOptions: { threshold: 22 },
      });
      part.targetRecord = targetRecord;
      structure.parts.push(part);

      if (item.impulse && item.impulse.vector) {
        const vec = item.impulse.vector instanceof CANNON.Vec3
          ? item.impulse.vector
          : new CANNON.Vec3(item.impulse.vector.x || 0, item.impulse.vector.y || 0, item.impulse.vector.z || 0);
        const point = item.impulse.point
          ? (item.impulse.point instanceof CANNON.Vec3
            ? item.impulse.point
            : new CANNON.Vec3(item.impulse.point.x || 0, item.impulse.point.y || 0, item.impulse.point.z || 0))
          : body.position;
        scheduleImpulse(body, vec, point, Math.max(0, Math.min(item.impulse.delayMs || 0, 20)));
      }

      if (onPartCreated) {
        try {
          onPartCreated(part, entry, item);
        } catch (err) {
          console.warn('[structures] onPartCreated handler failed', err);
        }
      }

      processed++;
    }

    if (!queue.length) {
      structure.state = 'fragments';
      structure.breakTask = null;
      structureBreakQueue.shift();
      continue;
    }

    if (performance.now() - start >= STRUCTURE_BREAK_TIME_BUDGET_MS) {
      scheduleStructureBreakProcessing();
      return;
    }
  }
}

function disposeStructure(structure, { removeFromList = true } = {}) {
  if (!structure) return;

  if (structure.breakTask) {
    const idx = structureBreakQueue.indexOf(structure.breakTask);
    if (idx !== -1) structureBreakQueue.splice(idx, 1);
    structure.breakTask = null;
  }

  if (structure.state === 'static') {
    if (structure.staticBody) {
      world.removeBody(structure.staticBody);
      structure.staticBody.userData = null;
      structure.staticBody = null;
    }
    if (structure.instanced) {
      scene.remove(structure.instanced);
      structure.instanced = null;
    }
    if (structure.chunks && structure.chunks.length) {
      structure.chunks.forEach((chunk) => {
        if (!chunk) return;
        if (chunk.group && chunk.group.parent) {
          chunk.group.parent.remove(chunk.group);
        }
        if (chunk.instancedMeshes && chunk.instancedMeshes.length) {
          chunk.instancedMeshes.forEach(({ mesh, material }) => {
            mesh?.dispose?.();
            if (material && !(material.userData && material.userData.reusable)) {
              material.dispose?.();
            }
          });
          chunk.instancedMeshes.length = 0;
        }
      });
      structure.chunks = [];
    }
    if (structure.instancedGeometry) {
      structure.instancedGeometry.dispose?.();
      structure.instancedGeometry = null;
    }
  }

  if (structure.parts && structure.parts.length) {
    for (let i = structure.parts.length - 1; i >= 0; i--) {
      const part = structure.parts[i];
      if (!part) continue;
      if (part.targetRecord) {
        const idx = spawnedTargets.indexOf(part.targetRecord);
        if (idx !== -1) {
          const target = spawnedTargets[idx];
          if (target.lod && target.lod.placeholder && target.lod.placeholder.parent) {
            target.lod.placeholder.parent.remove(target.lod.placeholder);
          }
          spawnedTargets.splice(idx, 1);
        }
      }
      if (part.body) {
        world.removeBody(part.body);
        part.body.userData = null;
      }
      if (part.mesh) {
        scene.remove(part.mesh);
      }
    }
    structure.parts.length = 0;
  }

  if (structure.fragmentMaterials && structure.fragmentMaterials.length) {
    structure.fragmentMaterials.forEach((material) => {
      if (!material) return;
      if (material.userData && material.userData.reusable) return;
      material.dispose?.();
    });
    structure.fragmentMaterials = [];
  }
  if (structure.fragmentGeometry) {
    structure.fragmentGeometry.dispose?.();
    structure.fragmentGeometry = null;
  }

  if (removeFromList) {
    const index = spawnedStructures.indexOf(structure);
    if (index !== -1) spawnedStructures.splice(index, 1);
  }

  structure.state = 'disposed';
}

function spawnStructureFromIndex(slotIndex) {
  const slot = customStructureSlots[slotIndex];
  if (!slot) return false;
  if (!slot.data) {
    if (!slot.loading) {
      loadStructureSlot(slot).then((loaded) => {
        if (loaded) {
          spawnStructureFromSlot(slot);
        } else {
          console.warn(`選択されたスロットに建造物が設定されていません。${structureSlotHint(slot)} を確認してください。`);
        }
      });
    }
    return 'pending';
  }
  return spawnStructureFromSlot(slot);
}

function getCameraPosition() {
  return new THREE.Vector3(
    playerRig.position.x,
    playerRig.position.y + 0.8,
    playerRig.position.z
  );
}

function getCameraForward() {
  return new THREE.Vector3(-Math.sin(yaw), Math.sin(pitch), -Math.cos(yaw)).normalize();
}

function getAllTargetEntries({ includeBust = true, includeRafts = false } = {}) {
  const entries = [];
  for (let i = 0; i < spawnedTargets.length; i++) {
    const entry = spawnedTargets[i];
    entries.push({ type: 'target', entry, mesh: entry.mesh, body: entry.body, index: i });
  }
  for (let s = 0; s < spawnedStructures.length; s++) {
    const structure = spawnedStructures[s];
    if (!structure) continue;
    if (structure.state === 'static') {
      if (structure.staticBody) {
        entries.push({ type: 'structureStatic', structure, mesh: structure.instanced, body: structure.staticBody, structureIndex: s });
      }
      continue;
    }
    if (!structure.parts) continue;
    for (let p = 0; p < structure.parts.length; p++) {
      const part = structure.parts[p];
      entries.push({ type: 'structure', structure, structureIndex: s, part, partIndex: p, mesh: part.mesh, body: part.body });
    }
  }
  if (includeRafts) {
    for (let r = 0; r < raftEntities.length; r++) {
      const raft = raftEntities[r];
      entries.push({ type: 'raft', raft, raftIndex: r, mesh: raft.mesh, body: raft.body });
    }
  }
  if (includeBust) {
    entries.push({ type: 'bust', mesh: targetMesh, body: bustBody });
  }
  return entries;
}

function removeTargetEntry(entry) {
  if (!entry) return;
  if (entry.type === 'target') {
    const idx = spawnedTargets.indexOf(entry.entry);
    if (idx !== -1) spawnedTargets.splice(idx, 1);
    magnetImpulseMap.delete(entry.body);
  } else if (entry.type === 'structure') {
    const { structure, partIndex, part } = entry;
    const idx = structure.parts.indexOf(part);
    if (idx !== -1) structure.parts.splice(idx, 1);
    if (part && part.targetRecord) {
      const tIdx = spawnedTargets.indexOf(part.targetRecord);
      if (tIdx !== -1) {
        const target = spawnedTargets[tIdx];
        if (target.lod && target.lod.placeholder && target.lod.placeholder.parent) {
          target.lod.placeholder.parent.remove(target.lod.placeholder);
        }
        spawnedTargets.splice(tIdx, 1);
      }
      part.targetRecord = null;
    }
    if (structure.parts.length === 0) {
      disposeStructure(structure);
    }
  } else if (entry.type === 'structureStatic') {
    if (entry.structure) {
      disposeStructure(entry.structure);
    }
    return;
  } else if (entry.type === 'raft') {
    const raft = entry.raft;
    const idx = raftEntities.indexOf(raft);
    if (idx !== -1) raftEntities.splice(idx, 1);
  }
  if (entry.body) {
    entry.body.userData = null;
    world.removeBody(entry.body);
  }
  if (entry.mesh) {
    scene.remove(entry.mesh);
  }
  if (entry.lod && entry.lod.placeholder && entry.lod.placeholder.parent) {
    entry.lod.placeholder.parent.remove(entry.lod.placeholder);
  }
}

function resolveTargetEntryFromBody(body, { includeBust = true, includeRafts = false } = {}) {
  if (!body) return null;
  const tag = body.userData;
  if (!tag || typeof tag !== 'object') return null;
  if (tag.kind === 'bust') {
    if (!includeBust) return null;
    return { type: 'bust', mesh: targetMesh, body: bustBody };
  }
  if (tag.kind === 'raft') {
    if (!includeRafts || !tag.ref) return null;
    const raft = tag.ref;
    return { type: 'raft', raft, mesh: raft.mesh, body: raft.body };
  }
  if (tag.kind === 'target') {
    const record = tag.ref;
    if (!record) return null;
    return { type: 'target', entry: record, mesh: record.mesh, body: record.body };
  }
  if (tag.kind === 'structureStatic') {
    const structure = tag.ref;
    if (!structure) return null;
    return { type: 'structureStatic', structure, mesh: structure.instanced, body: structure.staticBody };
  }
  if (tag.kind === 'structurePart') {
    const part = tag.ref;
    if (!part) return null;
    const structure = (body.userData && body.userData.structure) || null;
    return { type: 'structure', structure, part, mesh: part.mesh, body: part.body };
  }
  return null;
}

function getTargetUnderCrosshair({ includeBust = true, includeRafts = false, maxAngleDeg = 12, maxDistance = Infinity, useRaycast = false } = {}) {
  if (useRaycast) {
    const from = getCameraPosition();
    const forward = getCameraForward();
    const rayDistance = Number.isFinite(maxDistance) ? Math.max(maxDistance, 0.01) : 30;
    const to = from.clone().add(forward.multiplyScalar(rayDistance));
    const hits = [];
    const fromVec = new CANNON.Vec3(from.x, from.y, from.z);
    const toVec = new CANNON.Vec3(to.x, to.y, to.z);
    const options = {
      skipBackfaces: true,
      collisionFilterMask: COLLISION_GROUPS.TARGET,
      collisionFilterGroup: COLLISION_GROUPS.PLAYER | COLLISION_GROUPS.FIST | COLLISION_GROUPS.TARGET,
    };
    world.raycastAll(fromVec, toVec, options, (result) => {
      if (result && result.body) {
        hits.push({ body: result.body, distance: result.distance });
      }
      return false;
    });
    if (hits.length) {
      hits.sort((a, b) => a.distance - b.distance);
      const limit = Number.isFinite(maxDistance) ? maxDistance : rayDistance;
      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        if (hit.distance > limit + 1e-3) continue;
        const entry = resolveTargetEntryFromBody(hit.body, { includeBust, includeRafts });
        if (entry) return entry;
      }
    }
    // Fallback to angular filtering if physics ray misses
  }

  const forward = getCameraForward();
  const cameraPos = getCameraPosition();
  const cosThreshold = Math.cos(THREE.MathUtils.degToRad(maxAngleDeg));
  let best = null;
  let bestDot = cosThreshold;
  let bestDistance = Infinity;
  getAllTargetEntries({ includeBust, includeRafts }).forEach((entry) => {
    if (!entry.body) return;
    const targetPos = new THREE.Vector3(entry.body.position.x, entry.body.position.y, entry.body.position.z);
    const dir = targetPos.clone().sub(cameraPos).normalize();
    const dot = forward.dot(dir);
    if (dot < cosThreshold) return;
    const distance = cameraPos.distanceTo(targetPos);
    if (distance > maxDistance) return;
    if (distance < bestDistance - 1e-3 || (Math.abs(distance - bestDistance) < 1e-3 && dot > bestDot)) {
      bestDot = dot;
      bestDistance = distance;
      best = entry;
    }
  });
  return best;
}

function getTargetsInView({ includeBust = true, includeRafts = false, maxAngleDeg = 45 } = {}) {
  const forward = getCameraForward();
  const cameraPos = getCameraPosition();
  const cosThreshold = Math.cos(THREE.MathUtils.degToRad(maxAngleDeg));
  const targets = [];
  getAllTargetEntries({ includeBust, includeRafts }).forEach((entry) => {
    if (!entry.body) return;
    const targetPos = new THREE.Vector3(entry.body.position.x, entry.body.position.y, entry.body.position.z);
    const dir = targetPos.clone().sub(cameraPos).normalize();
    const dot = forward.dot(dir);
    if (dot >= cosThreshold) {
      targets.push({ entry, targetPos, dir, dot });
    }
  });
  return targets;
}

// オブジェクト生成関数
function spawnSelectedObject() {
  const spawnDef = getSpawnDefinition(selectedSlotIndex);
  if (spawnDef && typeof spawnDef.spawnFn === 'function') {
    spawnDef.spawnFn();
  }
}

// 武器アクション実行
function executeWeaponAction() {
  switch (currentWeapon.action) {
    case 'punch':
      punch();
      break;
    case 'slash':
      slash();
      break;
    case 'shoot':
      shoot();
      break;
    case 'throw':
      throwBomb();
      break;
    case 'megaBomb':
      throwMegaBomb();
      break;
    case 'stab':
      stab();
      break;
    case 'gravity':
      activateGravity();
      break;
    case 'blast':
      blast();
      break;
    case 'magnet':
      magnet();
      break;
    case 'superMagnet':
      superMagnet();
      break;
    case 'shotgun':
      shotgun();
      break;
    case 'hammer':
      hammerImpact();
      break;
    case 'trash':
      trashTargets();
      break;
    case 'antiGravity':
      activateAntiGravity();
      break;
    case 'fingerSnap':
      fingerSnap();
      break;
    case 'bucket':
      bucketAction();
      break;
    case 'raft':
      spawnRaftEntity();
      break;
    case 'fly':
      // クリエイティブモードは移動で処理
      break;
  }
}

// ターゲットを真っ二つにする関数
function splitTarget(originalMesh, originalBody, index) {
  // 現在のターゲットサイズを取得
  const currentSize = originalMesh.geometry.parameters;
  
  // 分割可能かチェック
  if (!canSplitTarget(currentSize)) {
    // 分割できない場合は削除
    scene.remove(originalMesh);
    world.removeBody(originalBody);
    spawnedTargets.splice(index, 1);
    return;
  }
  
  // 元のターゲットを削除
  scene.remove(originalMesh);
  world.removeBody(originalBody);
  spawnedTargets.splice(index, 1);
  
  // 元のターゲットの位置とサイズを取得
  const originalPos = new THREE.Vector3(originalBody.position.x, originalBody.position.y, originalBody.position.z);
  const originalSize = originalMesh.geometry.parameters;
  
  // 切り方に応じてサイズを決定
  let halfSize;
  if (swordCutDirection === 'vertical') {
    // 縦切り（左右に分割）
    halfSize = {
      x: Math.max(originalSize.width / 2, minTargetSize),
      y: originalSize.height,
      z: originalSize.depth
    };
  } else {
    // 横切り（上下に分割）
    halfSize = {
      x: originalSize.width,
      y: Math.max(originalSize.height / 2, minTargetSize),
      z: originalSize.depth
    };
  }
  
  // 2つの小さなターゲットを作成
  for (let i = 0; i < 2; i++) {
    const geometry = new THREE.BoxGeometry(halfSize.x, halfSize.y, halfSize.z);
    const material = new THREE.MeshStandardMaterial({ 
      color: originalMesh.material.color,
      metalness: originalMesh.material.metalness,
      roughness: originalMesh.material.roughness
    });
    const mesh = new THREE.Mesh(geometry, material);
    
    // 位置を設定（切り方に応じて）
    let offset;
    if (swordCutDirection === 'vertical') {
      // 縦切り：左右に分ける
      offset = i === 0 ? -halfSize.x / 2 : halfSize.x / 2;
      mesh.position.set(
        originalPos.x + offset,
        originalPos.y,
        originalPos.z
      );
    } else {
      // 横切り：上下に分ける
      offset = i === 0 ? -halfSize.y / 2 : halfSize.y / 2;
      mesh.position.set(
        originalPos.x,
        originalPos.y + offset,
        originalPos.z
      );
    }
    
    // 物理ボディを作成
    const shape = new CANNON.Box(new CANNON.Vec3(halfSize.x / 2, halfSize.y / 2, halfSize.z / 2));
    const body = new CANNON.Body({ mass: originalBody.mass / 2 });
    body.addShape(shape);
    body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
    
    // 少しランダムな速度を追加
    body.velocity.set(
      (Math.random() - 0.5) * 5,
      Math.random() * 3,
      (Math.random() - 0.5) * 5
    );
    
    // 分割されたターゲットのサイズをチェック
    if (halfSize.x <= minTargetSize || halfSize.y <= minTargetSize || halfSize.z <= minTargetSize) {
      // 最小サイズに達した場合は削除（何も追加しない）
      continue;
    }
    
    // シーンとワールドに追加
    scene.add(mesh);
    world.addBody(body);
    registerSpawnedTarget(mesh, body); // 分割回数はサイズから計算
  }
  
  // 切り方を交互に変更
  swordCutDirection = swordCutDirection === 'vertical' ? 'horizontal' : 'vertical';
}

// 武器機能の実装
function slash() {
  if (!canPunch) return;
  canPunch = false;
  
  // 刀の視覚効果（手を振るアニメーション）
  const startZ = handGroup.position.z;
  const startX = handGroup.position.x;
  gsap.to(handGroup.position, { 
    z: startZ - 0.8, 
    x: startX + 0.3,
    duration: 0.1, 
    ease: 'power3.out', 
    yoyo: true, 
    repeat: 1, 
    onUpdate: syncFistBody,
    onComplete: () => {
      handGroup.position.set(startX, handGroup.position.y, startZ);
    }
  });
  
  // 刀の攻撃判定（より広範囲）
  const swordRange = 2.0;
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  
  // プレイヤーの位置
  const playerPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z);
  
  // 全てのターゲットをチェック
  for (let i = spawnedTargets.length - 1; i >= 0; i--) {
    const { mesh, body } = spawnedTargets[i];
    const targetPos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
    const distance = playerPos.distanceTo(targetPos);
    
    if (distance <= swordRange) {
      // ターゲットを真っ二つにする
      splitTarget(mesh, body, i);
    }
  }
  
  // メインターゲットもチェック
  const targetPos = new THREE.Vector3(bustBody.position.x, bustBody.position.y, bustBody.position.z);
  const distance = playerPos.distanceTo(targetPos);
  
  if (distance <= swordRange) {
    // メインターゲットの現在のサイズを取得
    const currentSize = targetMesh.geometry.parameters;
    
    // 分割可能かチェック
    if (!canSplitTarget(currentSize)) {
      scene.remove(targetMesh);
      world.removeBody(bustBody);
      
      // 新しいターゲットを生成
      const newTargetMesh = new THREE.Mesh(new THREE.BoxGeometry(boxSize.x, boxSize.y, boxSize.z), targetMat);
      newTargetMesh.position.set(0, poleHeight + boxSize.y / 2, -2);
      newTargetMesh.castShadow = true;
      newTargetMesh.receiveShadow = true;
      scene.add(newTargetMesh);
    
    const newBustBody = new CANNON.Body({ mass: bustParams.mass, material: bustPhysicsMaterial, linearDamping: 0.12, angularDamping: 0.12, allowSleep: false });
    const targetShape = new CANNON.Box(new CANNON.Vec3(boxSize.x/2, boxSize.y/2, boxSize.z/2));
    newBustBody.addShape(targetShape);
    newBustBody.position.set(0, poleHeight + boxSize.y / 2, -2);
    newBustBody.collisionFilterGroup = COLLISION_GROUPS.TARGET;
    newBustBody.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
    world.addBody(newBustBody);
    newBustBody.wakeUp();
    setBodyTag(newBustBody, { kind: 'bust' });

    // グローバル変数を更新
    targetMesh = newTargetMesh;
    bustBody = newBustBody;
    } else {
      // まだ切れる場合は分割する（メインターゲットは分割しないので何もしない）
    }
  }
  
  // クールダウン
  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function shoot() {
  if (!canPunch) return;
  canPunch = false;
  
  // 矢を作成（直方体に変更）
  const arrowGeometry = new THREE.BoxGeometry(0.05, 0.05, 0.3);
  const arrowMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 });
  const arrow = new THREE.Mesh(arrowGeometry, arrowMaterial);
  
  // 矢の初期位置（カメラの下の方から）
  const forward = new THREE.Vector3(-Math.sin(yaw), Math.sin(pitch), -Math.cos(yaw)); // pitchの符号を反転
  
  // カメラの位置を基準にする（下の方）
  const cameraPos = new THREE.Vector3(
    playerRig.position.x,
    playerRig.position.y + 0, // 1.7から0.8に下げる
    playerRig.position.z
  );
  
  const startPos = new THREE.Vector3(
    cameraPos.x + forward.x * 0.3,
    cameraPos.y + forward.y * 0.3,
    cameraPos.z + forward.z * 0.3
  );
  
  arrow.position.copy(startPos);
  arrow.lookAt(startPos.clone().add(forward));
  scene.add(arrow);
  
  // 矢の物理ボディ（直方体に変更）
  const arrowBody = new CANNON.Body({ mass: 0.1, material: new CANNON.Material('arrow') });
  arrowBody.addShape(new CANNON.Box(new CANNON.Vec3(0.025, 0.025, 0.15)));
  arrowBody.position.set(startPos.x, startPos.y, startPos.z);
  arrowBody.quaternion.setFromEuler(0, yaw, pitch);
  arrowBody.collisionFilterGroup = COLLISION_GROUPS.FIST;
  arrowBody.collisionFilterMask = COLLISION_GROUPS.TARGET | COLLISION_GROUPS.GROUND;
  world.addBody(arrowBody);
  
  // 矢に速度を設定
  const speed = 25;
  arrowBody.velocity.set(forward.x * speed, forward.y * speed, forward.z * speed);
  
  // カメラ中心に最も近いターゲットを見つける
  const arrowCameraPos = new THREE.Vector3(
    playerRig.position.x,
    playerRig.position.y + 0.8,
    playerRig.position.z
  );
  const arrowForward = new THREE.Vector3(-Math.sin(yaw), Math.sin(pitch), -Math.cos(yaw));
  
  let closestTarget = null;
  let closestDistance = Infinity;
  
  // 生成されたターゲットをチェック
  spawnedTargets.forEach(({ body }) => {
    const targetPos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
    const direction = targetPos.clone().sub(arrowCameraPos).normalize();
    const dot = arrowForward.dot(direction);
    
    if (dot > 0.5) { // 前方60度以内
      const distance = arrowCameraPos.distanceTo(targetPos);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestTarget = body;
      }
    }
  });
  
  // メインターゲットもチェック
  const targetPos = new THREE.Vector3(bustBody.position.x, bustBody.position.y, bustBody.position.z);
  const direction = targetPos.clone().sub(arrowCameraPos).normalize();
  const dot = arrowForward.dot(direction);
  
  if (dot > 0.5) {
    const distance = arrowCameraPos.distanceTo(targetPos);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestTarget = bustBody;
    }
  }

  // 矢を配列に追加（ターゲット情報も含める）
  arrows.push({ 
    mesh: arrow, 
    body: arrowBody, 
    spawnTime: performance.now(),
    targetBody: null, // 刺さったターゲットの物理ボディ
    targetMesh: null, // 刺さったターゲットのメッシュ
    hitPosition: null, // 刺さった位置
    trackingTarget: closestTarget, // 追尾対象のターゲット
    trackingSpeed: 15, // 追尾速度
    launchPosition: new THREE.Vector3(arrowCameraPos.x, arrowCameraPos.y, arrowCameraPos.z), // 発射時の位置
    launchDirection: new THREE.Vector3(arrowForward.x, arrowForward.y, arrowForward.z) // 発射時の方向
  });
  
  // クールダウン
  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function throwBomb() {
  if (!canPunch) return;
  canPunch = false;
  
  // 爆弾を作成
  const bombGeometry = new THREE.SphereGeometry(0.15, 8, 6);
  const bombMaterial = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const bomb = new THREE.Mesh(bombGeometry, bombMaterial);
  
  // 爆弾の初期位置（カメラの下の方から）
  const forward = new THREE.Vector3(-Math.sin(yaw), Math.sin(pitch), -Math.cos(yaw)); // pitchの符号を反転
  
  // カメラの位置を基準にする（下の方）
  const cameraPos = new THREE.Vector3(
    playerRig.position.x,
    playerRig.position.y + 0.8, // 1.7から0.8に下げる
    playerRig.position.z
  );
  
  const startPos = new THREE.Vector3(
    cameraPos.x + forward.x * 0.3,
    cameraPos.y + forward.y * 0.3,
    cameraPos.z + forward.z * 0.3
  );
  
  bomb.position.copy(startPos);
  scene.add(bomb);
  
  // 爆弾の物理ボディ
  const bombBody = new CANNON.Body({ mass: 0.5, material: new CANNON.Material('bomb') });
  bombBody.addShape(new CANNON.Sphere(0.15));
  bombBody.position.set(startPos.x, startPos.y, startPos.z);
  bombBody.collisionFilterGroup = COLLISION_GROUPS.FIST;
  bombBody.collisionFilterMask = COLLISION_GROUPS.TARGET | COLLISION_GROUPS.GROUND;
  world.addBody(bombBody);
  
  // 爆弾に速度を設定（放物線）
  const speed = 15;
  bombBody.velocity.set(forward.x * speed, forward.y * speed + 5, forward.z * speed);
  
  // 爆弾を配列に追加
  bombs.push({ mesh: bomb, body: bombBody, spawnTime: performance.now(), explosionRadius: 3.0, explosionForce: 500 });
  
  // クールダウン
  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function throwMegaBomb() {
  if (!canPunch) return;
  canPunch = false;

  const bombGeometry = new THREE.SphereGeometry(0.2, 10, 8);
  const bombMaterial = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0x440000 });
  const bomb = new THREE.Mesh(bombGeometry, bombMaterial);

  const forward = getCameraForward();
  const cameraPos = getCameraPosition();

  const startPos = new THREE.Vector3(
    cameraPos.x + forward.x * 0.3,
    cameraPos.y + forward.y * 0.3,
    cameraPos.z + forward.z * 0.3
  );

  bomb.position.copy(startPos);
  scene.add(bomb);

  const bombBody = new CANNON.Body({ mass: 0.7, material: new CANNON.Material('megaBomb') });
  bombBody.addShape(new CANNON.Sphere(0.2));
  bombBody.position.set(startPos.x, startPos.y, startPos.z);
  bombBody.collisionFilterGroup = COLLISION_GROUPS.FIST;
  bombBody.collisionFilterMask = COLLISION_GROUPS.TARGET | COLLISION_GROUPS.GROUND;
  world.addBody(bombBody);

  const speed = 18;
  bombBody.velocity.set(forward.x * speed, forward.y * speed + 6, forward.z * speed);

  bombs.push({ mesh: bomb, body: bombBody, spawnTime: performance.now(), explosionRadius: 6.0, explosionForce: 1200 });

  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function superMagnet() {
  if (!canPunch) return;
  canPunch = false;

  magnetImpulseQueue.length = 0;
  magnetImpulseMap.clear();

  const playerPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y + 0.5, playerBody.position.z);
  const allTargets = getAllTargetEntries({ includeBust: true, includeRafts: false });
  allTargets.forEach((entry) => {
    if (!entry.body) return;
    if (entry.type === 'structureStatic') return;
    entry.body.velocity.scale(0.2, entry.body.velocity);
    entry.body.angularVelocity.set(0, 0, 0);
    queueMagnetImpulse(entry.body, 60, playerPos);
    setTimeout(() => queueMagnetImpulse(entry.body, 45, playerPos), 120);
  });

  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function fireArrowAtBody(targetBody, { direction: overrideDir } = {}) {
  const cameraPos = getCameraPosition();
  let direction;
  if (overrideDir) {
    direction = overrideDir.clone();
  } else if (targetBody) {
    const targetPos = new THREE.Vector3(targetBody.position.x, targetBody.position.y, targetBody.position.z);
    direction = targetPos.clone().sub(cameraPos).normalize();
  } else {
    direction = getCameraForward();
  }

  const arrowGeometry = new THREE.BoxGeometry(0.05, 0.05, 0.3);
  const arrowMaterial = new THREE.MeshStandardMaterial({ color: 0x8B4513 });
  const arrow = new THREE.Mesh(arrowGeometry, arrowMaterial);

  const startPos = cameraPos.clone().add(direction.clone().multiplyScalar(0.3));
  arrow.position.copy(startPos);
  arrow.lookAt(startPos.clone().add(direction));
  scene.add(arrow);

  const arrowBody = new CANNON.Body({ mass: 0.1, material: new CANNON.Material('arrow') });
  arrowBody.addShape(new CANNON.Box(new CANNON.Vec3(0.025, 0.025, 0.15)));
  arrowBody.position.set(startPos.x, startPos.y, startPos.z);
  arrowBody.quaternion.setFromEuler(0, Math.atan2(-direction.x, -direction.z), Math.asin(direction.y));
  arrowBody.collisionFilterGroup = COLLISION_GROUPS.FIST;
  arrowBody.collisionFilterMask = COLLISION_GROUPS.TARGET | COLLISION_GROUPS.GROUND;
  world.addBody(arrowBody);

  const speed = 28;
  arrowBody.velocity.set(direction.x * speed, direction.y * speed, direction.z * speed);

  arrows.push({ 
    mesh: arrow,
    body: arrowBody,
    spawnTime: performance.now(),
    targetBody,
    targetMesh: null,
    hitPosition: null,
    trackingTarget: targetBody || null,
    trackingSpeed: 20,
    launchPosition: cameraPos.clone(),
    launchDirection: direction.clone()
  });
}

function shotgun() {
  if (!canPunch) return;
  canPunch = false;

  const targets = getTargetsInView({ includeBust: true, maxAngleDeg: 45 });
  if (targets.length) {
    targets.forEach(({ entry }) => {
      if (entry.body) {
        fireArrowAtBody(entry.body);
      }
    });
  } else {
    const baseDir = getCameraForward();
    for (let i = 0; i < 5; i++) {
      const spread = new THREE.Vector3(
        (Math.random() - 0.5) * 0.25,
        (Math.random() - 0.5) * 0.12,
        (Math.random() - 0.5) * 0.25
      );
      const dir = baseDir.clone().add(spread).normalize();
      fireArrowAtBody(null, { direction: dir });
    }
  }

  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function hammerImpact() {
  if (!canPunch) return;
  canPunch = false;

  const radius = 30;
  const playerPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z);
  const targets = getAllTargetEntries({ includeBust: true, includeRafts: true });
  targets.forEach((entry, index) => {
    const delayBase = Math.min(index * 2, 24);
    if (entry.type === 'structureStatic' && entry.structure) {
      breakStructure(entry.structure, {
        computeImpulse: (blockEntry) => {
          if (!blockEntry || !blockEntry.worldPos) return null;
          const partPos = blockEntry.worldPos;
          const distance = playerPos.distanceTo(partPos);
          if (distance > radius || distance <= 0.01) return null;
          const direction = partPos.clone().sub(playerPos).normalize();
          const force = 80 * (1 - distance / radius);
          return {
            vector: { x: direction.x * force, y: direction.y * force + 20, z: direction.z * force },
            point: { x: partPos.x, y: partPos.y, z: partPos.z },
            delayMs: delayBase + Math.random() * 30,
          };
        },
      });
      return;
    }
    if (!entry.body) return;
    const targetPos = new THREE.Vector3(entry.body.position.x, entry.body.position.y, entry.body.position.z);
    const distance = playerPos.distanceTo(targetPos);
    if (distance <= radius && distance > 0.01) {
      const direction = targetPos.clone().sub(playerPos).normalize();
      const force = 80 * (1 - distance / radius);
      const impulse = new CANNON.Vec3(direction.x * force, direction.y * force + 20, direction.z * force);
      scheduleImpulse(entry.body, impulse, entry.body.position, delayBase + Math.random() * 12);
    }
  });

  const hammerWave = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.55, 32), new THREE.MeshBasicMaterial({ color: 0xffdd55, transparent: true, opacity: 0.6 }));
  hammerWave.rotation.x = -Math.PI / 2;
  hammerWave.position.set(playerPos.x, playerPos.y + 0.1, playerPos.z);
  hammerWave.material.side = THREE.DoubleSide;
  scene.add(hammerWave);
  gsap.to(hammerWave.scale, { x: radius, y: radius, duration: 0.4, ease: 'power2.out' });
  gsap.to(hammerWave.material, { opacity: 0, duration: 0.4, onComplete: () => scene.remove(hammerWave) });

  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function trashTargets() {
  if (!canPunch) return;
  canPunch = false;

  while (spawnedTargets.length) {
    const entry = spawnedTargets.pop();
    world.removeBody(entry.body);
    scene.remove(entry.mesh);
    if (entry.lod && entry.lod.placeholder && entry.lod.placeholder.parent) {
      entry.lod.placeholder.parent.remove(entry.lod.placeholder);
    }
  }

  while (spawnedStructures.length) {
    const structure = spawnedStructures.pop();
    disposeStructure(structure, { removeFromList: false });
  }

  while (bombs.length) {
    const bomb = bombs.pop();
    world.removeBody(bomb.body);
    scene.remove(bomb.mesh);
  }

  while (raftEntities.length) {
    const raft = raftEntities.pop();
    world.removeBody(raft.body);
    scene.remove(raft.mesh);
  }

  if (bucketCarry) bucketCarry = null;
  if (antiGravityActive) restoreDefaultGravity();
  magnetImpulseQueue.length = 0;
  magnetImpulseMap.clear();

  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function activateAntiGravity() {
  if (!canPunch) return;
  canPunch = false;

  setWorldGravity(0, 2, 0);
  antiGravityActive = true;

  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function fingerSnap() {
  if (!canPunch) return;
  canPunch = false;

  const target = getTargetUnderCrosshair({ includeBust: false, includeRafts: false, maxAngleDeg: 10 });
  if (target && target.body !== bustBody) {
    removeTargetEntry(target);
  }

  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function bucketAction() {
  if (!canPunch) return;
  canPunch = false;

  if (!bucketCarry) {
    const target = getTargetUnderCrosshair({ includeBust: false, includeRafts: false, maxAngleDeg: 12, maxDistance: 5, useRaycast: true });
    if (target && target.body) {
      const carryMesh = target.mesh;
      const carryBody = target.body;
      removeTargetEntry(target);
      if (carryMesh) {
        carryMesh.matrixAutoUpdate = true;
        carryMesh.updateMatrix();
      }
      bucketCarry = { mesh: carryMesh, body: carryBody };
    }
  } else {
    const carry = bucketCarry;
    bucketCarry = null;

    const forward = getCameraForward();
    const cameraPos = getCameraPosition();
    const dropPos = cameraPos.clone().add(forward.multiplyScalar(3));
    dropPos.y = Math.max(0.6, cameraPos.y - 1);

    const mesh = carry.mesh;
    const body = carry.body;

    mesh.position.copy(dropPos);
    mesh.quaternion.set(0, 0, 0, 1);
    scene.add(mesh);

    if (body.mass === 0) {
      body.mass = 4;
      body.type = CANNON.Body.DYNAMIC;
      body.updateMassProperties();
    }
    body.wakeUp();
    body.position.set(dropPos.x, dropPos.y, dropPos.z);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    world.addBody(body);

    registerSpawnedTarget(mesh, body);
  }

  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function spawnRaftEntity() {
  if (!canPunch) return;
  canPunch = false;

  if (raftEntities.length > 6) {
    const old = raftEntities.shift();
    world.removeBody(old.body);
    scene.remove(old.mesh);
  }

  const raftGeometry = new THREE.PlaneGeometry(0.8, 1.2);
  const raftMaterial = new THREE.MeshStandardMaterial({ map: raftTextures.idle, transparent: true, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide });
  const raftMesh = new THREE.Mesh(raftGeometry, raftMaterial);
  raftMesh.castShadow = false;
  raftMesh.receiveShadow = false;

  const forward = getCameraForward();
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y + 0.5, playerBody.position.z).add(forward.multiplyScalar(2.2));
  raftMesh.position.copy(spawnPos);
  raftMesh.lookAt(camera.position.x, spawnPos.y, camera.position.z);
  scene.add(raftMesh);

  const raftBody = new CANNON.Body({ mass: 10, material: new CANNON.Material('raft'), linearDamping: 0.4, angularDamping: 0.8 });
  raftBody.addShape(new CANNON.Box(new CANNON.Vec3(0.4, 0.15, 0.6)));
  raftBody.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  raftBody.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  raftBody.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.PLAYER | COLLISION_GROUPS.TARGET;
  world.addBody(raftBody);

  const dir = forward.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4)).normalize();
  raftBody.velocity.set(dir.x * 3, 0, dir.z * 3);

  const raft = { mesh: raftMesh, body: raftBody, lastSteer: performance.now(), attackTargetBody: null, state: 'idle', animTimer: 0, animFrame: 0, stateTimer: 0, lastHit: 0 };
  raftEntities.push(raft);
  setRaftTexture(raft, 'idle');
  setBodyTag(raftBody, { kind: 'raft', ref: raft });

  raftBody.addEventListener('collide', () => {
    const now = performance.now();
    if (now - raft.lastHit > 200) {
      raft.lastHit = now;
      raft.attackTargetBody = null;
      raft.stateTimer = 0;
      setRaftTexture(raft, 'attack');
    }
  });

  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function explodeBomb(bomb) {
  const explosionRadius = bomb.explosionRadius ?? 3.0;
  const explosionForce = bomb.explosionForce ?? 500;
  const bombPos = new THREE.Vector3(bomb.body.position.x, bomb.body.position.y, bomb.body.position.z);
  
  // 爆発エフェクト（視覚的）
  const explosionGeometry = new THREE.SphereGeometry(0.1, 8, 6);
  const explosionMaterial = new THREE.MeshBasicMaterial({ color: 0xff4500, transparent: true, opacity: 0.8 });
  const explosion = new THREE.Mesh(explosionGeometry, explosionMaterial);
  explosion.position.copy(bombPos);
  scene.add(explosion);
  
  gsap.to(explosion.scale, { x: 20, y: 20, z: 20, duration: 0.3, ease: 'power2.out' });
  gsap.to(explosion.material, { opacity: 0, duration: 0.3, onComplete: () => {
    scene.remove(explosion);
  }});
  
  const impulseDelayClamp = 18;

  // 全てのターゲットに爆発の影響を与える
  spawnedTargets.forEach(({ body }, index) => {
    const targetPos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
    const distance = bombPos.distanceTo(targetPos);
    
    if (distance <= explosionRadius) {
      const direction = targetPos.clone().sub(bombPos).normalize();
      const force = explosionForce * (1 - distance / explosionRadius);
      const impulse = new CANNON.Vec3(direction.x * force, direction.y * force + 5, direction.z * force);
      scheduleImpulse(body, impulse, body.position, Math.min(index * 1.5, impulseDelayClamp));
    }
  });
  
  // メインターゲットにも影響
  const targetPos = new THREE.Vector3(bustBody.position.x, bustBody.position.y, bustBody.position.z);
  const distance = bombPos.distanceTo(targetPos);
  
  if (distance <= explosionRadius) {
    const direction = targetPos.clone().sub(bombPos).normalize();
    const force = explosionForce * (1 - distance / explosionRadius);
    const impulse = new CANNON.Vec3(direction.x * force, direction.y * force + 5, direction.z * force);
    scheduleImpulse(bustBody, impulse, bustBody.position, 4);
  }

  for (let s = spawnedStructures.length - 1; s >= 0; s--) {
    const structure = spawnedStructures[s];
    if (!structure) continue;

    const combinedRadius = explosionRadius + (structure.blockSize || 0.6) * 0.6;

    if (structure.state === 'static') {
      let shouldBreak = false;
      if (structure.blockEntries && structure.blockEntries.length) {
        for (let i = 0; i < structure.blockEntries.length; i++) {
          const entry = structure.blockEntries[i];
          if (!entry || !entry.worldPos) continue;
          if (bombPos.distanceTo(entry.worldPos) <= combinedRadius) {
            shouldBreak = true;
            break;
          }
        }
      }
      if (shouldBreak) {
        breakStructure(structure, {
          computeImpulse: (blockEntry) => {
            if (!blockEntry || !blockEntry.worldPos) return null;
            const partPos = blockEntry.worldPos;
            const dist = bombPos.distanceTo(partPos);
            if (dist > combinedRadius) return null;
            const direction = partPos.clone().sub(bombPos).normalize();
            const breakForce = explosionForce * (1 - Math.min(dist / Math.max(combinedRadius, 0.0001), 1));
            return {
              vector: { x: direction.x * breakForce, y: direction.y * breakForce * 0.6 + breakForce * 0.2, z: direction.z * breakForce },
              point: { x: partPos.x, y: partPos.y, z: partPos.z },
              delayMs: Math.random() * 8,
            };
          },
        });
      }
    }

    if (!structure.parts || !structure.parts.length) continue;

    for (let p = 0; p < structure.parts.length; p++) {
      const part = structure.parts[p];
      if (!part || !part.body) continue;
      const partPos = new THREE.Vector3(part.body.position.x, part.body.position.y, part.body.position.z);
      const distanceToPart = bombPos.distanceTo(partPos);
      if (distanceToPart > combinedRadius) continue;

      const direction = partPos.clone().sub(bombPos).normalize();
      const breakForce = explosionForce * (1 - Math.min(distanceToPart / Math.max(combinedRadius, 0.0001), 1));
      const debrisMass = Math.max(0.4, (part.blockSize || structure.blockSize || 0.6) * 0.5);

      if (Math.abs(part.body.mass - debrisMass) > 0.001) {
        part.body.mass = debrisMass;
        part.body.updateMassProperties();
      }
      part.body.type = CANNON.Body.DYNAMIC;
      part.body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
      part.body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.PLAYER | COLLISION_GROUPS.TARGET | COLLISION_GROUPS.FIST;
      part.body.allowSleep = false;
      part.body.wakeUp();
      const impulse = new CANNON.Vec3(
        direction.x * breakForce,
        direction.y * breakForce * 0.6 + debrisMass * 6,
        direction.z * breakForce
      );
      scheduleImpulse(part.body, impulse, part.body.position, Math.min(p * 1.5 + Math.random() * 8, impulseDelayClamp));
    }
  }

  // 爆弾を削除
  scene.remove(bomb.mesh);
  world.removeBody(bomb.body);
  const bombIndex = bombs.indexOf(bomb);
  if (bombIndex > -1) {
    bombs.splice(bombIndex, 1);
  }
}

function stab() {
  if (!canPunch) return;
  canPunch = false;
  
  // 槍の視覚効果（長い突き）
  const startZ = handGroup.position.z;
  gsap.to(handGroup.position, { 
    z: startZ - 2.0, 
    duration: 0.15, 
    ease: 'power3.out', 
    yoyo: true, 
    repeat: 1, 
    onUpdate: syncFistBody 
  });
  
  // 槍の攻撃判定（長いリーチ）
  const spearRange = 3.5;
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  
  // プレイヤーの位置
  const playerPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z);
  
  // 全てのターゲットをチェック
  spawnedTargets.forEach(({ mesh, body }, index) => {
    const targetPos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
    const distance = playerPos.distanceTo(targetPos);
    
    if (distance <= spearRange) {
      // ターゲットに強い衝撃を与える
      const direction = targetPos.clone().sub(playerPos).normalize();
      const force = 30;
      applyImpulseClamped(body, new CANNON.Vec3(direction.x * force, direction.y * force + 10, direction.z * force), body.position);
      
      // 視覚的フィードバック
      gsap.to(mesh.material, { emissiveIntensity: 0.8, duration: 0.1, yoyo: true, repeat: 1, onStart: () => { 
        mesh.material.emissive = new THREE.Color(0xff0000); 
      }, onComplete: () => { 
        mesh.material.emissiveIntensity = 0; 
      }});
    }
  });
  
  // メインターゲットもチェック
  const targetPos = new THREE.Vector3(bustBody.position.x, bustBody.position.y, bustBody.position.z);
  const distance = playerPos.distanceTo(targetPos);
  
  if (distance <= spearRange) {
    const direction = targetPos.clone().sub(playerPos).normalize();
    const force = 30;
    applyImpulseClamped(bustBody, new CANNON.Vec3(direction.x * force, direction.y * force + 10, direction.z * force), bustBody.position);
    
    // 視覚的フィードバック
    gsap.to(targetMesh.material, { emissiveIntensity: 0.8, duration: 0.1, yoyo: true, repeat: 1, onStart: () => { 
      targetMesh.material.emissive = new THREE.Color(0xff0000); 
    }, onComplete: () => { 
      targetMesh.material.emissiveIntensity = 0; 
    }});
  }
  
  // クールダウン
  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function activateGravity() {
  if (!canPunch) return;
  canPunch = false;
  
  // 重力を強くする
  setWorldGravity(0, -50, 0);
  antiGravityActive = false;
  
  // 全てのターゲットを地面に押し付ける
  spawnedTargets.forEach(({ body }) => {
    body.velocity.y = -20;
    body.applyForce(new CANNON.Vec3(0, -100, 0), body.position);
  });
  
  bustBody.velocity.y = -20;
  bustBody.applyForce(new CANNON.Vec3(0, -100, 0), bustBody.position);
  
  // 3秒後に重力を元に戻す
  setTimeout(() => {
    restoreDefaultGravity();
  }, 3000);
  
  // クールダウン
  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function blast() {
  if (!canPunch) return;
  canPunch = false;
  
  // 視界内の全てのターゲットを吹っ飛ばす
  const forward = new THREE.Vector3(-Math.sin(yaw), Math.sin(pitch), -Math.cos(yaw)); // pitchの符号を反転
  const cameraPos = new THREE.Vector3(
    playerRig.position.x,
    playerRig.position.y + 0.8, // 1.7から0.8に下げる
    playerRig.position.z
  );
  
  spawnedTargets.forEach(({ mesh, body }) => {
    const targetPos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
    const direction = targetPos.clone().sub(cameraPos).normalize();
    
    // 視界内かチェック（前方120度以内）
    const dot = forward.dot(direction);
    if (dot > -0.5) { // 120度以内
      const force = 40;
      applyImpulseClamped(body, new CANNON.Vec3(direction.x * force, direction.y * force + 15, direction.z * force), body.position);
    }
  });
  
  // メインターゲットもチェック
  const targetPos = new THREE.Vector3(bustBody.position.x, bustBody.position.y, bustBody.position.z);
  const direction = targetPos.clone().sub(cameraPos).normalize();
  const dot = forward.dot(direction);
  
  if (dot > -0.5) {
    const force = 40;
    applyImpulseClamped(bustBody, new CANNON.Vec3(direction.x * force, direction.y * force + 15, direction.z * force), bustBody.position);
  }
  
  // クールダウン
  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

function magnet() {
  if (!canPunch) return;
  canPunch = false;
  
  // Clear any previous pending impulses before enqueueing new ones
  magnetImpulseQueue.length = 0;
  magnetImpulseMap.clear();

  const forward = getCameraForward();
  const cameraSnapshot = getCameraPosition();

  const queueTargetBody = (body) => {
    if (!body) return;
    const bodyPos = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
    const direction = bodyPos.clone().sub(cameraSnapshot).normalize();
    const dot = forward.dot(direction);
    if (dot > -0.5) {
      queueMagnetImpulse(body, 30, cameraSnapshot);
    }
  };

  for (let i = 0; i < spawnedTargets.length; i++) {
    const target = spawnedTargets[i];
    if (!target || !target.body) continue;
    queueTargetBody(target.body);
  }

  queueTargetBody(bustBody);
  
  // クールダウン
  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
}

// 初期選択を設定
selectSlot(0);
updateSlotAppearance();
customStructureSlots.forEach((slot) => loadStructureSlot(slot));
function buildBendingPole(baseVec3, targetBottomVec3) {
  // Quadratic Bezier: base -> control -> targetBottom
  const base = baseVec3.clone();
  const end = targetBottomVec3.clone();
  const mid = base.clone().add(end).multiplyScalar(0.5);
  const lateral = end.clone().sub(base);
  lateral.y = 0; // bend primarily in horizontal plane
  const bendAmount = Math.min(0.8, lateral.length() / Math.max(0.0001, poleHeight)) * 0.6;
  const control = mid.add(lateral.normalize().multiplyScalar(poleHeight * bendAmount));

  const curve = new THREE.QuadraticBezierCurve3(base, control, end);
  const tubularSegments = 12;
  const radius = poleRadius;
  const radialSegments = 6;
  const closed = false;
  const geom = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, closed);
  if (poleMesh.geometry) poleMesh.geometry.dispose();
  poleMesh.geometry = geom;
}

// Target visual
const targetMesh = new THREE.Mesh(new THREE.BoxGeometry(boxSize.x, boxSize.y, boxSize.z), targetMat);
targetMesh.position.set(0, poleHeight + boxSize.y / 2, -2);
targetMesh.castShadow = true;
targetMesh.receiveShadow = true;
scene.add(targetMesh);

updateQualitySetting(renderSettings.quality);

// Target physics body
const bustBody = new CANNON.Body({ mass: bustParams.mass, material: bustPhysicsMaterial, linearDamping: 0.12, angularDamping: 0.12, allowSleep: false });
const targetShape = new CANNON.Box(new CANNON.Vec3(boxSize.x/2, boxSize.y/2, boxSize.z/2));
bustBody.addShape(targetShape);
bustBody.position.set(0, poleHeight + boxSize.y / 2, -2);
bustBody.collisionFilterGroup = COLLISION_GROUPS.TARGET;
bustBody.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
world.addBody(bustBody);
bustBody.wakeUp();
setBodyTag(bustBody, { kind: 'bust' });

// Additional spawned targets (standalone cubes)
const magnetImpulseQueue = [];
const magnetImpulseMap = new Map();
const MAGNET_BATCH_PER_FRAME = 24;
const MAGNET_MAX_QUEUE = 4096;
const lodGeometryCache = new Map();
const LOD_MIN_VERTEX_COUNT = 200;

function queueMagnetImpulse(body, force, cameraPos) {
  if (!body || !body.world) return;
  let task = magnetImpulseMap.get(body);
  if (task) {
    task.force = Math.max(task.force, force);
    task.cameraPos.copy(cameraPos);
    return;
  }
  if (magnetImpulseQueue.length >= MAGNET_MAX_QUEUE) {
    const removed = magnetImpulseQueue.shift();
    if (removed && removed.body) magnetImpulseMap.delete(removed.body);
  }
  task = { body, force, cameraPos: cameraPos.clone() };
  magnetImpulseMap.set(body, task);
  magnetImpulseQueue.push(task);
}

function processMagnetQueue() {
  if (!magnetImpulseQueue.length) return;
  const batch = Math.min(MAGNET_BATCH_PER_FRAME, magnetImpulseQueue.length);
  for (let i = 0; i < batch; i++) {
    const task = magnetImpulseQueue.shift();
    if (!task) continue;
    magnetImpulseMap.delete(task.body);
    if (!task.body || !task.body.world) continue;
    const currentPos = new THREE.Vector3(task.body.position.x, task.body.position.y, task.body.position.z);
    const pull = task.cameraPos.clone().sub(currentPos);
    const lengthSq = pull.lengthSq();
    if (lengthSq < 1e-6) continue;
    pull.normalize();
    const impulse = new CANNON.Vec3(pull.x * task.force, pull.y * task.force, pull.z * task.force);
    if (typeof task.body.wakeUp === 'function') task.body.wakeUp();
    applyImpulseClamped(task.body, impulse, task.body.position);
  }
}

function getBoxGeometry(width, height, depth) {
  const w = Math.max(width, 0.05);
  const h = Math.max(height, 0.05);
  const d = Math.max(depth, 0.05);
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  if (!lodGeometryCache.has(key)) {
    lodGeometryCache.set(key, new THREE.BoxGeometry(w, h, d));
  }
  return lodGeometryCache.get(key);
}

function setupTargetLOD(mesh, { threshold = 18 } = {}) {
  if (!mesh) return null;
  let lod = null;
  if (mesh.isMesh) {
    const geometry = mesh.geometry;
    if (!geometry) return null;
    const positionAttr = geometry.getAttribute && geometry.getAttribute('position');
    const vertexCount = positionAttr ? positionAttr.count : 0;
    if (vertexCount <= LOD_MIN_VERTEX_COUNT) return null;
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox;
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const lowGeometry = getBoxGeometry(size.x || 0.3, size.y || 0.3, size.z || 0.3);
    lod = {
      type: 'mesh',
      mesh,
      highGeometry: geometry,
      lowGeometry,
      state: 'high',
      threshold,
    };
  } else if (mesh.isGroup) {
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const placeholderGeometry = getBoxGeometry(size.x || 0.6, size.y || 0.6, size.z || 0.6);
    const placeholderMaterial = new THREE.MeshBasicMaterial({ color: 0x666666, wireframe: true });
    const placeholder = new THREE.Mesh(placeholderGeometry, placeholderMaterial);
    placeholder.visible = false;
    placeholder.position.copy(mesh.position);
    placeholder.quaternion.copy(mesh.quaternion);
    placeholder.matrixAutoUpdate = true;
    if (mesh.parent) {
      mesh.parent.add(placeholder);
    } else {
      scene.add(placeholder);
    }
    lod = {
      type: 'group',
      mesh,
      placeholder,
      state: 'high',
      threshold,
    };
  }
  return lod;
}

function updateTargetLOD(cameraPos) {
  for (let i = 0; i < spawnedTargets.length; i++) {
    const entry = spawnedTargets[i];
    if (!entry || !entry.lod || !entry.body) continue;
    const lod = entry.lod;
    const distance = cameraPos.distanceTo(new THREE.Vector3(entry.body.position.x, entry.body.position.y, entry.body.position.z));
    const desiredState = distance > lod.threshold ? 'low' : 'high';
    if (lod.type === 'mesh') {
      if (desiredState === 'low' && lod.state !== 'low') {
        entry.mesh.geometry = lod.lowGeometry;
        if (!entry.mesh.geometry.boundingSphere) entry.mesh.geometry.computeBoundingSphere();
        if (!entry.mesh.geometry.boundingBox) entry.mesh.geometry.computeBoundingBox();
      } else if (desiredState === 'high' && lod.state !== 'high') {
        entry.mesh.geometry = lod.highGeometry;
        if (!entry.mesh.geometry.boundingSphere) entry.mesh.geometry.computeBoundingSphere();
        if (!entry.mesh.geometry.boundingBox) entry.mesh.geometry.computeBoundingBox();
      }
    } else if (lod.type === 'group' && lod.placeholder) {
      if (desiredState === 'low' && lod.state !== 'low') {
        lod.placeholder.visible = true;
        entry.mesh.visible = false;
      } else if (desiredState === 'high' && lod.state !== 'high') {
        lod.placeholder.visible = false;
        entry.mesh.visible = true;
      }
      if (lod.placeholder.visible) {
        lod.placeholder.position.set(entry.body.position.x, entry.body.position.y, entry.body.position.z);
        lod.placeholder.quaternion.set(entry.mesh.quaternion.x, entry.mesh.quaternion.y, entry.mesh.quaternion.z, entry.mesh.quaternion.w);
      }
    }
    lod.state = desiredState;
  }
}
// Persistent settings (unique app namespace)
const STORAGE_KEY = 'iza-tako-3d-punch-v1';
const defaultSettings = {
  punchStrength: 8,
  targets: {
    cube: { size: 0.6, mass: 6, color: 0xffa9a9 },
    pyramid: { size: 0.7, mass: 6, color: 0xffd27f },
    sphere: { radius: 0.35, mass: 5.5, color: 0x7fd2ff },
  },
};
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(defaultSettings));
    const parsed = JSON.parse(raw);
    return Object.assign({}, defaultSettings, parsed, {
      targets: Object.assign({}, defaultSettings.targets, parsed.targets || {}),
    });
  } catch (_) {
    return JSON.parse(JSON.stringify(defaultSettings));
  }
}
function saveSettings() {
  settings.punchStrength = controls.punchStrength;
  settings.fistSizeX = controls.fistSizeX;
  settings.fistSizeY = controls.fistSizeY;
  settings.fistSizeZ = controls.fistSizeZ;
  const ensureHex = (val) => (val && typeof val.getHex === 'function') ? val.getHex() : val;
  settings.targets.cube.color = ensureHex(settings.targets.cube.color);
  settings.targets.pyramid.color = ensureHex(settings.targets.pyramid.color);
  settings.targets.sphere.color = ensureHex(settings.targets.sphere.color);
  settings.targets.cube.size = settings.targets.cube.size;
  settings.targets.pyramid.size = settings.targets.pyramid.size;
  settings.targets.sphere.radius = settings.targets.sphere.radius;
  settings.targets.cube.mass = settings.targets.cube.mass;
  settings.targets.pyramid.mass = settings.targets.pyramid.mass;
  settings.targets.sphere.mass = settings.targets.sphere.mass;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (_) {}
}
let settings = loadSettings();
// Apply persisted fist size if available
if (typeof settings.fistSizeX === 'number' && typeof settings.fistSizeY === 'number' && typeof settings.fistSizeZ === 'number') {
  fistSize = { x: settings.fistSizeX, y: settings.fistSizeY, z: settings.fistSizeZ };
  const newGeom = new THREE.BoxGeometry(fistSize.x, fistSize.y, fistSize.z);
  fist.geometry.dispose();
  fist.geometry = newGeom;
}
function spawnCubeTarget() {
  const size = settings.targets.cube.size;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ color: settings.targets.cube.color, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Spawn in front of player
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.6));
  spawnPos.y = 0.8;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: settings.targets.cube.mass, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Box(new CANNON.Vec3(size/2, size/2, size/2)));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER; // avoid player sticking
  world.addBody(body);
  // Nudge to avoid immediate sleep and ensure activation
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body, { lodOptions: { threshold: 24 } });
}

function spawnPyramidTarget() {
  const size = settings.targets.pyramid.size;
  // Create a pyramid (tetra-like) using ConeGeometry with fewer segments
  const geom = new THREE.ConeGeometry(size * 0.6, size, 4);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: settings.targets.pyramid.color, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: settings.targets.pyramid.mass, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  // Approximate pyramid with a box for stability
  body.addShape(new CANNON.Box(new CANNON.Vec3(size*0.35, size*0.5, size*0.35)));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body, { lodOptions: { threshold: 24 } });
}

function spawnSphereTarget() {
  const radius = settings.targets.sphere.radius;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), new THREE.MeshStandardMaterial({ color: settings.targets.sphere.color, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: settings.targets.sphere.mass, material: bustPhysicsMaterial, linearDamping: 0.08, angularDamping: 0.08, allowSleep: false });
  body.addShape(new CANNON.Sphere(radius));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body, { lodOptions: { threshold: 24 } });
}

function spawnCylinderTarget() {
  const radius = 0.3;
  const height = 0.8;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 12), new THREE.MeshStandardMaterial({ color: 0xff6b6b, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 6, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Cylinder(radius, radius, height/2, 8));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body, { lodOptions: { threshold: 24 } });
}

function spawnConeTarget() {
  const radius = 0.4;
  const height = 0.8;
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(radius, height, 8), new THREE.MeshStandardMaterial({ color: 0x4ecdc4, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 5.5, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Cylinder(0, radius, height/2, 8));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body);
}

function spawnTorusTarget() {
  const radius = 0.3;
  const tube = 0.1;
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 16), new THREE.MeshStandardMaterial({ color: 0x45b7d1, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 4, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Sphere(radius));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body);
}

function spawnOctahedronTarget() {
  const radius = 0.4;
  const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(radius), new THREE.MeshStandardMaterial({ color: 0x96ceb4, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 5, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Sphere(radius * 0.8));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body);
}

function spawnTetrahedronTarget() {
  const radius = 0.4;
  const mesh = new THREE.Mesh(new THREE.TetrahedronGeometry(radius), new THREE.MeshStandardMaterial({ color: 0xfeca57, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 4.5, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Sphere(radius * 0.7));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body);
}

function spawnDodecahedronTarget() {
  const radius = 0.35;
  const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(radius), new THREE.MeshStandardMaterial({ color: 0xff9ff3, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 5.5, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Sphere(radius * 0.9));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body);
}

function spawnPrismTarget() {
  const height = 1.0;
  const radius = 0.35;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 3), new THREE.MeshStandardMaterial({ color: 0xffb74d, roughness: 0.55 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.rotation.y = Math.PI / 6;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.95;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 6, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Box(new CANNON.Vec3(radius, height / 2, radius)));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.02, 0.01);
  body.angularVelocity.set(0.1, 0.1, 0.1);
  body.wakeUp();

  registerSpawnedTarget(mesh, body);
}

function spawnIcosahedronTarget() {
  const radius = 0.45;
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 0), new THREE.MeshStandardMaterial({ color: 0x64b5f6, roughness: 0.5 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.9));
  spawnPos.y = 0.9;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 6, material: bustPhysicsMaterial, linearDamping: 0.09, angularDamping: 0.09, allowSleep: false });
  body.addShape(new CANNON.Sphere(radius * 0.9));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.02, -0.02, 0.02);
  body.angularVelocity.set(0.15, 0.15, 0.15);
  body.wakeUp();

  registerSpawnedTarget(mesh, body);
}

function spawnCapsuleTarget() {
  const radius = 0.22;
  const length = 0.7;
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 12, 24), new THREE.MeshStandardMaterial({ color: 0xff8a65, roughness: 0.45 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.rotation.z = Math.PI / 4;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.9));
  spawnPos.y = 0.95;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 6.5, material: bustPhysicsMaterial, linearDamping: 0.12, angularDamping: 0.12, allowSleep: false });
  body.addShape(new CANNON.Box(new CANNON.Vec3(radius + 0.05, (length + radius * 2) / 2, radius + 0.05)));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.015, 0.01);
  body.angularVelocity.set(0.2, 0.05, 0.2);
  body.wakeUp();

  registerSpawnedTarget(mesh, body);
}

function spawnTorusKnotTarget() {
  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.35, 0.09, 80, 12), new THREE.MeshStandardMaterial({ color: 0xba68c8, roughness: 0.4, metalness: 0.2 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.7));
  spawnPos.y = 0.85;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 5.5, material: bustPhysicsMaterial, linearDamping: 0.08, angularDamping: 0.08, allowSleep: false });
  body.addShape(new CANNON.Sphere(0.4));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.015, -0.02, 0.015);
  body.angularVelocity.set(0.35, 0.35, 0.35);
  body.wakeUp();

  registerSpawnedTarget(mesh, body);
}

function spawnTwinOrbTarget() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x4dd0e1, roughness: 0.45 });
  const orbA = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), material);
  const orbB = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), material);
  const connector = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.6, 12), material);
  orbA.position.set(-0.18, 0, 0);
  orbB.position.set(0.18, 0, 0);
  connector.rotation.z = Math.PI / 2;
  orbA.castShadow = orbA.receiveShadow = true;
  orbB.castShadow = orbB.receiveShadow = true;
  connector.castShadow = connector.receiveShadow = true;
  group.add(orbA);
  group.add(orbB);
  group.add(connector);
  group.castShadow = true;
  group.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  group.position.copy(spawnPos);
  scene.add(group);

  const body = new CANNON.Body({ mass: 5, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.35, 0.25, 0.25)));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0, -0.015, 0);
  body.angularVelocity.set(0, 0.25, 0);
  body.wakeUp();

  registerSpawnedTarget(group, body, { lodOptions: { threshold: 24 } });
}

function spawnRingStackTarget() {
  const group = new THREE.Group();
  const colors = [0xffd54f, 0xffa726, 0xff7043];
  for (let i = 0; i < 3; i++) {
    const torus = new THREE.Mesh(new THREE.TorusGeometry(0.35 - i * 0.04, 0.065, 12, 32), new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.5 }));
    torus.rotation.x = Math.PI / 2;
    torus.position.y = i * 0.08;
    torus.castShadow = true;
    torus.receiveShadow = true;
    group.add(torus);
  }
  group.castShadow = true;
  group.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.7));
  spawnPos.y = 0.82;
  group.position.copy(spawnPos);
  scene.add(group);

  const body = new CANNON.Body({ mass: 5.5, material: bustPhysicsMaterial, linearDamping: 0.08, angularDamping: 0.08, allowSleep: false });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.4, 0.15, 0.4))); 
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.005, -0.02, 0.005);
  body.angularVelocity.set(0.2, 0.2, 0.2);
  body.wakeUp();

  registerSpawnedTarget(group, body, { lodOptions: { threshold: 26 } });
}

function spawnCrossTarget() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x9ccc65, roughness: 0.5 });
  const bar1 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.18, 0.18), material);
  const bar2 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), material);
  const bar3 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.8), material);
  bar1.castShadow = bar1.receiveShadow = true;
  bar2.castShadow = bar2.receiveShadow = true;
  bar3.castShadow = bar3.receiveShadow = true;
  group.add(bar1);
  group.add(bar2);
  group.add(bar3);
  group.castShadow = true;
  group.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  group.position.copy(spawnPos);
  scene.add(group);

  const body = new CANNON.Body({ mass: 5.5, material: bustPhysicsMaterial, linearDamping: 0.1, angularDamping: 0.1, allowSleep: false });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.4, 0.4, 0.4)));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.01, -0.015, 0.01);
  body.angularVelocity.set(0.2, 0.15, 0.1);
  body.wakeUp();

  registerSpawnedTarget(group, body, { lodOptions: { threshold: 26 } });
}

function spawnDiskTarget() {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.18, 32), new THREE.MeshStandardMaterial({ color: 0x90caf9, roughness: 0.4 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.rotation.x = Math.PI / 2;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.9));
  spawnPos.y = 0.75;
  mesh.position.copy(spawnPos);
  scene.add(mesh);

  const body = new CANNON.Body({ mass: 4.8, material: bustPhysicsMaterial, linearDamping: 0.07, angularDamping: 0.07, allowSleep: false });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.55, 0.1, 0.55)));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.005, -0.02, 0.005);
  body.angularVelocity.set(0, 0, 0.25);
  body.wakeUp();

  registerSpawnedTarget(mesh, body, { lodOptions: { threshold: 26 } });
}

function spawnClusterTarget() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0xce93d8, roughness: 0.6 });
  for (let i = 0; i < 5; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), material);
    box.position.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.3) * 0.6, (Math.random() - 0.5) * 0.5);
    box.castShadow = box.receiveShadow = true;
    group.add(box);
  }
  group.castShadow = true;
  group.receiveShadow = true;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const spawnPos = new THREE.Vector3(playerBody.position.x, playerBody.position.y, playerBody.position.z)
    .add(forward.multiplyScalar(1.8));
  spawnPos.y = 0.9;
  group.position.copy(spawnPos);
  scene.add(group);

  const body = new CANNON.Body({ mass: 5.2, material: bustPhysicsMaterial, linearDamping: 0.12, angularDamping: 0.12, allowSleep: false });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.4, 0.4, 0.4)));
  body.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
  body.collisionFilterGroup = COLLISION_GROUPS.TARGET;
  body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.FIST | COLLISION_GROUPS.PLAYER;
  world.addBody(body);
  body.velocity.set(0.015, -0.02, 0.015);
  body.angularVelocity.set(0.25, 0.18, 0.22);
  body.wakeUp();

  registerSpawnedTarget(group, body, { lodOptions: { threshold: 28 } });
}

// Base anchor at ground for spring
const poleBaseBody = new CANNON.Body({ mass: 0 });
poleBaseBody.addShape(new CANNON.Sphere(0.02));
poleBaseBody.position.set(0, 0, -2);
poleBaseBody.collisionFilterGroup = COLLISION_GROUPS.GROUND;
poleBaseBody.collisionFilterMask = 0;
world.addBody(poleBaseBody);

// Soft spring connecting base to target bottom
const softSpring = new CANNON.Spring(bustBody, poleBaseBody, {
  restLength: poleHeight,
  stiffness: 1000,
  damping: 1,
  localAnchorA: new CANNON.Vec3(0, -boxSize.y / 2, 0),
  localAnchorB: new CANNON.Vec3(0, 0, 0),
});

function syncBust() {
  const q = bustBody.quaternion;
  const p = bustBody.position;
  targetMesh.position.set(p.x, p.y, p.z);
  targetMesh.quaternion.set(q.x, q.y, q.z, q.w);
  // Update pole visual to bend between base and target bottom
  const base = new THREE.Vector3(poleBaseBody.position.x, poleBaseBody.position.y, poleBaseBody.position.z);
  const targetBottom = new THREE.Vector3(p.x, p.y - boxSize.y / 2, p.z);
  buildBendingPole(base, targetBottom);
}

// Upright orientation spring (rubber-like return to default vertical)
const orientSpring = { stiffness: 130, damping: 50 };
function applyUprightTorque() {
  const worldUp = new CANNON.Vec3(0, 1, 0);
  const bodyUp = new CANNON.Vec3(0, 1, 0);
  // Convert local up to world
  bustBody.vectorToWorldFrame(bodyUp, bodyUp);

  // Axis to rotate bodyUp toward worldUp
  const axis = bodyUp.cross(worldUp);
  const dot = Math.max(-1, Math.min(1, bodyUp.dot(worldUp)));
  const angle = Math.acos(dot);
  if (angle > 1e-3 && axis.lengthSquared() > 1e-8) {
    axis.normalize();
    const torqueMag = orientSpring.stiffness * angle;
    const damping = bustBody.angularVelocity.scale(orientSpring.damping);
    const torque = axis.scale(torqueMag).vsub(damping);
    bustBody.torque.vadd(torque, bustBody.torque);
  } else {
    // Light damping when nearly upright
    const dampingOnly = bustBody.angularVelocity.scale(orientSpring.damping * 0.5);
    bustBody.torque.vsub(dampingOnly, bustBody.torque);
  }
}

// Player kinematic body (capsule)
let groundedTimer = 0;

const playerBody = new CANNON.Body({ mass: 75, material: new CANNON.Material('player'), fixedRotation: true, allowSleep: false });
playerBody.addShape(new CANNON.Cylinder(0.3, 0.3, 1.0, 8));
playerBody.position.set(0, 1.2, 4);
playerBody.linearDamping = 0.2;
playerBody.collisionFilterGroup = COLLISION_GROUPS.PLAYER;
playerBody.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.TARGET;
world.addBody(playerBody);
playerBody.addEventListener('collide', (event) => {
  const other = event.body;
  const group = other.collisionFilterGroup;
  if ((group & COLLISION_GROUPS.GROUND) || (group & COLLISION_GROUPS.TARGET)) {
    groundedTimer = 0.25;
  }
});

function isPlayerGrounded() {
  const up = new CANNON.Vec3(0, 1, 0);
  const contacts = world.contacts;
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    if (contact.bi === playerBody || contact.bj === playerBody) {
      const contactNormal = new CANNON.Vec3();
      contactNormal.copy(contact.ni);
      if (contact.bi === playerBody) {
        contactNormal.scale(-1, contactNormal);
      }
      if (contactNormal.dot(up) > 0.4) {
        groundedTimer = 0.1;
        return true;
      }
    }
  }

  if (groundedTimer > 0) return true;

  // fallback when event missed: check height and downward velocity near ground level or structures
  for (let i = 0; i < spawnedTargets.length; i++) {
    const target = spawnedTargets[i];
    if (!target.body) continue;
    const dy = playerBody.position.y - target.body.position.y;
    if (dy >= 0 && dy <= 0.8) {
      const dx = Math.abs(playerBody.position.x - target.body.position.x);
      const dz = Math.abs(playerBody.position.z - target.body.position.z);
      if (dx <= 0.8 && dz <= 0.8) {
        groundedTimer = 0.1;
        return true;
      }
    }
  }

  for (let s = 0; s < spawnedStructures.length; s++) {
    const structure = spawnedStructures[s];
    for (let p = 0; p < structure.parts.length; p++) {
      const part = structure.parts[p];
      if (!part.body) continue;
      const dy = playerBody.position.y - part.body.position.y;
      if (dy >= 0 && dy <= 0.8) {
        const dx = Math.abs(playerBody.position.x - part.body.position.x);
        const dz = Math.abs(playerBody.position.z - part.body.position.z);
        if (dx <= 0.8 && dz <= 0.8) {
          groundedTimer = 0.1;
          return true;
        }
      }
    }
  }

  if (playerBody.position.y <= 0.55 && playerBody.velocity.y <= 0.1) {
    groundedTimer = 0.05;
    return true;
  }

  return false;
}

// スタート時に物理演算を正常化するための重力制御
function initializePhysics() {
  // 重力を一時的に強化して物理演算を起動
  setWorldGravity(0, -50, 0);
  
  // プレイヤーを地面に配置
  playerBody.position.set(0, 1.2, 4);
  playerBody.velocity.set(0, 0, 0);
  playerBody.angularVelocity.set(0, 0, 0);
  playerBody.wakeUp();
  
  // メインターゲットを正しい位置に配置
  bustBody.position.set(0, poleHeight + boxSize.y / 2, -2);
  bustBody.velocity.set(0, 0, 0);
  bustBody.angularVelocity.set(0, 0, 0);
  bustBody.wakeUp();
  
  // 地面ボディも確実に起動
  groundBody.wakeUp();

  groundedTimer = 0.1;

  // 0.5秒後に重力を元に戻す
  setTimeout(() => {
    restoreDefaultGravity();
  }, 500);
}

// 物理演算を初期化
initializePhysics();

// Fist visual and kinematic collider
const handGroup = new THREE.Group();
handGroup.position.set(0.35, -0.25, -0.6); // relative to camera
camera.add(handGroup);

// Fist defaults
let fistSize = { x: 0.18, y: 0.12, z: 0.22 };
fist = new THREE.Mesh(new THREE.BoxGeometry(fistSize.x, fistSize.y, fistSize.z), new THREE.MeshStandardMaterial({ color: 0xffd4a3, roughness: 0.6 }));
fist.castShadow = true;
handGroup.add(fist);

const fistBody = new CANNON.Body({ mass: 0, material: fistPhysicsMaterial });
fistBody.collisionFilterGroup = COLLISION_GROUPS.FIST;
fistBody.collisionFilterMask = COLLISION_GROUPS.TARGET; // collide only with target
fistBody.addShape(new CANNON.Box(new CANNON.Vec3(fistSize.x/2, fistSize.y/2, fistSize.z/2)));
world.addBody(fistBody);
// Make fist kinematic so moving collider registers contacts properly
fistBody.type = CANNON.Body.KINEMATIC;

// Controls: pointer lock look + WASD
const keys = new Set();
let yaw = 0;
let pitch = 0;
const lookSpeed = 0.0025;

function lockPointer(ev) {
  if (isTouchDevice) return;
  try {
    const target = (ev && ev.currentTarget && ev.currentTarget.requestPointerLock) ? ev.currentTarget : renderer.domElement;
    target.requestPointerLock();
  } catch (err) {
    if (renderer.domElement.requestFullscreen) {
      renderer.domElement.requestFullscreen().then(() => {
        renderer.domElement.requestPointerLock();
      }).catch(() => {
        // ignore
      });
    }
  }
}

if (!isTouchDevice) {
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === renderer.domElement;
    if (lockBtn) lockBtn.style.display = locked ? 'none' : 'inline-flex';
  });

  if (lockBtn) lockBtn.addEventListener('click', lockPointer);
  renderer.domElement.addEventListener('click', lockPointer);
  document.addEventListener('pointerlockerror', () => {
    if (lockBtn) lockBtn.style.display = 'inline-flex';
  });
} else if (lockBtn) {
  lockBtn.style.display = 'none';
}

if (loadStructuresBtn && structuresDirInput) {
  loadStructuresBtn.addEventListener('click', () => {
    structuresDirInput.click();
  });
  structuresDirInput.addEventListener('change', (event) => {
    loadStructuresFromFiles(event.target.files);
  });
}

document.addEventListener('mousemove', (e) => {
  if (isTouchDevice) return;
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * lookSpeed;
  pitch -= e.movementY * lookSpeed;
  pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
});

function setupTouchControls() {
  if (!isTouchDevice) return;

  const resetMoveInput = () => {
    touchMoveInput.x = 0;
    touchMoveInput.y = 0;
    touchMoveInput.strength = 0;
    movePointerId = null;
    if (moveStickThumb) moveStickThumb.style.transform = 'translate(0, 0)';
  };

  if (moveStick) {
    const updateMoveInput = (event) => {
      const rect = moveStick.getBoundingClientRect();
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
      if (moveStickThumb) {
        const radius = rect.width / 2;
        moveStickThumb.style.transform = `translate(${dx * radius * 0.45}px, ${dy * radius * 0.45}px)`;
      }
      playerBody.wakeUp();
    };

    moveStick.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (movePointerId !== null) return;
      movePointerId = event.pointerId;
      moveStick.setPointerCapture(event.pointerId);
      updateMoveInput(event);
    });

    moveStick.addEventListener('pointermove', (event) => {
      if (event.pointerId !== movePointerId) return;
      event.preventDefault();
      updateMoveInput(event);
    });

    const endMove = (event) => {
      if (event.pointerId !== movePointerId) return;
      event.preventDefault();
      resetMoveInput();
    };

    moveStick.addEventListener('pointerup', endMove);
    moveStick.addEventListener('pointercancel', endMove);
    moveStick.addEventListener('lostpointercapture', () => {
      resetMoveInput();
    });
  }

  if (lookPad) {
    lookPad.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (touchLookState.pointerId !== null) return;
      touchLookState.pointerId = event.pointerId;
      touchLookState.lastX = event.clientX;
      touchLookState.lastY = event.clientY;
      lookPad.setPointerCapture(event.pointerId);
    });

    lookPad.addEventListener('pointermove', (event) => {
      if (event.pointerId !== touchLookState.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - touchLookState.lastX;
      const dy = event.clientY - touchLookState.lastY;
      touchLookState.lastX = event.clientX;
      touchLookState.lastY = event.clientY;
      yaw -= dx * TOUCH_LOOK_SPEED;
      pitch -= dy * TOUCH_LOOK_SPEED;
      pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
    });

    const endLook = (event) => {
      if (event.pointerId !== touchLookState.pointerId) return;
      event.preventDefault();
      touchLookState.pointerId = null;
    };

    lookPad.addEventListener('pointerup', endLook);
    lookPad.addEventListener('pointercancel', endLook);
    lookPad.addEventListener('lostpointercapture', endLook);
  }

  if (jumpBtn) {
    jumpBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handleJumpInput();
      playerBody.wakeUp();
    });
  }

  if (dashBtn) {
    dashBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      keys.add('ShiftLeft');
      playerBody.wakeUp();
    });
    const releaseDash = (event) => {
      event.preventDefault();
      keys.delete('ShiftLeft');
    };
    dashBtn.addEventListener('pointerup', releaseDash);
    dashBtn.addEventListener('pointercancel', releaseDash);
    dashBtn.addEventListener('pointerleave', releaseDash);
  }

  if (actionBtn) {
    actionBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      performPrimaryAction();
      playerBody.wakeUp();
    });
  }

  if (modeBtn) {
    modeBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      cycleMode(1);
    });
  }

  if (altActionBtn) {
    altActionBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handleSecondaryActionToggle();
    });
  }

  if (slotPrevBtn) {
    slotPrevBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      selectSlotRelative(-1);
    });
  }

  if (slotNextBtn) {
    slotNextBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      selectSlotRelative(1);
    });
  }
}

setupTouchControls();

function performPrimaryAction() {
  if (currentMode === 'attack') {
    executeWeaponAction();
  } else if (currentMode === 'spawn') {
    spawnSelectedObject();
  } else if (currentMode === 'structure') {
    const result = spawnStructureFromIndex(selectedSlotIndex);
    if (result === false) {
      const slot = customStructureSlots[selectedSlotIndex];
      console.warn(`選択されたスロットに建造物が設定されていません。${structureSlotHint(slot)} を確認してください。`);
    }
  }
}

function handleJumpInput() {
  if (creativeMode) {
    playerBody.velocity.y = 15;
  } else if (isPlayerGrounded()) {
    playerBody.velocity.y = jumpSpeed;
    groundedTimer = 0;
  }
}

function handleSecondaryActionToggle() {
  if (currentMode === 'attack') {
    attackPage = (attackPage + 1) % 2;
    currentWeapon = getAttackWeapon(selectedSlotIndex);
    creativeMode = currentWeapon.action === 'fly';
    if (currentWeaponMesh) {
      handGroup.remove(currentWeaponMesh);
      currentWeaponMesh = null;
    }
    if (currentWeapon.action !== 'antiGravity' && antiGravityActive) {
      restoreDefaultGravity();
    }
    createWeaponMesh(currentWeapon.name);
    updateSlotAppearance();
  } else if (currentMode === 'spawn' && spawnPages.length > 0) {
    spawnPage = (spawnPage + 1) % spawnPages.length;
    updateSlotAppearance();
  }
}

document.addEventListener('keydown', (e) => {
  keys.add(e.code);
  playerBody.wakeUp();
  if (e.code === 'Space') {
    handleJumpInput();
  } else if (e.code === 'KeyR') {
    // Rキーでモードを順番に切り替え
    cycleMode(1);
  } else if (e.code === 'KeyT') {
    handleSecondaryActionToggle();
  } else if (e.code === 'KeyC') {
    if (raftEntities.length) {
      const target = getTargetUnderCrosshair({ includeBust: false, includeRafts: false, maxAngleDeg: 15 });
      if (target && target.body) {
        const body = target.body;
        raftEntities.forEach((raft) => {
          raft.attackTargetBody = body;
          raft.lastSteer = performance.now();
        });
      }
    }
  } else if (e.code === 'Enter') {
    if (currentMode === 'spawn' || currentMode === 'structure') {
      performPrimaryAction();
    }
  } else if (e.code === 'Digit1') {
    selectSlot(0);
  } else if (e.code === 'Digit2') {
    selectSlot(1);
  } else if (e.code === 'Digit3') {
    selectSlot(2);
  } else if (e.code === 'Digit4') {
    selectSlot(3);
  } else if (e.code === 'Digit5') {
    selectSlot(4);
  } else if (e.code === 'Digit6') {
    selectSlot(5);
  } else if (e.code === 'Digit7') {
    selectSlot(6);
  } else if (e.code === 'Digit8') {
    selectSlot(7);
  } else if (e.code === 'Digit9') {
    selectSlot(8);
  } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    if (creativeMode) {
      // クリエイティブモード: 下に移動
      playerBody.velocity.y = -15;
    }
  }
});
document.addEventListener('keyup', (e) => { keys.delete(e.code); playerBody.wakeUp(); });

// Movement
const baseMoveSpeed = 11.25; // 22.5の1/2
const dashMultiplier = 2.0; // ダッシュ時は元の速度に戻す
const jumpSpeed = 6.5;
function updatePlayer(dt) {
  // Forward vector from yaw (camera yaw around Y). Z forward is -cos(yaw), X forward is -sin(yaw)
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  const moveVector = new THREE.Vector3();
  let moveStrength = 0;

  const keyboardMove = new THREE.Vector3();
  if (keys.has('KeyW')) keyboardMove.add(forward);
  if (keys.has('KeyS')) keyboardMove.addScaledVector(forward, -1);
  if (keys.has('KeyA')) keyboardMove.addScaledVector(right, -1);
  if (keys.has('KeyD')) keyboardMove.add(right);
  if (keyboardMove.lengthSq() > 0) {
    keyboardMove.normalize();
    moveVector.add(keyboardMove);
    moveStrength = Math.max(moveStrength, 1);
  }

  if (isTouchDevice && touchMoveInput.strength > 0.05) {
    moveVector.addScaledVector(forward, touchMoveInput.y);
    moveVector.addScaledVector(right, touchMoveInput.x);
    moveStrength = Math.max(moveStrength, touchMoveInput.strength);
  }

  if (moveVector.lengthSq() > 0) {
    moveVector.normalize();
    const dashActive = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const strengthFactor = moveStrength > 0 ? THREE.MathUtils.clamp(moveStrength, 0.3, 1) : 1;
    const speed = baseMoveSpeed * (dashActive ? dashMultiplier : 1) * strengthFactor;
    const desired = new CANNON.Vec3(moveVector.x * speed, playerBody.velocity.y, moveVector.z * speed);
    playerBody.velocity.x = desired.x;
    playerBody.velocity.z = desired.z;
  } else {
    playerBody.velocity.x = 0;
    playerBody.velocity.z = 0;
  }

  // Sync rig transform
  playerRig.position.set(playerBody.position.x, playerBody.position.y + 0.5, playerBody.position.z);
  playerRig.rotation.set(0, yaw, 0);
  camera.rotation.x = pitch;
  if (groundedTimer > 0) groundedTimer -= dt;
}

// Punch + gameplay config
const controls = {
  punchStrength: 8,
  punchCooldown: 0.25,
  orientStiffness: 0, // will be initialized from orientSpring
  orientDamping: 0,
  fistSizeX: 0, // init later
  fistSizeY: 0,
  fistSizeZ: 0,
};
controls.orientStiffness = orientSpring.stiffness;
controls.orientDamping = orientSpring.damping;
controls.fistSizeX = fistSize.x;
controls.fistSizeY = fistSize.y;
controls.fistSizeZ = fistSize.z;
controls.punchStrength = settings.punchStrength;

let canPunch = true;
function punch() {
  if (!canPunch) return;
  canPunch = false;
  // Animate fist forward then back (extend off-screen)
  const startZ = handGroup.position.z;
  gsap.to(handGroup.position, { z: startZ - 1.2, duration: 0.08, ease: 'power3.out', yoyo: true, repeat: 1, onUpdate: syncFistBody });
  // Cooldown
  setTimeout(() => { canPunch = true; }, controls.punchCooldown * 1000);
  // Camera tiny shake
  gsap.fromTo(camera.rotation, { z: 0.02 }, { z: 0, duration: 0.15, ease: 'power2.out' });
}

document.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    performPrimaryAction();
  }
});

function syncFistBody() {
  // Compute fist world matrix
  handGroup.updateWorldMatrix(true, true);
  const m = new THREE.Matrix4();
  m.copy(handGroup.matrixWorld);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  m.decompose(pos, quat, scale);

  // Approximate kinematic velocity for better contact response
  const prev = new CANNON.Vec3(fistBody.position.x, fistBody.position.y, fistBody.position.z);
  fistBody.position.set(pos.x, pos.y, pos.z);
  fistBody.quaternion.set(quat.x, quat.y, quat.z, quat.w);
  const vx = (fistBody.position.x - prev.x) / (1/60);
  const vy = (fistBody.position.y - prev.y) / (1/60);
  const vz = (fistBody.position.z - prev.z) / (1/60);
  fistBody.velocity.set(vx, vy, vz);
}

function updateFistSize(x, y, z) {
  fistSize = { x, y, z };
  // Update visual geometry
  const newGeom = new THREE.BoxGeometry(x, y, z);
  fist.geometry.dispose();
  fist.geometry = newGeom;
  // Update physics shape
  while (fistBody.shapes.length) {
    fistBody.removeShape(fistBody.shapes[0]);
  }
  fistBody.addShape(new CANNON.Box(new CANNON.Vec3(x/2, y/2, z/2)));
  // Resync transform after size change
  syncFistBody();
}

// Detect fist-bust hits and apply impulse once per swing
let swingActive = false;
let lastHitTime = 0;
fistBody.addEventListener('collide', (e) => {
  // メインターゲットまたは分割されたターゲットかチェック
  const isMainTarget = e.body === bustBody;
  const isSpawnedTarget = spawnedTargets.some(target => target.body === e.body);
  
  if (!isMainTarget && !isSpawnedTarget) return;
  
  const now = performance.now();
  if (now - lastHitTime < 80) return; // throttle to avoid multi-hit in one frame
  lastHitTime = now;

  // Direction from fist to target
  const dir = new CANNON.Vec3(
    e.body.position.x - fistBody.position.x,
    e.body.position.y - fistBody.position.y,
    e.body.position.z - fistBody.position.z,
  );
  dir.normalize();

  // Compute impulse magnitude based on punchStrength and hardness absorption
  const absorption = THREE.MathUtils.clamp(bustParams.hardness, 0, 1);
  const impulseMag = (settings.punchStrength ?? controls.punchStrength) * (0.6 + 0.4 * (1 - absorption)) / 3; // 1/3に変更
  const impulse = new CANNON.Vec3(dir.x * impulseMag, dir.y * impulseMag, dir.z * impulseMag);
  applyImpulseClamped(e.body, impulse, new CANNON.Vec3().copy(e.contact.bi.position), 80);

  // Visual feedback
  if (isMainTarget) {
  gsap.to(targetMesh.material, { emissiveIntensity: 0.8, duration: 0.05, yoyo: true, repeat: 1, onStart: () => { targetMesh.material.emissive = new THREE.Color(0xff5555); }, onComplete: () => { targetMesh.material.emissiveIntensity = 0; } });
  } else if (isSpawnedTarget) {
    // 分割されたターゲットの視覚効果
    const target = spawnedTargets.find(t => t.body === e.body);
    if (target) {
      gsap.to(target.mesh.material, { emissiveIntensity: 0.8, duration: 0.05, yoyo: true, repeat: 1, onStart: () => { target.mesh.material.emissive = new THREE.Color(0xff5555); }, onComplete: () => { target.mesh.material.emissiveIntensity = 0; } });
    }
  }
});

// Resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  updateRendererSize();
});

// Main loop
const clock = new THREE.Clock();
let physicsInitialized = false;

function tick() {
  const rawDt = clock.getDelta();
  recordFrameTime(rawDt * 1000);
  const dt = Math.min(0.033, rawDt);
  
  // 物理演算の初期化確認
  if (!physicsInitialized) {
    // プレイヤーが地面に着地しているかチェック
    if (playerBody.position.y <= 1.5) {
      physicsInitialized = true;
      if (!antiGravityActive) restoreDefaultGravity();
    } else {
      // まだ空中にいる場合は重力を強化
      setWorldGravity(0, -50, 0);
    }
  }
  
  // Apply soft spring force each step for boing behavior and upright torque
  softSpring.applyForce();
  applyUprightTorque();
  world.step(1 / 60, dt, 8);
  updatePlayer(dt);
  syncBust();
  // Sync additional spawned targets
  for (let i = 0; i < spawnedTargets.length; i++) {
    const { mesh, body } = spawnedTargets[i];
    mesh.position.set(body.position.x, body.position.y, body.position.z);
    mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
  }

  camera.updateMatrixWorld();
  chunkProjMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  chunkFrustum.setFromProjectionMatrix(chunkProjMatrix);

  const cameraPos = getCameraPosition();
  for (let i = 0; i < spawnedStructures.length; i++) {
    const structure = spawnedStructures[i];
    if (!structure || structure.state !== 'static' || !structure.chunks) continue;
    for (let c = 0; c < structure.chunks.length; c++) {
      const chunk = structure.chunks[c];
      if (!chunk || !chunk.group || !chunk.center) continue;
      if (chunk.boundingSphere) {
        chunk.boundingSphere.center.copy(chunk.center);
      }
      const distance = cameraPos.distanceTo(chunk.center) - (chunk.radius || 0);
      const withinDistance = distance <= STRUCTURE_CHUNK_CULL_DISTANCE;
      const withinFrustum = !chunk.boundingSphere || chunkFrustum.intersectsSphere(chunk.boundingSphere);
      const visible = withinDistance && withinFrustum;
      if (chunk.group.visible !== visible) {
        chunk.group.visible = visible;
      }
    }
  }

  const nowMs = performance.now();
  for (let i = 0; i < spawnedStructures.length; i++) {
    const structure = spawnedStructures[i];
    if (!structure || !structure.parts || !structure.parts.length) continue;
    for (let p = structure.parts.length - 1; p >= 0; p--) {
      const part = structure.parts[p];
      if (!part || !part.body) continue;
      if (!part.spawnedAt) part.spawnedAt = nowMs;
      if (part.dynamicState === 'passive') continue;
      const age = nowMs - part.spawnedAt;
      tempVec3.set(part.body.position.x, part.body.position.y, part.body.position.z);
      const distance = cameraPos.distanceTo(tempVec3);
      if (age < FRAGMENT_ACTIVE_DURATION && distance < FRAGMENT_SLEEP_DISTANCE) continue;
      part.dynamicState = 'passive';
      part.body.type = CANNON.Body.STATIC;
      part.body.mass = 0;
      part.body.updateMassProperties();
      if (part.body.velocity) part.body.velocity.scale(0, part.body.velocity);
      if (part.body.angularVelocity) part.body.angularVelocity.scale(0, part.body.angularVelocity);
      part.body.collisionFilterMask = COLLISION_GROUPS.GROUND | COLLISION_GROUPS.PLAYER;
      part.body.allowSleep = true;
      part.body.sleep?.();
    }
  }

  for (let i = 0; i < spawnedStructures.length; i++) {
    const structure = spawnedStructures[i];
    if (!structure || !structure.parts || !structure.parts.length) continue;
    for (let p = structure.parts.length - 1; p >= 0; p--) {
      const part = structure.parts[p];
      if (!part || !part.body) continue;
      const pos = part.body.position;
      const heightExceeded = pos.y > FRAGMENT_REMOVE_HEIGHT;
      tempVec3.set(pos.x, pos.y, pos.z);
      const cameraDistance = cameraPos.distanceTo(tempVec3);
      const age = nowMs - (part.spawnedAt || nowMs);
      if (!heightExceeded && cameraDistance <= FRAGMENT_REMOVE_DISTANCE && age <= FRAGMENT_REMOVE_TIMEOUT) continue;

      removeTargetEntry({
        type: 'structure',
        structure,
        part,
        body: part.body,
        mesh: part.mesh,
      });
    }
  }

  for (let s = spawnedStructures.length - 1; s >= 0; s--) {
    const structure = spawnedStructures[s];
    if (!structure) {
      spawnedStructures.splice(s, 1);
      continue;
    }
    if (structure.state === 'static') continue;
    if (!structure.parts || !structure.parts.length) {
      disposeStructure(structure, { removeFromList: false });
      spawnedStructures.splice(s, 1);
    }
  }
  
  // 矢の更新
  for (let i = arrows.length - 1; i >= 0; i--) {
    const arrow = arrows[i];
    const now = performance.now();
    
    // 5秒経過または地面に着地したら削除
    if (now - arrow.spawnTime > 5000 || arrow.body.position.y < 0) {
      scene.remove(arrow.mesh);
      world.removeBody(arrow.body);
      arrows.splice(i, 1);
    } else {
      // 矢がターゲットに刺さっている場合
      if (arrow.targetBody) {
        // 矢をターゲットに固定
        arrow.body.position.set(arrow.targetBody.position.x, arrow.targetBody.position.y, arrow.targetBody.position.z);
        arrow.body.velocity.set(0, 0, 0);
        arrow.body.angularVelocity.set(0, 0, 0);
        
        // 矢の位置を同期
        arrow.mesh.position.set(arrow.body.position.x, arrow.body.position.y, arrow.body.position.z);
        arrow.mesh.quaternion.set(arrow.body.quaternion.x, arrow.body.quaternion.y, arrow.body.quaternion.z, arrow.body.quaternion.w);
        
        // 持続的な衝撃を適用（発射時の方向で固定）
        const continuousForce = 5;
        applyImpulseClamped(
          arrow.targetBody,
          new CANNON.Vec3(
            arrow.launchDirection.x * continuousForce,
            arrow.launchDirection.y * continuousForce,
            arrow.launchDirection.z * continuousForce
          ),
          arrow.hitPosition || arrow.targetBody.position,
          40
        );
        
        // ターゲットの回転を継続的に停止
        arrow.targetBody.angularVelocity.set(0, 0, 0);
      } else if (arrow.trackingTarget) {
        // 追尾処理
        const targetPos = new THREE.Vector3(
          arrow.trackingTarget.position.x,
          arrow.trackingTarget.position.y,
          arrow.trackingTarget.position.z
        );
        const arrowPos = new THREE.Vector3(
          arrow.body.position.x,
          arrow.body.position.y,
          arrow.body.position.z
        );
        
        const direction = targetPos.clone().sub(arrowPos).normalize();
        const distance = arrowPos.distanceTo(targetPos);
        
        // ターゲットに近づいたら刺さる
        if (distance < 0.5) {
          // ターゲットに刺さる
          arrow.targetBody = arrow.trackingTarget;
          arrow.hitPosition = new CANNON.Vec3(targetPos.x, targetPos.y, targetPos.z);
          arrow.trackingTarget = null;
          
          // 矢の速度を0に
          arrow.body.velocity.set(0, 0, 0);
          arrow.body.angularVelocity.set(0, 0, 0);
          
          // ターゲットの回転を停止
          arrow.targetBody.angularVelocity.set(0, 0, 0);
        } else {
          // 追尾方向に速度を設定
          const speed = arrow.trackingSpeed;
          arrow.body.velocity.set(
            direction.x * speed,
            direction.y * speed,
            direction.z * speed
          );
        }
        
        // 矢の位置を同期
        arrow.mesh.position.set(arrow.body.position.x, arrow.body.position.y, arrow.body.position.z);
        arrow.mesh.quaternion.set(arrow.body.quaternion.x, arrow.body.quaternion.y, arrow.body.quaternion.z, arrow.body.quaternion.w);
      } else {
        // 通常の矢の位置を同期
        arrow.mesh.position.set(arrow.body.position.x, arrow.body.position.y, arrow.body.position.z);
        arrow.mesh.quaternion.set(arrow.body.quaternion.x, arrow.body.quaternion.y, arrow.body.quaternion.z, arrow.body.quaternion.w);
      }
    }
  }
  
  // 爆弾の更新
  for (let i = bombs.length - 1; i >= 0; i--) {
    const bomb = bombs[i];
    const now = performance.now();
    
    // 3秒経過または地面に着地したら爆発
    const fuse = bomb.fuse ?? 3000;
    if (now - bomb.spawnTime > fuse || bomb.body.position.y < 0.2) {
      explodeBomb(bomb);
    } else {
      // 爆弾の位置を同期
      bomb.mesh.position.set(bomb.body.position.x, bomb.body.position.y, bomb.body.position.z);
      bomb.mesh.quaternion.set(bomb.body.quaternion.x, bomb.body.quaternion.y, bomb.body.quaternion.z, bomb.body.quaternion.w);
    }
  }

  const shiftPressed = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const playerHeight = playerBody.position.y + 0.3;
  for (let i = raftEntities.length - 1; i >= 0; i--) {
    const raft = raftEntities[i];
    const body = raft.body;
    const mesh = raft.mesh;
    const now = performance.now();

    body.position.y = playerHeight;
    body.velocity.y = 0;
    mesh.position.set(body.position.x, body.position.y, body.position.z);
    mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);

    let desiredState = 'idle';

    if (raft.attackTargetBody) {
      const targetBody = raft.attackTargetBody;
      if (!targetBody || !targetBody.world || Math.abs(targetBody.position.y) > 1e6) {
        raft.attackTargetBody = null;
      } else {
        const targetPos = new THREE.Vector3(targetBody.position.x, targetBody.position.y, targetBody.position.z);
        const dir = targetPos.clone().sub(mesh.position);
        const distance = dir.length();
        if (distance > 0.2) {
          dir.normalize();
          body.velocity.set(dir.x * 6, 0, dir.z * 6);
          desiredState = 'run';
        }
        if (distance < 1.2) {
          const impulse = dir.normalize().multiplyScalar(60);
          applyImpulseClamped(targetBody, new CANNON.Vec3(impulse.x, Math.abs(impulse.y) + 20, impulse.z), targetBody.position, 120);
          raft.attackTargetBody = null;
          raft.lastSteer = now;
          raft.stateTimer = 300;
          desiredState = 'attack';
        }
      }
    } else if (shiftPressed) {
      const dir = new THREE.Vector3(
        playerBody.position.x - body.position.x,
        0,
        playerBody.position.z - body.position.z
      );
      if (dir.lengthSq() > 0.25) {
        dir.normalize();
        body.velocity.set(dir.x * 4, 0, dir.z * 4);
        desiredState = 'run';
      } else {
        body.velocity.scale(0.5, body.velocity);
        desiredState = 'idle';
      }
    } else {
      if (now - raft.lastSteer > 2500) {
        const dir = new THREE.Vector3((Math.random() - 0.5), 0, (Math.random() - 0.5)).normalize();
        body.velocity.set(dir.x * 2.5, 0, dir.z * 2.5);
        raft.lastSteer = now;
      }
      if (body.velocity.lengthSquared() > 0.4) {
        desiredState = 'run';
      }
    }

    if (raft.stateTimer > 0) {
      raft.stateTimer -= dt * 1000;
      if (raft.stateTimer > 0) {
        desiredState = 'attack';
      }
    }

    if (desiredState !== raft.state) {
      setRaftTexture(raft, desiredState);
    }
    updateRaftAnimation(raft, dt);

    mesh.lookAt(camera.position.x, mesh.position.y, camera.position.z);

    if (Math.abs(body.position.x) > 120 || Math.abs(body.position.z) > 120 || body.position.y < -10) {
      world.removeBody(body);
      scene.remove(mesh);
      raftEntities.splice(i, 1);
    }
  }

  updateTargetLOD(getCameraPosition());
  processMagnetQueue();
  syncFistBody();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
