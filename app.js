import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const clamp = (value, min, max, fallback = min) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, number))
    : fallback;
};

const validColor = (value, fallback) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : fallback;

const viewport = $('#viewport');
const preferencesKey = 'luma-studio-preferences-v2';

const defaultPreferences = {
  theme: 'graphite',
  accent: '#ed9545',
  background: '#393c43',
  compact: false,
  width: 310,
  tips: true,
  pixels: 1,
  fps: 60,
  shadows: true
};

const themes = {
  graphite: {
    bg: '#202124', panel: '#292a2d', dark: '#191a1c',
    raised: '#303136', control: '#36373b', line: '#45474e',
    text: '#dedee2', muted: '#a1a5b0'
  },
  midnight: {
    bg: '#111722', panel: '#182130', dark: '#101622',
    raised: '#1e2a3c', control: '#26354b', line: '#33445d',
    text: '#e1eafa', muted: '#97abc7'
  },
  forest: {
    bg: '#151e1a', panel: '#202d26', dark: '#131d17',
    raised: '#28382e', control: '#304337', line: '#3a5144',
    text: '#dce9df', muted: '#9eb8a6'
  },
  plum: {
    bg: '#211a28', panel: '#2c2436', dark: '#1b1522',
    raised: '#362b42', control: '#41334e', line: '#4c3d5b',
    text: '#eadff2', muted: '#b4a0c5'
  }
};

let savedPreferences = {};
try {
  const parsed = JSON.parse(localStorage.getItem(preferencesKey) || '{}');
  if (parsed && typeof parsed === 'object') savedPreferences = parsed;
} catch {}

const preferences = { ...defaultPreferences, ...savedPreferences };

if (!themes[preferences.theme]) preferences.theme = 'graphite';
preferences.accent = validColor(preferences.accent, '#ed9545');
preferences.background = validColor(preferences.background, '#393c43');
preferences.width = clamp(preferences.width, 250, 420, 310);
preferences.pixels = [.75, 1, 1.5, 2].includes(Number(preferences.pixels))
  ? Number(preferences.pixels) : 1;
preferences.fps = [24, 30, 60].includes(Number(preferences.fps))
  ? Number(preferences.fps) : 60;

for (const key of ['compact', 'tips', 'shadows']) {
  if (typeof preferences[key] !== 'boolean') {
    preferences[key] = defaultPreferences[key];
  }
}

let renderer;

try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });
} catch (error) {
  $('#status').textContent = 'WebGL2 is unavailable.';
  viewport.textContent =
    'This editor requires WebGL2. Enable hardware acceleration or try a current desktop browser.';
  throw error;
}

renderer.setPixelRatio(Math.min(devicePixelRatio || 1, preferences.pixels));
renderer.shadowMap.enabled = preferences.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
viewport.prepend(renderer.domElement);

RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(preferences.background);

const content = new THREE.Group();
content.name = 'Scene Collection';
scene.add(content);

// Editor overlays stay outside the exported/path-traced scene.
const editorScene = new THREE.Scene();
const grid = new THREE.GridHelper(60, 60, '#717684', '#4b4e58');
grid.position.y = -.025;
editorScene.add(grid);

const camera = new THREE.PerspectiveCamera(45, 1, .05, 500);
camera.position.set(11, 8, 13);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1.2, 0);
orbit.enableDamping = true;
orbit.dampingFactor = .12;
orbit.minDistance = .15;
orbit.maxDistance = 200;
orbit.update();

const transform = new TransformControls(camera, renderer.domElement);
transform.setSize(.8);
editorScene.add(transform.getHelper());

const selectionBox = new THREE.BoxHelper(undefined, preferences.accent);
selectionBox.visible = false;
selectionBox.material.depthTest = false;
selectionBox.renderOrder = 100;
editorScene.add(selectionBox);

const solidMaterial = new THREE.MeshStandardMaterial({
  color: '#b1b5bf',
  roughness: .8,
  side: THREE.DoubleSide
});

const wireMaterial = new THREE.MeshBasicMaterial({
  color: '#a2c0db',
  wireframe: true
});

let selected = null;
let mode = 'shaded';
let tracer = null;
let tracerPromise = null;
let geometryDirty = true;
let cameraDirty = true;
let tracePaused = false;
let contextLost = false;
let undoStack = [];
let redoStack = [];
let toastTimer;
let pointerStart;
let lastFrame = 0;
let lastHUD = 0;
let operationBusy = false;

const expanded = new Set();

function isTracing() {
  return mode === 'rendered' || mode === 'output';
}

function toast(message, duration = 4500) {
  $('#toast').textContent = message;
  $('#toast').style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').style.display = 'none';
  }, duration);
}

function closeMenus() {
  $$('details.menu').forEach(menu => menu.open = false);
}

function invalidate() {
  geometryDirty = true;
  tracer?.reset();
}

function createEnvironment() {
  const width = 256;
  const height = 128;
  const pixels = new Float32Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);

    for (let x = 0; x < width; x++) {
      const u = x / width;
      const index = (y * width + x) * 4;
      const sky = Math.max(0, Math.cos(v * Math.PI));
      const glow = Math.exp(
        -((u - .72) ** 2 / .012 + (v - .28) ** 2 / .02)
      );

      pixels[index] = .16 + .5 * sky + 3 * glow;
      pixels[index + 1] = .18 + .63 * sky + 2.6 * glow;
      pixels[index + 2] = .22 + .85 * sky + 2 * glow;
      pixels[index + 3] = 1;
    }
  }

  const texture = new THREE.DataTexture(
    pixels, width, height, THREE.RGBAFormat, THREE.FloatType
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

scene.environment = createEnvironment();
scene.environmentIntensity = .65;

function physicalMaterial(color, roughness = .55, metalness = 0) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness,
    transmission: 0,
    thickness: .25,
    ior: 1.5,
    side: THREE.DoubleSide
  });
}

function mesh(geometry, color, name, position = [0, 0, 0], scale = [1, 1, 1]) {
  const object = new THREE.Mesh(geometry, physicalMaterial(color));
  object.name = name;
  object.position.fromArray(position);
  object.scale.fromArray(scale);
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}

function box(name, color, position, size, rounded = false) {
  return mesh(
    rounded
      ? new RoundedBoxGeometry(1, 1, 1, 3, .08)
      : new THREE.BoxGeometry(),
    color, name, position, size
  );
}

function sphere(name, color, position, scale = [1, 1, 1]) {
  return mesh(
    new THREE.SphereGeometry(1, 32, 20),
    color, name, position, scale
  );
}

function cylinder(name, color, position, radius, height) {
  return mesh(
    new THREE.CylinderGeometry(radius, radius, height, 32),
    color, name, position
  );
}

function areaLight(name, color, power, position, target, width = 3, height = 3) {
  const light = new THREE.RectAreaLight(color, power, width, height);
  light.name = name;
  light.position.fromArray(position);
  light.lookAt(new THREE.Vector3(...target));
  return light;
}

function pointLight(name, color, power, position) {
  const light = new THREE.PointLight(color, power, 50, 2);
  light.name = name;
  light.position.fromArray(position);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.bias = -.0001;
  return light;
}

function register(object, freshIDs = false) {
  object.traverse(child => {
    if (freshIDs || !child.userData.editorID) {
      child.userData.editorID = THREE.MathUtils.generateUUID();
    }
    if (!child.name) child.name = child.type || 'Object';
  });
  return object;
}

function makeRoom() {
  const room = new THREE.Group();
  room.name = 'Cozy Living Room';

  room.add(
    box('Oak Floor', '#a88965', [0, -.12, 0], [10, .24, 8]),
    box('Back Wall', '#ddd0ba', [0, 2.25, -4], [10, 4.5, .18]),
    box('Left Wall', '#d7c9b6', [-5, 2.25, 0], [.18, 4.5, 8]),
    box('Back Skirting', '#f0e6d4', [0, .12, -3.86], [10, .24, .08]),
    box('Left Skirting', '#f0e6d4', [-4.86, .12, 0], [.08, .24, 8]),
    box('Woven Rug', '#d2bea0', [0, .03, .6], [5.7, .05, 3.6], true)
  );

  const sofa = new THREE.Group();
  sofa.name = 'Sofa';
  const fabric = '#3b7a76';

  sofa.add(
    box('Base', fabric, [-1, .56, -2.4], [4.1, .7, 1.6], true),
    box('Back', fabric, [-1, 1.15, -3.02], [4.1, 1.4, .36], true),
    box('Left Arm', fabric, [-2.93, .94, -2.35], [.38, 1.1, 1.65], true),
    box('Right Arm', fabric, [.93, .94, -2.35], [.38, 1.1, 1.65], true)
  );

  for (let i = 0; i < 3; i++) {
    sofa.add(box(
      'Seat Cushion ' + (i + 1), fabric,
      [-2.2 + i * 1.2, .98, -2.27], [1.14, .26, 1.2], true
    ));

    const pillow = box(
      'Throw Pillow ' + (i + 1),
      i === 1 ? '#c48754' : '#dad6ba',
      [-2.25 + i * 1.25, 1.43, -2.69],
      [.6, .6, .23], true
    );
    pillow.rotation.z = i % 2 ? .13 : -.14;
    sofa.add(pillow);
  }

  for (const x of [-2.6, .6]) {
    for (const z of [-2.9, -1.95]) {
      sofa.add(cylinder('Wooden Leg', '#49392d', [x, .17, z], .06, .3));
    }
  }

  room.add(sofa);

  const table = new THREE.Group();
  table.name = 'Coffee Table';
  table.add(cylinder('Walnut Top', '#755238', [0, .79, .55], 1.05, .12));

  for (let i = 0; i < 3; i++) {
    const angle = i * Math.PI * 2 / 3;
    const leg = cylinder(
      'Metal Leg', '#292a2d',
      [Math.cos(angle) * .67, .38, .55 + Math.sin(angle) * .67],
      .05, .72
    );
    leg.material.metalness = .8;
    leg.material.roughness = .3;
    table.add(leg);
  }

  table.add(
    box('Book', '#b38369', [-.28, .89, .5], [.53, .08, .4]),
    cylinder('Ceramic Bowl', '#e1d8c7', [.35, .92, .5], .2, .14)
  );
  room.add(table);

  const plant = new THREE.Group();
  plant.name = 'Indoor Plant';
  plant.add(mesh(
    new THREE.CylinderGeometry(.4, .29, .7, 32),
    '#b37051', 'Terracotta Pot', [3.2, .35, -2.8]
  ));
  plant.add(cylinder('Soil', '#33271e', [3.2, .71, -2.8], .36, .025));

  for (let i = 0; i < 10; i++) {
    const angle = i * 2.4;
    const height = 1.2 + (i % 4) * .25;
    const x = 3.2 + Math.sin(angle) * .3;
    const z = -2.8 + Math.cos(angle) * .3;

    plant.add(cylinder(
      'Stem', '#45613b', [x, (height + .7) / 2, z], .016, height - .7
    ));

    const leaf = sphere(
      'Leaf', i % 2 ? '#416d47' : '#6c864c',
      [x, height, z], [.15, .43, .08]
    );
    leaf.rotation.set(.3, angle, Math.sin(angle) * .65);
    plant.add(leaf);
  }

  room.add(plant);

  const artwork = new THREE.Group();
  artwork.name = 'Wall Art';

  for (let i = 0; i < 3; i++) {
    const x = -2.5 + i * 1.4;
    artwork.add(
      box('Frame', '#4c4034', [x, 2.9, -3.86], [1.08, 1.5, .1]),
      box(
        'Canvas', ['#b77c55', '#86968a', '#b4a381'][i],
        [x, 2.9, -3.795], [.94, 1.36, .025]
      )
    );
    const relief = cylinder('Circular Relief', '#e2c5a0', [x, 3, -3.755], .28, .025);
    relief.rotation.x = Math.PI / 2;
    artwork.add(relief);
  }

  room.add(artwork);

  const lamp = new THREE.Group();
  lamp.name = 'Floor Lamp';
  lamp.add(
    cylinder('Base', '#303039', [2.45, .06, -1.1], .35, .12),
    cylinder('Brass Stem', '#b89a67', [2.45, 1.2, -1.1], .03, 2.35)
  );
  lamp.children[1].material.metalness = .85;

  lamp.add(mesh(
    new THREE.CylinderGeometry(.3, .47, .54, 32, 1, true),
    '#eadfc7', 'Lamp Shade', [2.45, 2.28, -1.1]
  ));
  lamp.add(pointLight('Warm Bulb', '#ffd6a1', 40, [2.45, 2.08, -1.1]));
  room.add(lamp);

  room.add(
    areaLight('Large Softbox', '#fff0dc', 10, [0, 4, 1], [0, 0, -1], 3.5, 2.5),
    areaLight('Window Fill', '#c7ddff', 5, [4.3, 3.2, .5], [0, 1, -1], 2.5, 3)
  );

  return register(room);
}

function makeBounceDemo() {
  const group = new THREE.Group();
  group.name = 'Light-Bounce Demo';

  group.add(
    box('White Floor', '#e1dfd7', [0, -.08, 0], [5, .16, 5]),
    box('White Back', '#e1dfd7', [0, 2.5, -2.5], [5, 5, .15]),
    box('Red Wall', '#c32c31', [-2.5, 2.5, 0], [.15, 5, 5]),
    box('Green Wall', '#3eaa69', [2.5, 2.5, 0], [.15, 5, 5]),
    box('Ceiling', '#e1dfd7', [0, 5, 0], [5, .15, 5])
  );

  const cube = box('Diffuse Block', '#deddd7', [-.85, .75, -.5], [1.25, 1.5, 1.25]);
  cube.rotation.y = .3;
  group.add(cube);

  const metal = sphere('Metal Sphere', '#dadde1', [.95, .8, .4], [.8, .8, .8]);
  metal.material.metalness = 1;
  metal.material.roughness = .12;
  group.add(metal);

  const panel = box('Ceiling Emitter', '#fff4df', [0, 4.88, -.2], [1.8, .03, 1.5]);
  panel.material.emissive.set('#fff4df');
  panel.material.emissiveIntensity = 8;
  group.add(panel);

  // The area light also provides a useful raster preview.
  group.add(areaLight(
    'Ceiling Area Light', '#fff2da', 8,
    [0, 4.8, -.2], [0, 0, -.2], 1.8, 1.5
  ));

  return register(group);
}

const shapes = {
  cube: 'Cube',
  box: 'Rounded Box',
  sphere: 'UV Sphere',
  ico: 'Ico Sphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  torus: 'Torus',
  plane: 'Plane',
  capsule: 'Capsule',
  monkey: 'Suzanne'
};

let suzannePromise;

function loadSuzanne() {
  if (!suzannePromise) {
    suzannePromise = fetch(
      'https://raw.githubusercontent.com/mrdoob/three.js/r146/examples/models/json/suzanne_buffergeometry.json',
      { signal: AbortSignal.timeout(12000) }
    ).then(response => {
      if (!response.ok) throw new Error('Suzanne download unavailable');
      return response.json();
    }).then(json => {
      const geometry = new THREE.BufferGeometryLoader().parse(json);
      geometry.computeVertexNormals();
      return geometry;
    }).catch(() => null);
  }

  return suzannePromise;
}

function monkeyProxy() {
  const group = new THREE.Group();
  group.name = 'Monkey — procedural proxy';

  group.add(
    sphere('Head', '#b6bec8', [0, .05, 0], [.67, .65, .55]),
    sphere('Muzzle', '#b6bec8', [0, -.24, .48], [.44, .32, .35]),
    sphere('Left Ear', '#b6bec8', [-.83, .03, 0], [.35, .42, .2]),
    sphere('Right Ear', '#b6bec8', [.83, .03, 0], [.35, .42, .2]),
    sphere('Left Eye', '#24252a', [-.25, .12, .51], [.13, .14, .09]),
    sphere('Right Eye', '#24252a', [.25, .12, .51], [.13, .14, .09])
  );

  return group;
}

async function createPrimitive(shape) {
  let geometry;
  let object;

  switch (shape) {
    case 'cube': geometry = new THREE.BoxGeometry(); break;
    case 'box': geometry = new RoundedBoxGeometry(1, 1, 1, 3, .09); break;
    case 'sphere': geometry = new THREE.SphereGeometry(.65, 40, 28); break;
    case 'ico': geometry = new THREE.IcosahedronGeometry(.75, 1); break;
    case 'cylinder': geometry = new THREE.CylinderGeometry(.5, .5, 1.4, 40); break;
    case 'cone': geometry = new THREE.ConeGeometry(.65, 1.5, 40); break;
    case 'torus': geometry = new THREE.TorusGeometry(.6, .2, 20, 64); break;
    case 'plane': geometry = new THREE.PlaneGeometry(2, 2); break;
    case 'capsule': geometry = new THREE.CapsuleGeometry(.4, .8, 8, 24); break;

    case 'monkey':
      geometry = await loadSuzanne();
      if (!geometry) {
        object = monkeyProxy();
        toast('Suzanne could not download. Added a labeled procedural monkey proxy.', 7000);
      }
      break;

    default:
      throw new Error('Unknown primitive');
  }

  if (!object) {
    object = mesh(geometry, '#b6bec8', shapes[shape]);
  }

  object.position.set(0, .8, 1.8);

  if (shape === 'plane') {
    object.rotation.x = -Math.PI / 2;
    object.position.y = .02;
  }

  if (shape === 'torus') object.rotation.x = -Math.PI / 2;
  if (shape === 'ico') object.material.flatShading = true;

  return register(object);
}

// Snapshots share geometry/texture data, but clone editable materials.
// Limit history to reduce memory growth with imported scenes.
function cloneObject(object, newIDs = false) {
  const copy = object.clone(true);

  copy.traverse(child => {
    if (child.material) {
      child.material = Array.isArray(child.material)
        ? child.material.map(material => material.clone())
        : child.material.clone();
    }
  });

  register(copy, newIDs);
  return copy;
}

function snapshot() {
  return {
    objects: content.children.map(object => cloneObject(object)),
    selectedID: selected?.userData.editorID || null
  };
}

function remember() {
  undoStack.push(snapshot());
  if (undoStack.length > 15) undoStack.shift();
  redoStack = [];
}

function restore(state) {
  select(null);
  content.clear();

  state.objects.forEach(object => content.add(cloneObject(object)));

  let nextSelected = null;
  content.traverse(object => {
    if (object.userData.editorID === state.selectedID) nextSelected = object;
  });

  select(nextSelected);
  invalidate();
  updateOutliner();
}

function undo() {
  if (operationBusy || !undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

function redo() {
  if (operationBusy || !redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

async function addPrimitive(shape) {
  if (operationBusy) return;
  operationBusy = true;

  try {
    $('#status').textContent = `Adding ${shapes[shape]}…`;
    const object = await createPrimitive(shape);
    remember();
    content.add(object);
    select(object);
    invalidate();
  } catch (error) {
    console.error(error);
    toast(error.message);
  } finally {
    operationBusy = false;
    if (!isTracing()) $('#status').textContent = 'Ready';
  }
}

function addLight(kind) {
  if (operationBusy) return;
  remember();

  const light = kind === 'point'
    ? pointLight('Point Light', '#ffdfb3', 80, [0, 3, 2])
    : areaLight('Area Light', '#ffe6c6', 20, [0, 4, 2], [0, 0, 0]);

  content.add(register(light));
  select(light);
  invalidate();
}

function addRoom() {
  if (operationBusy) return;
  remember();

  const room = makeRoom();
  const bounds = new THREE.Box3().setFromObject(content);
  if (!bounds.isEmpty()) room.position.x = bounds.max.x + 7;

  content.add(room);
  select(room);
  invalidate();
  frameSelected();
}

function addBounceDemo() {
  if (operationBusy) return;
  remember();

  const demo = makeBounceDemo();
  const bounds = new THREE.Box3().setFromObject(content);
  if (!bounds.isEmpty()) demo.position.x = bounds.max.x + 5;

  content.add(demo);
  select(demo);
  invalidate();

  orbit.target.set(demo.position.x, 2.2, -.2);
  camera.position.set(demo.position.x, 2.4, 10);
  orbit.update();
  cameraDirty = true;

  $('#bounces').value = 8;
  $('#samples').value = 256;
  $('#environmentPower').value = .1;
  updateRenderSettings();

  setMode('rendered');
  toast('Compare 1–2 bounces with 8 bounces to see indirect light and color bleeding.', 7000);
}

function duplicateSelected() {
  if (!selected || operationBusy) return;
  remember();

  const copy = cloneObject(selected, true);
  copy.name += ' Copy';
  copy.position.x += 1;
  selected.parent.add(copy);

  select(copy);
  invalidate();
}

function deleteSelected() {
  if (!selected || operationBusy) return;
  remember();

  selected.removeFromParent();
  select(null);
  invalidate();
}

function newScene() {
  closeMenus();
  if (operationBusy) return;
  if (!confirm('Clear the scene? You can undo this action.')) return;

  remember();
  content.clear();
  select(null);
  invalidate();
}

function firstMaterial(object) {
  let material;

  object?.traverse(child => {
    if (!material && child.isMesh) {
      material = Array.isArray(child.material) ? child.material[0] : child.material;
    }
  });

  return material;
}

function isEffectivelyVisible(object) {
  for (let current = object; current; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

function select(object) {
  selected = object;
  transform.detach();

  if (object && isEffectivelyVisible(object) && !isTracing()) {
    transform.attach(object);
  }

  $('#selectionLabel').textContent = object
    ? 'Scene Collection › ' + object.name
    : 'Scene Collection';

  // Expand ancestors so a mesh selected in the viewport is visible in the tree.
  for (let parent = object?.parent; parent && parent !== content; parent = parent.parent) {
    expanded.add(parent.userData.editorID);
  }

  syncProperties();
  updateOutliner();
}

function syncProperties() {
  $('#objectName').disabled = !selected;
  $('#objectName').value = selected?.name || '';

  $$('.xyz input').forEach(input => {
    input.disabled = !selected;
    if (!selected) {
      input.value = '';
      return;
    }

    const property = input.parentElement.dataset.property;
    let value = selected[property][input.dataset.axis];
    if (property === 'rotation') value = THREE.MathUtils.radToDeg(value);
    input.value = Number(value.toFixed(3));
  });

  const material = firstMaterial(selected);
  const light = selected?.isLight ? selected : null;
  const color = light?.color || material?.color || new THREE.Color('#b6bec8');

  $('#surfaceColor').value = '#' + color.getHexString();
  $('#surfaceColor').disabled = !material && !light;

  for (const [id, fallback] of [
    ['roughness', .5], ['metalness', 0], ['transmission', 0]
  ]) {
    $('#' + id).disabled = !material;
    $('#' + id).value = material?.[id] ?? fallback;
  }

  $('#emission').disabled = !material;
  $('#emission').value = material?.emissiveIntensity ?? 0;
  if (material?.emissive?.getHex() === 0) $('#emission').value = 0;

  $('#lightPower').disabled = !light;
  $('#lightPower').value = light?.intensity ?? 0;
}

function updateOutliner() {
  const outliner = $('#outliner');
  outliner.replaceChildren();

  function appendObject(object, depth) {
    const row = document.createElement('div');
    row.className = 'object-row' + (object === selected ? ' selected' : '');
    row.style.paddingLeft = (7 + depth * 13) + 'px';

    const disclosure = document.createElement('button');
    disclosure.className = 'disclosure';
    disclosure.textContent = object.children.length
      ? expanded.has(object.userData.editorID) ? '▾' : '▸'
      : '';
    disclosure.disabled = !object.children.length;
    disclosure.setAttribute('aria-label', 'Expand ' + object.name);

    disclosure.onclick = event => {
      event.stopPropagation();
      const id = object.userData.editorID;
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      updateOutliner();
    };

    const icon = document.createElement('span');
    icon.className = 'object-icon';
    icon.textContent = object.isLight ? '☀' : object.isMesh ? '◇' : '▱';

    const name = document.createElement('span');
    name.className = 'object-name';
    name.textContent = object.name;
    name.title = object.name;

    const visibility = document.createElement('button');
    visibility.textContent = object.visible ? '◉' : '○';
    visibility.title = 'Toggle visibility';
    visibility.onclick = event => {
      event.stopPropagation();
      if (operationBusy) return;
      remember();
      object.visible = !object.visible;
      select(selected);
      invalidate();
    };

    row.append(disclosure, icon, name, visibility);
    row.onclick = () => select(object);
    row.ondblclick = () => {
      select(object);
      frameSelected();
    };
    outliner.append(row);

    if (expanded.has(object.userData.editorID)) {
      object.children.forEach(child => appendObject(child, depth + 1));
    }
  }

  content.children.forEach(object => appendObject(object, 0));

  let meshes = 0;
  let triangles = 0;

  content.traverse(object => {
    if (!object.isMesh) return;
    meshes++;
    triangles += (
      object.geometry.index?.count ||
      object.geometry.attributes.position?.count || 0
    ) / 3;
  });

  $('#objectCount').textContent = `${content.children.length} roots`;
  $('#sceneStats').textContent =
    `${meshes} meshes · ${Math.round(triangles).toLocaleString()} tris`;
}

function frameSelected() {
  const object = selected || content;
  const bounds = new THREE.Box3().setFromObject(object);

  if (bounds.isEmpty()) {
    const center = object.getWorldPosition(new THREE.Vector3());
    orbit.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(4, 3, 5));
  } else {
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const largest = Math.max(size.x, size.y, size.z, 1);
    const direction = camera.position.clone().sub(orbit.target).normalize();
    const distance = largest /
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
      Math.min(camera.aspect, 1) * 1.3;

    orbit.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, distance);
  }

  orbit.update();
  cameraDirty = true;
}

function setTool(tool) {
  transform.setMode(tool);
  $$('[data-tool]').forEach(button => {
    button.classList.toggle('active', button.dataset.tool === tool);
  });
}

// Convert imported materials only when editing them, retaining common maps.
function editableMaterial(material) {
  if (material.isMeshPhysicalMaterial) return material;

  const physical = new THREE.MeshPhysicalMaterial();

  if (material.isMeshStandardMaterial) {
    THREE.MeshStandardMaterial.prototype.copy.call(physical, material);
  } else {
    physical.color.copy(material.color || new THREE.Color('#b6bec8'));
    physical.map = material.map || null;
    physical.normalMap = material.normalMap || null;
    physical.bumpMap = material.bumpMap || null;
    physical.alphaMap = material.alphaMap || null;
    physical.opacity = material.opacity ?? 1;
    physical.transparent = material.transparent || false;
    physical.side = material.side;
    if (material.emissive) physical.emissive.copy(material.emissive);
    physical.emissiveMap = material.emissiveMap || null;
  }

  physical.thickness = .25;
  physical.ior = 1.5;
  return physical;
}

function changeSurface(property) {
  if (!selected || operationBusy) return;
  remember();

  if (selected.isLight && property === 'color') {
    selected.color.set($('#surfaceColor').value);
  } else {
    selected.traverse(object => {
      if (!object.isMesh) return;

      const wasArray = Array.isArray(object.material);
      const materials = wasArray ? object.material : [object.material];

      const updated = materials.map(existing => {
        const material = editableMaterial(existing);

        if (property === 'color') {
          material.color.set($('#surfaceColor').value);
          if (material.emissiveIntensity > 0 && material.emissive.getHex() !== 0) {
            material.emissive.copy(material.color);
          }
        } else if (property === 'emission') {
          material.emissive.copy(material.color);
          material.emissiveIntensity = clamp($('#emission').value, 0, 100, 0);
        } else {
          material[property] = clamp($('#' + property).value, 0, 1, 0);
        }

        material.needsUpdate = true;
        return material;
      });

      object.material = wasArray ? updated : updated[0];
    });
  }

  invalidate();
  syncProperties();
}

async function ensureTracer() {
  if (tracer) return tracer;

  if (!tracerPromise) {
    $('#status').textContent = 'Loading GPU path tracer…';

    tracerPromise = import(
      'https://esm.sh/three-gpu-pathtracer@0.0.23?bundle&external=three'
    ).then(module => {
      tracer = new module.WebGLPathTracer(renderer);
      tracer.bounces = clamp($('#bounces').value, 1, 16, 6);
      tracer.renderScale = Number($('#renderScale').value);
      tracer.tiles.set(3, 3);
      tracer.filterGlossyFactor = .45;
      tracer.minSamples = 1;
      tracer.fadeDuration = 0;
      geometryDirty = true;
      return tracer;
    }).catch(error => {
      tracerPromise = null;
      tracer = null;
      throw error;
    });
  }

  return tracerPromise;
}

function syncPauseButton() {
  $('#pauseRender').textContent = tracePaused ? '▶ Resume' : '⏸ Pause';
  $('#pauseRender').classList.toggle('active', tracePaused);
}

async function setMode(nextMode) {
  mode = nextMode;
  tracePaused = false;
  syncPauseButton();

  $$('[data-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });

  document.body.classList.toggle('path-mode', isTracing());
  document.body.classList.toggle('output-mode', mode === 'output');

  transform.detach();
  selectionBox.visible = false;
  scene.overrideMaterial = null;
  cameraDirty = true;

  if (selected && isEffectivelyVisible(selected) && !isTracing()) {
    transform.attach(selected);
  }

  $('#viewName').textContent = isTracing()
    ? 'Path-Traced Perspective'
    : 'User Perspective';

  if (isTracing()) {
    try {
      await ensureTracer();

      if (isTracing()) {
        geometryDirty = true;
        tracer.reset();
        $('#status').textContent = 'Preparing path-traced scene…';
      }
    } catch (error) {
      console.error(error);
      toast(
        'Path tracer could not load. Check your connection and GPU support. Shaded mode remains available.',
        8000
      );
      if (isTracing()) setMode('shaded');
    }
  } else {
    $('#renderInfo').textContent = {
      solid: 'Solid preview',
      shaded: 'Material preview',
      wire: 'Wireframe'
    }[mode];

    $('#status').textContent = 'Ready';
    $('#sampleStatus').textContent = 'Raster preview';
    $('#progressFill').style.width = '0%';
  }
}

function updateRenderSettings() {
  $('#bounces').value = Math.round(clamp($('#bounces').value, 1, 16, 6));
  renderer.toneMappingExposure = Number($('#exposure').value);
  scene.environmentIntensity = Number($('#environmentPower').value);

  if (tracer) {
    tracer.bounces = Number($('#bounces').value);
    tracer.renderScale = Number($('#renderScale').value);
    tracer.reset();
  }

  invalidate();
}

async function restartRender() {
  tracePaused = false;
  syncPauseButton();

  if (!isTracing()) {
    await setMode('rendered');
  }

  if (!tracer || !isTracing()) return;

  tracer.bounces = clamp($('#bounces').value, 1, 16, 6);
  tracer.renderScale = Number($('#renderScale').value);
  geometryDirty = true;
  cameraDirty = true;
  tracer.reset();
}

$('#pauseRender').onclick = async () => {
  if (!isTracing()) {
    await setMode('rendered');
    return;
  }

  tracePaused = !tracePaused;
  syncPauseButton();
};

$('#restartRender').onclick = restartRender;
$('#startRender').onclick = () => setMode('output');
$('#bounceDemo').onclick = addBounceDemo;

$('#renderPreset').onchange = () => {
  const presets = {
    draft: [32, 3, .5],
    balanced: [128, 6, .75],
    final: [512, 10, 1]
  };

  const [samples, bounces, scale] = presets[$('#renderPreset').value];
  $('#samples').value = samples;
  $('#bounces').value = bounces;
  $('#renderScale').value = scale;
  updateRenderSettings();
};

['bounces', 'renderScale', 'exposure', 'environmentPower'].forEach(id => {
  $('#' + id).onchange = updateRenderSettings;
});

// Raising the sample limit continues the existing accumulation.
$('#samples').onchange = () => lastHUD = 0;

orbit.addEventListener('change', () => {
  cameraDirty = true;
});

transform.addEventListener('dragging-changed', event => {
  orbit.enabled = !event.value;
});

transform.addEventListener('mouseDown', () => {
  if (!operationBusy) remember();
});

transform.addEventListener('objectChange', () => {
  syncProperties();
  invalidate();
});

renderer.domElement.addEventListener('pointerdown', event => {
  pointerStart = {
    x: event.clientX,
    y: event.clientY,
    button: event.button,
    gizmo: !!transform.axis
  };
});

renderer.domElement.addEventListener('pointerup', event => {
  if (
    !pointerStart ||
    pointerStart.button !== 0 ||
    pointerStart.gizmo ||
    transform.dragging ||
    transform.axis
  ) return;

  if (Math.hypot(
    event.clientX - pointerStart.x,
    event.clientY - pointerStart.y
  ) > 4) return;

  const rect = renderer.domElement.getBoundingClientRect();
  const raycaster = new THREE.Raycaster();

  raycaster.setFromCamera(new THREE.Vector2(
    (event.clientX - rect.left) / rect.width * 2 - 1,
    -(event.clientY - rect.top) / rect.height * 2 + 1
  ), camera);

  const hit = raycaster.intersectObjects(content.children, true).find(result =>
    result.object.isMesh && isEffectivelyVisible(result.object)
  );

  select(hit?.object || null);
});

$$('[data-tool]').forEach(button => {
  button.onclick = () => setTool(button.dataset.tool);
});

$$('[data-mode]').forEach(button => {
  button.onclick = () => setMode(button.dataset.mode);
});

$('#transformSpace').onchange = event => transform.setSpace(event.target.value);
$('#showGrid').onchange = event => grid.visible = event.target.checked;
$('#frameSelected').onclick = frameSelected;

$$('[data-view]').forEach(button => {
  button.onclick = () => {
    const directions = {
      front: [0, 0, 1],
      right: [1, 0, 0],
      top: [0, 1, .0001],
      iso: [1, .7, 1]
    };

    const distance = camera.position.distanceTo(orbit.target);
    const direction = new THREE.Vector3(...directions[button.dataset.view]).normalize();

    camera.position.copy(orbit.target).addScaledVector(direction, distance);
    orbit.update();
    cameraDirty = true;
  };
});

function addMenuButton(label, action) {
  const button = document.createElement('button');
  button.textContent = label;
  button.onclick = () => {
    closeMenus();
    action();
  };
  $('#addItems').append(button);
}

Object.entries(shapes).forEach(([shape, label]) => {
  addMenuButton('◇  ' + label, () => addPrimitive(shape));
});

addMenuButton('☀  Area Light', () => addLight('area'));
addMenuButton('☼  Point Light', () => addLight('point'));
addMenuButton('⌂  Furnished Room', addRoom);
addMenuButton('▣  Light-Bounce Demo', addBounceDemo);

$('#quickAdd').onclick = () => $('#addMenu').open = !$('#addMenu').open;

$('#objectName').onchange = event => {
  if (!selected || operationBusy) return;
  remember();
  selected.name = event.target.value.trim().slice(0, 100) || 'Object';
  select(selected);
};

$$('.xyz input').forEach(input => {
  input.onchange = () => {
    if (!selected || operationBusy) return;
    remember();

    const property = input.parentElement.dataset.property;
    const axis = input.dataset.axis;
    let value = clamp(
      input.value,
      property === 'scale' ? .001 : -10000,
      10000,
      property === 'scale' ? 1 : 0
    );

    if (property === 'rotation') value = THREE.MathUtils.degToRad(value);
    selected[property][axis] = value;

    syncProperties();
    invalidate();
  };
});

$('#surfaceColor').onchange = () => changeSurface('color');
['roughness', 'metalness', 'transmission', 'emission'].forEach(id => {
  $('#' + id).onchange = () => changeSurface(id);
});

$('#lightPower').onchange = () => {
  if (!selected?.isLight || operationBusy) return;
  remember();
  selected.intensity = clamp($('#lightPower').value, 0, 10000, 20);
  invalidate();
};

$('#newScene').onclick = newScene;
$('#undo').onclick = () => { closeMenus(); undo(); };
$('#redo').onclick = () => { closeMenus(); redo(); };
$('#duplicate').onclick = () => { closeMenus(); duplicateSelected(); };
$('#delete').onclick = () => { closeMenus(); deleteSelected(); };
$('#duplicateObject').onclick = duplicateSelected;
$('#deleteObject').onclick = deleteSelected;

// Import and export.
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function savePNG() {
  closeMenus();

  renderer.domElement.toBlob(blob => {
    if (!blob) {
      toast('PNG export failed.');
      return;
    }

    saveBlob(blob, 'luma-render.png');

    if (isTracing() && (!tracer || tracer.samples < Number($('#samples').value))) {
      toast('Saved the current image. It may still contain path-tracing noise.');
    }
  }, 'image/png');
}

async function exportGLB() {
  closeMenus();
  if (operationBusy) return;

  operationBusy = true;
  $('#status').textContent = 'Exporting GLB…';

  try {
    const result = await new GLTFExporter().parseAsync(content, {
      binary: true,
      onlyVisible: true
    });

    saveBlob(
      new Blob([result], { type: 'model/gltf-binary' }),
      'luma-scene.glb'
    );

    toast('GLB exported. Environment, UI settings, and area lights are not included.', 6500);
  } catch (error) {
    console.error(error);
    toast('Export failed: ' + error.message, 7000);
  } finally {
    operationBusy = false;
    if (!isTracing()) $('#status').textContent = 'Ready';
  }
}

$('#exportScene').onclick = exportGLB;
$('#exportPNG').onclick = savePNG;
$('#saveRender').onclick = savePNG;

const draco = new DRACOLoader();
draco.setDecoderPath(
  'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/'
);

// Companion blob URLs are retained until the page closes so asynchronously
// loaded OBJ textures are not revoked too early.
const importedURLs = new Set();

async function importFiles(fileList) {
  if (operationBusy) {
    toast('Wait for the current operation to finish.');
    return;
  }

  const files = [...fileList];
  const models = files.filter(file => /\.(glb|gltf|obj)$/i.test(file.name));

  if (!models.length) {
    toast('Choose GLB, GLTF, or OBJ model files.');
    return;
  }

  operationBusy = true;
  remember();

  const urls = new Map();

  files.forEach(file => {
    const url = URL.createObjectURL(file);
    importedURLs.add(url);
    urls.set(file.name, url);
    urls.set(file.webkitRelativePath || file.name, url);
  });

  const manager = new THREE.LoadingManager();

  manager.setURLModifier(url => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;

    let path = url;
    try { path = decodeURIComponent(url); } catch {}
    path = path.replace(/^(\.\/)+/, '').split('?')[0];

    return urls.get(path) || urls.get(path.split('/').pop()) || url;
  });

  const gltfLoader = new GLTFLoader(manager).setDRACOLoader(draco);
  let successes = 0;

  $('#status').textContent = 'Importing models…';

  try {
    for (const file of models) {
      try {
        let object;

        if (/\.obj$/i.test(file.name)) {
          const loader = new OBJLoader(manager);
          const stem = file.name.replace(/\.obj$/i, '');

          const mtlFile = files.find(candidate =>
            candidate.name.toLowerCase() === (stem + '.mtl').toLowerCase()
          ) || files.find(candidate => /\.mtl$/i.test(candidate.name));

          if (mtlFile) {
            const materials = new MTLLoader(manager).parse(await mtlFile.text(), '');
            materials.preload();
            loader.setMaterials(materials);
          }

          object = loader.parse(await file.text());

          object.traverse(child => {
            if (!child.isMesh) return;

            child.material = Array.isArray(child.material)
              ? child.material.map(editableMaterial)
              : editableMaterial(child.material);
          });
        } else {
          const gltf = await gltfLoader.parseAsync(await file.arrayBuffer(), '');
          object = gltf.scene;
        }

        object.name = file.name.replace(/\.[^.]+$/, '');
        object.traverse(child => {
          if (!child.isMesh) return;
          child.castShadow = true;
          child.receiveShadow = true;
        });

        content.add(register(object, true));
        select(object);
        successes++;
      } catch (error) {
        console.error(error);
        toast(`Could not import ${file.name}: ${error.message}`, 8000);
      }
    }

    invalidate();
    updateOutliner();

    if (successes) {
      frameSelected();
      toast(`Imported ${successes} model(s).`);
    }
  } finally {
    operationBusy = false;
    if (!isTracing()) $('#status').textContent = 'Ready';
  }
}

$('#importScene').onclick = () => {
  closeMenus();
  $('#fileInput').click();
};

$('#fileInput').onchange = event => {
  importFiles(event.target.files);
  event.target.value = '';
};

let dragDepth = 0;

viewport.addEventListener('dragenter', event => {
  event.preventDefault();
  dragDepth++;
  $('#dropOverlay').classList.add('visible');
});

viewport.addEventListener('dragover', event => event.preventDefault());

viewport.addEventListener('dragleave', event => {
  event.preventDefault();
  if (--dragDepth <= 0) $('#dropOverlay').classList.remove('visible');
});

viewport.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').classList.remove('visible');
  importFiles(event.dataTransfer.files);
});

// Appearance and performance.
function savePreferences() {
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  } catch {}
}

function applyAppearance() {
  const style = document.documentElement.style;
  const theme = themes[preferences.theme];

  Object.entries(theme).forEach(([key, value]) => {
    style.setProperty('--' + key, value);
  });

  style.setProperty('--accent', preferences.accent);
  style.setProperty('--sidebar', preferences.width + 'px');

  document.body.classList.toggle('compact', preferences.compact);
  document.body.classList.toggle('hide-tips', !preferences.tips);
  selectionBox.material.color.set(preferences.accent);
}

function resizeViewport() {
  const width = Math.max(1, viewport.clientWidth);
  const height = Math.max(1, viewport.clientHeight);

  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  cameraDirty = true;
  tracer?.reset();
}

function applyPerformance() {
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, preferences.pixels));

  const shadowsChanged = renderer.shadowMap.enabled !== preferences.shadows;
  renderer.shadowMap.enabled = preferences.shadows;

  if (shadowsChanged) {
    content.traverse(object => {
      if (!object.material) return;
      const materials = Array.isArray(object.material)
        ? object.material : [object.material];
      materials.forEach(material => material.needsUpdate = true);
    });
  }

  resizeViewport();
}

const preferenceBindings = {
  uiTheme: ['theme', 'string'],
  uiAccent: ['accent', 'string'],
  uiBackground: ['background', 'string'],
  uiCompact: ['compact', 'boolean'],
  uiWidth: ['width', 'number'],
  uiTips: ['tips', 'boolean'],
  uiPixels: ['pixels', 'number'],
  uiFPS: ['fps', 'number'],
  uiShadows: ['shadows', 'boolean']
};

function syncPreferenceInputs() {
  Object.entries(preferenceBindings).forEach(([id, [key, type]]) => {
    if (type === 'boolean') $('#' + id).checked = preferences[key];
    else $('#' + id).value = preferences[key];
  });
}

function applyAllPreferences() {
  syncPreferenceInputs();
  applyAppearance();
  applyPerformance();
  scene.background.set(preferences.background);
  invalidate();
  savePreferences();
}

Object.entries(preferenceBindings).forEach(([id, [key, type]]) => {
  $('#' + id).oninput = event => {
    preferences[key] = type === 'boolean'
      ? event.target.checked
      : type === 'number'
        ? Number(event.target.value)
        : event.target.value;

    if (key === 'pixels' || key === 'shadows') {
      applyPerformance();
    } else if (key === 'background') {
      scene.background.set(preferences.background);
      invalidate();
    } else if (key !== 'fps') {
      applyAppearance();
    }

    savePreferences();
  };
});

$('#batteryPreset').onclick = () => {
  Object.assign(preferences, { pixels: .75, fps: 30, shadows: false });
  applyAllPreferences();
  toast('Battery saver enabled. Shaded mode uses less power than path tracing.');
};

$('#qualityPreset').onclick = () => {
  Object.assign(preferences, { pixels: 1.5, fps: 60, shadows: true });
  applyAllPreferences();
};

$('#resetPreferences').onclick = () => {
  Object.assign(preferences, defaultPreferences);
  applyAllPreferences();
};

function showDialog(dialog) {
  closeMenus();
  if (!dialog.open) dialog.showModal();
}

$('#openSettings').onclick = () => showDialog($('#settingsDialog'));

$$('[data-close-dialog]').forEach(button => {
  button.onclick = () => button.closest('dialog').close();
});

$$('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;

    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom
    ) dialog.close();
  });
});

function toggleFocusMode() {
  const enabled = document.body.classList.toggle('focus-mode');
  $('#focusMode').classList.toggle('active', enabled);
  $('#focusMode').setAttribute('aria-pressed', String(enabled));
  $('#focusMode').textContent = enabled ? 'Show panels' : 'Focus';
}

$('#focusMode').onclick = toggleFocusMode;

// Command palette.
const commands = [];

function command(label, category, run) {
  commands.push({ label, category, run });
}

Object.entries(shapes).forEach(([shape, label]) => {
  command('Add ' + label, 'Mesh', () => addPrimitive(shape));
});

command('Add Area Light', 'Lighting', () => addLight('area'));
command('Add Point Light', 'Lighting', () => addLight('point'));
command('Add Furnished Room', 'Scene', addRoom);
command('Add Light-Bounce Demo', 'Scene', addBounceDemo);
command('Import Model…', 'File', () => $('#fileInput').click());
command('Export GLB', 'File', exportGLB);
command('Save Viewport PNG', 'File', savePNG);
command('New Empty Scene', 'File', newScene);
command('Undo', 'Edit', undo);
command('Redo', 'Edit', redo);
command('Duplicate Selected', 'Edit', duplicateSelected);
command('Delete Selected', 'Edit', deleteSelected);
command('Frame Selected / Scene', 'View', frameSelected);
command('Move Tool', 'Transform', () => setTool('translate'));
command('Rotate Tool', 'Transform', () => setTool('rotate'));
command('Scale Tool', 'Transform', () => setTool('scale'));
command('Restart Path Tracing', 'Render', restartRender);

for (const [label, value] of [
  ['Solid View', 'solid'],
  ['Shaded View', 'shaded'],
  ['Wireframe View', 'wire'],
  ['Path-Traced View', 'rendered'],
  ['Render Output', 'output']
]) {
  command(label, 'Viewport', () => setMode(value));
}

command('Toggle Grid', 'View', () => {
  grid.visible = !grid.visible;
  $('#showGrid').checked = grid.visible;
});

command('Toggle Focus Mode', 'Workspace', toggleFocusMode);
command('Customize Interface', 'Settings', () => showDialog($('#settingsDialog')));

let filteredCommands = [];
let commandIndex = 0;

function updateChosenCommand() {
  $$('#commandResults .command-item').forEach((button, index) => {
    button.classList.toggle('chosen', index === commandIndex);
    button.setAttribute('aria-current', String(index === commandIndex));
  });

  $('#commandResults .chosen')?.scrollIntoView({ block: 'nearest' });
}

function runCommand(index) {
  const item = filteredCommands[index];
  if (!item) return;

  $('#commandDialog').close();

  try {
    Promise.resolve(item.run()).catch(error => toast(error.message));
  } catch (error) {
    toast(error.message);
  }
}

function renderCommands() {
  const query = $('#commandQuery').value.toLowerCase().trim();

  filteredCommands = commands.filter(item =>
    (item.label + ' ' + item.category).toLowerCase().includes(query)
  );

  commandIndex = 0;
  const list = $('#commandResults');
  list.replaceChildren();

  if (!filteredCommands.length) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.style.padding = '15px';
    empty.textContent = 'No matching commands.';
    list.append(empty);
  }

  filteredCommands.forEach((item, index) => {
    const button = document.createElement('button');
    button.className = 'command-item';

    const label = document.createElement('span');
    label.textContent = item.label;

    const category = document.createElement('small');
    category.textContent = item.category;

    button.append(label, category);
    button.onclick = () => runCommand(index);
    list.append(button);
  });

  updateChosenCommand();
}

function openCommands() {
  if ($('#settingsDialog').open) $('#settingsDialog').close();

  $('#commandQuery').value = '';
  showDialog($('#commandDialog'));
  renderCommands();
  $('#commandQuery').focus();
}

$('#openCommands').onclick = openCommands;
$('#commandQuery').oninput = renderCommands;

$('#commandQuery').addEventListener('keydown', event => {
  if (!filteredCommands.length) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();

    commandIndex = (
      commandIndex +
      (event.key === 'ArrowDown' ? 1 : -1) +
      filteredCommands.length
    ) % filteredCommands.length;

    updateChosenCommand();
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    runCommand(commandIndex);
  }
});

$$('[data-workspace]').forEach(button => {
  button.onclick = () => {
    $$('[data-workspace]').forEach(item => {
      item.classList.toggle('active', item === button);
    });

    const workspace = button.dataset.workspace;
    setMode({
      layout: 'shaded',
      modeling: 'solid',
      shading: 'shaded',
      rendering: 'rendered'
    }[workspace]);

    if (workspace === 'shading') {
      $('#materialSection').scrollIntoView({ block: 'start' });
    }
    if (workspace === 'rendering') {
      $('#renderSection').scrollIntoView({ block: 'start' });
    }
  };
});

document.addEventListener('click', event => {
  if (!event.target.closest('details.menu')) closeMenus();
});

document.addEventListener('keydown', event => {
  const key = event.key.toLowerCase();

  if ((event.ctrlKey || event.metaKey) && key === 'k') {
    event.preventDefault();
    if ($('#commandDialog').open) $('#commandDialog').close();
    else openCommands();
    return;
  }

  if (
    event.target.closest('dialog') ||
    event.target.matches('input, textarea, select') ||
    event.target.isContentEditable
  ) return;

  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && key === 'y') {
    event.preventDefault();
    redo();
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.shiftKey && key === 'd') {
    event.preventDefault();
    duplicateSelected();
    return;
  }

  if (event.shiftKey && key === 'a') {
    event.preventDefault();
    $('#addMenu').open = !$('#addMenu').open;
    return;
  }

  if (key === 'delete' || key === 'backspace') {
    event.preventDefault();
    deleteSelected();
  }

  if (key === 'g') setTool('translate');
  if (key === 'r') setTool('rotate');
  if (key === 's') setTool('scale');
  if (key === 'f') frameSelected();

  if (key === 'escape') {
    closeMenus();
    select(null);
  }
});

renderer.domElement.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  contextLost = true;
  $('#status').textContent = 'Graphics context lost. Reload the page to restart.';
  toast('The GPU context was lost. Reload to restart; unsaved scene changes may be lost.', 15000);
});

window.addEventListener('beforeunload', () => {
  importedURLs.forEach(url => URL.revokeObjectURL(url));
});

new ResizeObserver(resizeViewport).observe(viewport);

// Rendering.
function rasterRender() {
  renderer.autoClear = true;
  scene.overrideMaterial =
    mode === 'solid' ? solidMaterial :
    mode === 'wire' ? wireMaterial : null;

  renderer.render(scene, camera);
  scene.overrideMaterial = null;

  if (!isTracing()) {
    selectionBox.visible = !!selected &&
      !selected.isLight &&
      isEffectivelyVisible(selected);

    if (selectionBox.visible) selectionBox.setFromObject(selected);

    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(editorScene, camera);
    renderer.autoClear = true;
  }
}

function updateRenderHUD(now) {
  if (now - lastHUD < 150) return;
  lastHUD = now;

  const target = Number($('#samples').value);
  const sampleCount = Math.floor(tracer?.samples || 0);

  $('#sampleStatus').textContent = `${sampleCount} / ${target} samples`;
  $('#progressFill').style.width =
    Math.min(100, sampleCount / target * 100) + '%';

  $('#renderInfo').textContent =
    `${sampleCount} samples · ${$('#bounces').value} bounces` +
    (tracePaused ? ' · paused' : '');

  $('#status').textContent = tracePaused
    ? 'Path tracing paused — Resume to update the image'
    : (tracer?.samples || 0) >= target
      ? 'Sample target reached — save PNG or increase samples'
      : `Tracing indirect light with ${$('#bounces').value} bounces…`;
}

function animate(now = 0) {
  requestAnimationFrame(animate);

  if (document.hidden || contextLost) return;
  if (now - lastFrame < 1000 / preferences.fps - .5) return;
  lastFrame = now;

  orbit.update();

  if (isTracing() && tracer) {
    try {
      if (!tracePaused) {
        scene.overrideMaterial = null;

        if (geometryDirty) {
          scene.updateMatrixWorld(true);
          camera.updateMatrixWorld(true);

          tracer.setScene(scene, camera);

          geometryDirty = false;
          cameraDirty = false;
        } else if (cameraDirty) {
          camera.updateMatrixWorld(true);
          tracer.updateCamera();
          cameraDirty = false;
        }

        if (tracer.samples < Number($('#samples').value)) {
          tracer.renderSample();
        }
      }

      updateRenderHUD(now);
    } catch (error) {
      console.error(error);
      toast(
        'Path tracing failed on this scene or GPU. Switched to shaded preview.',
        8000
      );
      setMode('shaded');
      rasterRender();
    }
  } else {
    rasterRender();
  }
}

// Initial scene.
content.add(makeRoom());
select(null);
applyAllPreferences();
resizeViewport();

if (matchMedia('(max-width: 520px)').matches) {
  toggleFocusMode();
}

$('#status').textContent = 'Ready — Ctrl/Cmd K opens commands';
requestAnimationFrame(animate);
