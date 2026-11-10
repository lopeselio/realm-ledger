// The war table in 3D: a painted terrain board on a wooden table at night, with the
// Blender-built miniatures (tools/blender/build_assets.py). It draws the same GameState the
// 2D map does, and reports province picks so orders work the same way.
import * as THREE from 'three/webgpu';
import { color, mix, positionWorld, sin, time, vec3 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { troopCount, type GameState } from '@realm-ledger/rules';
import { colorOf, type Overlay } from './map.ts';
import { TIMING, type SeasonScript } from './playback.ts';

const SQRT3 = Math.sqrt(3);
const toXZ = (q: number, r: number): [number, number] => [SQRT3 * (q + r / 2), 1.5 * r];

const HEIGHT: Record<string, number> = { sea: 0.06, plains: 0.22, forest: 0.24, hills: 0.38, pass: 0.34, mountains: 0.62 };
const PAINT: Record<string, string> = {
  plains: '#93a35d',
  forest: '#4d6e3d',
  hills: '#97845f',
  pass: '#8a7e6c',
  mountains: '#6d665f',
};
const AUTUMN = new THREE.Color('#b9873a');
const FROST = new THREE.Color('#e9eef2');

type Model = 'soldier' | 'keep' | 'town' | 'fort' | 'tree';

export interface Table3D {
  setState(s: GameState, overlay?: Overlay & { visible?: Set<number>; focus?: number }): void;
  /** plays a settled season over the board as it now stands */
  play(s: GameState, script: SeasonScript): void;
  /** ends a playback early */
  stopPlayback(): void;
  onPick(cb: (province: number) => void): void;
  onHover(cb: (province: number | null, x: number, y: number) => void): void;
  dispose(): void;
}

/** Whether this browser can draw the 3D table at all. */
export function canRender3D(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(navigator as Navigator & { gpu?: unknown }).gpu || !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

async function loadModels(): Promise<Record<Model, THREE.Object3D>> {
  const loader = new GLTFLoader();
  const names: Model[] = ['soldier', 'keep', 'town', 'fort', 'tree'];
  const scenes = await Promise.all(names.map((n) => loader.loadAsync(`/models/${n}.glb`).then((g) => g.scene)));
  const out = {} as Record<Model, THREE.Object3D>;
  names.forEach((n, i) => {
    const root = scenes[i]!;
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    out[n] = root;
  });
  return out;
}

/** A model copy whose "Enamel" material is painted in a realm's colour. */
function painted(model: THREE.Object3D, hex: string, cache: Map<string, THREE.Material>): THREE.Object3D {
  const copy = model.clone(true);
  copy.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (m: THREE.Material): THREE.Material => {
      if (m.name !== 'Enamel') return m;
      let paintedMat = cache.get(hex);
      if (!paintedMat) {
        paintedMat = (m as THREE.MeshStandardMaterial).clone();
        (paintedMat as THREE.MeshStandardMaterial).color = new THREE.Color(hex);
        cache.set(hex, paintedMat);
      }
      return paintedMat;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  return copy;
}

/** Wood grain for the table, drawn on a canvas. */
function woodTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a2516';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 140; i++) {
    const y = (i / 140) * 512 + Math.sin(i * 1.7) * 6;
    g.strokeStyle = `rgba(${20 + (i % 7) * 6}, ${12 + (i % 5) * 4}, 6, ${0.25 + (i % 3) * 0.1})`;
    g.lineWidth = 1 + (i % 4);
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 4);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 4);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A small round label sprite for an army's troop count. */
function countSprite(n: number, hex: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = hex;
  g.beginPath();
  g.arc(32, 32, 26, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = '#efe3c8';
  g.stroke();
  g.fillStyle = '#fff';
  g.font = 'bold 28px Alegreya Sans, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(0.42, 0.42, 1);
  s.renderOrder = 10;
  return s;
}

function hexRing(outer: number, inner: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i <= 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    const p = [outer * Math.cos(a), outer * Math.sin(a)] as const;
    if (i === 0) shape.moveTo(...p);
    else shape.lineTo(...p);
  }
  const hole = new THREE.Path();
  for (let i = 0; i <= 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    const p = [inner * Math.cos(a), inner * Math.sin(a)] as const;
    if (i === 0) hole.moveTo(...p);
    else hole.lineTo(...p);
  }
  shape.holes.push(hole);
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  return g;
}

export async function createTable3D(container: HTMLElement): Promise<Table3D> {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  await renderer.init();
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#120d09');
  scene.fog = new THREE.Fog('#120d09', 40, 90);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  camera.position.set(0, 22, 24);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.42;
  controls.minDistance = 8;
  controls.maxDistance = 48;
  controls.target.set(0, 0, 0);

  // lighting: a warm lamp casting shadows, two candles, and a cool fill
  scene.add(new THREE.HemisphereLight('#9fb0c8', '#2a1a10', 0.55));
  const lamp = new THREE.DirectionalLight('#ffe6c8', 2.4);
  lamp.position.set(-14, 26, 10);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(2048, 2048);
  const sc = lamp.shadow.camera as THREE.OrthographicCamera;
  sc.left = -22;
  sc.right = 22;
  sc.top = 22;
  sc.bottom = -22;
  sc.far = 80;
  lamp.shadow.bias = -0.0005;
  scene.add(lamp);
  const candles = [new THREE.PointLight('#ffb15e', 26, 26, 1.6), new THREE.PointLight('#ffb15e', 20, 22, 1.6)];
  candles[0]!.position.set(17, 3, 12);
  candles[1]!.position.set(-18, 3, -11);
  for (const c of candles) scene.add(c);

  // the table itself
  const table = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.7 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.02;
  table.receiveShadow = true;
  scene.add(table);

  // the sea: glazed resin, its colour drifting slowly (TSL)
  const seaMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.15, metalness: 0.1 });
  const wave = sin(positionWorld.x.mul(0.7).add(positionWorld.z.mul(0.45)).add(time.mul(0.6))).mul(0.5).add(0.5);
  seaMat.colorNode = mix(color('#173843'), color('#2c6370'), wave.mul(0.55));
  seaMat.emissiveNode = vec3(0.0, 0.015, 0.02).mul(wave);

  const models = await loadModels();
  const enamelCache = new Map<string, THREE.Material>();
  const board = new THREE.Group();
  const pieces = new THREE.Group();
  const marks = new THREE.Group();
  // a season's playback: short-lived pieces moved by the render loop
  const effects = new THREE.Group();
  scene.add(board, pieces, marks, effects);
  type Effect = { start: number; end: number; step: (k: number) => void; done: () => void };
  let running: Effect[] = [];
  function stopPlayback(): void {
    for (const e of running) e.done();
    running = [];
  }
  // the battle flash: one light always in the scene, dark until a clash (adding and removing a
  // light would recompile every lit material on the table mid-playback); it lights the first
  // battle, the others flash by their rings alone
  const flash = new THREE.PointLight('#ffcf7a', 0, 6, 1.5);
  effects.add(flash);

  let pickTiles: THREE.Mesh[] = [];
  const tileProvince = new Map<THREE.Object3D, number>();
  let boardKey = '';
  let tileByProvince = new Map<number, THREE.Mesh>();
  let baseColors = new Map<number, THREE.Color>();
  /** where a province's centre sits on the board */
  const provinceXZ = (s: GameState, id: number): [number, number] => {
    const p = s.map.provinces[id]!;
    return toXZ(p.q, p.r);
  };
  /** the height of a province's tile top, where pieces stand */
  const top = (id: number): number => (tileByProvince.get(id)?.userData.top as number | undefined) ?? 0.2;

  function buildBoard(s: GameState): void {
    board.clear();
    tileProvince.clear();
    tileByProvince = new Map();
    baseColors = new Map();
    pickTiles = [];
    const geo = new Map<number, THREE.CylinderGeometry>();
    const prism = (h: number): THREE.CylinderGeometry => {
      let g = geo.get(h);
      if (!g) {
        g = new THREE.CylinderGeometry(0.97, 0.99, h, 6);
        g.translate(0, h / 2, 0);
        geo.set(h, g);
      }
      return g;
    };
    const xs = s.map.tiles.map((t) => toXZ(t.q, t.r)[0]);
    const zs = s.map.tiles.map((t) => toXZ(t.q, t.r)[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    board.position.set(-cx, 0, -cz);
    // frame the land, not the whole sea around it
    const land = s.map.tiles.filter((t) => t.kind !== 'sea').map((t) => toXZ(t.q, t.r));
    const span = Math.max(
      Math.max(...land.map((p) => p[0])) - Math.min(...land.map((p) => p[0])),
      Math.max(...land.map((p) => p[1])) - Math.min(...land.map((p) => p[1])),
    );
    const lx = (Math.max(...land.map((p) => p[0])) + Math.min(...land.map((p) => p[0]))) / 2 - cx;
    const lz = (Math.max(...land.map((p) => p[1])) + Math.min(...land.map((p) => p[1]))) / 2 - cz;
    controls.target.set(lx, 0, lz);
    const d = span * 0.78 + 4;
    camera.position.set(lx, d * 0.82, lz + d * 0.72);
    controls.update();
    pieces.position.copy(board.position);
    marks.position.copy(board.position);
    effects.position.copy(board.position);

    for (const t of s.map.tiles) {
      const [x, z] = toXZ(t.q, t.r);
      const h = HEIGHT[t.kind]! + (t.kind === 'sea' ? 0 : Math.max(0, t.elevation - 0.4) * 0.3);
      const mat = t.kind === 'sea' ? seaMat : new THREE.MeshStandardMaterial({ color: PAINT[t.kind]!, roughness: 0.82, flatShading: true });
      const mesh = new THREE.Mesh(prism(Math.round(h * 100) / 100), mat);
      mesh.position.set(x, 0, z);
      mesh.receiveShadow = true;
      mesh.castShadow = t.kind !== 'sea';
      board.add(mesh);
      if (t.kind === 'mountains') {
        const peak = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.9, 5), new THREE.MeshStandardMaterial({ color: '#7b736b', roughness: 0.9, flatShading: true }));
        peak.position.set(x, h + 0.42, z);
        peak.rotation.y = (t.q * 13 + t.r * 7) % 6;
        peak.castShadow = true;
        board.add(peak);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.3, 5), new THREE.MeshStandardMaterial({ color: '#e8ecef', roughness: 0.7, flatShading: true }));
        cap.position.set(x, h + 0.75, z);
        cap.rotation.y = peak.rotation.y;
        board.add(cap);
      }
      if (t.province >= 0) {
        tileProvince.set(mesh, t.province);
        tileByProvince.set(t.province, mesh);
        baseColors.set(t.province, new THREE.Color(PAINT[t.kind]!));
        pickTiles.push(mesh);
        mesh.userData.top = h;
        const p = s.map.provinces[t.province]!;
        if (p.terrain === 'forest') {
          for (const [dx, dz, sz] of [[-0.35, -0.2, 1.3], [0.32, -0.28, 1.1], [0.05, 0.35, 1.2], [-0.4, 0.3, 0.9]] as const) {
            const tree = models.tree.clone(true);
            tree.position.set(x + dx, h, z + dz);
            tree.scale.setScalar(sz * 1.6);
            board.add(tree);
          }
        }
        if (p.river) {
          const river = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.16), new THREE.MeshStandardMaterial({ color: '#4f8fa8', roughness: 0.2 }));
          river.rotation.x = -Math.PI / 2;
          river.rotation.z = ((t.q * 3 + t.r) % 3) * (Math.PI / 3);
          river.position.set(x, h + 0.005, z);
          board.add(river);
        }
      }
    }
  }

  // Freeing GPU resources while a frame may still use them breaks WebGPU, so everything a
  // draw needs is cached and reused: labels by (count, colour), arrows by (from, to).
  const clearOwned = (g: THREE.Group): void => {
    g.clear();
  };
  const labelMats = new Map<string, THREE.SpriteMaterial>();
  const label = (n: number, hex: string): THREE.Sprite => {
    const key = `${n}:${hex}`;
    let mat = labelMats.get(key);
    if (!mat) {
      mat = countSprite(n, hex).material;
      labelMats.set(key, mat);
    }
    const s = new THREE.Sprite(mat);
    s.scale.set(0.42, 0.42, 1);
    s.renderOrder = 10;
    return s;
  };
  const arrowGeos = new Map<string, { tube: THREE.TubeGeometry; tip: THREE.Vector3; back: THREE.Vector3 }>();
  const headGeo = new THREE.ConeGeometry(0.12, 0.28, 8);

  const ring = hexRing(0.95, 0.8);
  const ringMats = new Map<string, THREE.MeshStandardMaterial>();
  const ringMat = (hex: string): THREE.MeshStandardMaterial => {
    let m = ringMats.get(hex);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.35, emissive: hex, emissiveIntensity: 0.12 });
      ringMats.set(hex, m);
    }
    return m;
  };
  // fog of war: a pale bank of mist over ground you cannot see
  const fogMat = new THREE.MeshStandardMaterial({ color: '#b3bcc8', transparent: true, opacity: 0.5, depthWrite: false, roughness: 1 });
  const fogGeo = new THREE.CylinderGeometry(1.0, 0.92, 0.22, 6);
  const targetMat = new THREE.MeshBasicMaterial({ color: '#f5d76e', transparent: true, opacity: 0.35, depthWrite: false });
  const selectMat = new THREE.MeshBasicMaterial({ color: '#fff4c2' });

  function setState(s: GameState, overlay: Overlay & { visible?: Set<number>; focus?: number } = {}): void {
    const key = `${s.seed}:${s.map.provinces.length}`;
    if (key !== boardKey) {
      // a playback of the old map ends with it
      stopPlayback();
      buildBoard(s);
      boardKey = key;
      // in play, start over the player's own capital
      if (overlay.focus !== undefined) {
        const p = s.map.provinces[overlay.focus]!;
        const [fx, fz] = toXZ(p.q, p.r);
        const tx = fx + board.position.x;
        const tz = fz + board.position.z;
        controls.target.set(tx, 0, tz);
        camera.position.set(tx, 15, tz + 13);
        controls.update();
      }
    }
    // season paint: autumn ochre, winter frost
    const season = s.season % 4;
    for (const [id, mesh] of tileByProvince) {
      const c = baseColors.get(id)!.clone();
      if (season === 2) c.lerp(AUTUMN, 0.22);
      if (season === 3) c.lerp(FROST, 0.45);
      // update the colour in place: the GPU material keeps a reference to this object
      (mesh.material as THREE.MeshStandardMaterial).color.copy(c);
    }

    clearOwned(pieces);
    clearOwned(marks);
    const at = (id: number): [number, number] => provinceXZ(s, id);
    const capitals = new Map(s.realms.filter((r) => r.alive).map((r) => [r.capital, r.id]));

    for (const p of s.map.provinces) {
      const [x, z] = at(p.id);
      const y = top(p.id);
      const owner = s.owner[p.id]!;
      const hex = owner >= 0 ? colorOf(owner) : '#9a8f80';
      if (owner >= 0) {
        const r = new THREE.Mesh(ring, ringMat(hex));
        r.position.set(x, y + 0.01, z);
        marks.add(r);
      }
      if (capitals.has(p.id)) {
        const k = painted(models.keep, hex, enamelCache);
        k.position.set(x - 0.25, y, z - 0.2);
        // a capital grown into a city stands taller too
        k.scale.setScalar(s.cities?.[p.id] ? 2.1 : 1.6);
        pieces.add(k);
      } else if (s.towns[p.id]) {
        const t = painted(models.town, hex, enamelCache);
        t.position.set(x - 0.25, y, z - 0.2);
        // a city stands taller than a town
        t.scale.setScalar(s.cities?.[p.id] ? 2.1 : 1.5);
        pieces.add(t);
      }
      if (s.shrines?.[p.id]) {
        const sh = new THREE.Mesh(shrineGeo, shrineMat);
        sh.position.set(x + 0.3, y + 0.28, z - 0.25);
        pieces.add(sh);
      }
      if (s.forts[p.id]! > 0) {
        const f = models.fort.clone(true);
        f.position.set(x, y, z);
        f.scale.setScalar(1.0 + s.forts[p.id]! * 0.08);
        pieces.add(f);
      }
      if (overlay.visible && !overlay.visible.has(p.id)) {
        const fog = new THREE.Mesh(fogGeo, fogMat);
        // drifts at a slightly different height over each province
        fog.position.set(x, y + 0.42 + ((p.id * 37) % 10) * 0.025, z);
        fog.renderOrder = 5;
        marks.add(fog);
      }
    }

    // armies: up to three figures, with a count
    const byProvince = new Map<number, typeof s.armies>();
    for (const a of s.armies) byProvince.set(a.province, [...(byProvince.get(a.province) ?? []), a]);
    for (const [pid, armies] of byProvince) {
      const [x, z] = at(pid);
      const y = top(pid);
      armies.forEach((a, i) => {
        const hex = colorOf(a.realm);
        const n = troopCount(a);
        const figures = Math.min(3, Math.max(1, Math.ceil(n / 4)));
        const ox = 0.3 + (i - (armies.length - 1) / 2) * 0.5;
        for (let f = 0; f < figures; f++) {
          const soldier = painted(models.soldier, hex, enamelCache);
          soldier.position.set(x + ox + (f - (figures - 1) / 2) * 0.22, y, z + 0.25 + (f % 2) * 0.12);
          soldier.scale.setScalar(1.5);
          soldier.rotation.y = Math.PI * 0.15;
          pieces.add(soldier);
        }
        const tag = label(n, hex);
        tag.position.set(x + ox, y + 0.95, z + 0.25);
        pieces.add(tag);
      });
    }

    // selection, legal targets, planned marches
    for (const id of overlay.targets ?? []) {
      const [x, z] = at(id);
      const m = new THREE.Mesh(ring, targetMat);
      m.position.set(x, top(id) + 0.03, z);
      m.scale.setScalar(0.85);
      marks.add(m);
    }
    if (overlay.selected !== undefined) {
      const [x, z] = at(overlay.selected);
      const m = new THREE.Mesh(ring, selectMat);
      m.position.set(x, top(overlay.selected) + 0.04, z);
      m.scale.setScalar(1.04);
      marks.add(m);
    }
    for (const [from, to] of overlay.arrows ?? []) {
      const key = `${from}:${to}`;
      let arrow = arrowGeos.get(key);
      if (!arrow) {
        const [x1, z1] = at(from);
        const [x2, z2] = at(to);
        const y = Math.max(top(from), top(to)) + 0.6;
        const curve = new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(x1, top(from) + 0.3, z1),
          new THREE.Vector3((x1 + x2) / 2, y + 0.5, (z1 + z2) / 2),
          new THREE.Vector3(x2, top(to) + 0.3, z2),
        );
        arrow = { tube: new THREE.TubeGeometry(curve, 16, 0.045, 6), tip: curve.getPoint(1), back: curve.getPoint(0.85) };
        arrowGeos.set(key, arrow);
      }
      marks.add(new THREE.Mesh(arrow.tube, selectMat));
      const head = new THREE.Mesh(headGeo, selectMat);
      head.position.copy(arrow.tip);
      head.lookAt(arrow.back);
      head.rotateX(-Math.PI / 2);
      marks.add(head);
    }
  }

  const clashGeo = new THREE.RingGeometry(0.55, 0.75, 32);
  // a shrine: a small brass star stone
  const shrineGeo = new THREE.OctahedronGeometry(0.22);
  const shrineMat = new THREE.MeshStandardMaterial({ color: '#d9b24a', emissive: '#5a4510', roughness: 0.35, metalness: 0.6 });
  const poleGeo = new THREE.CylinderGeometry(0.025, 0.025, 1.1, 6);
  const bannerGeo = new THREE.PlaneGeometry(0.5, 0.32);
  function play(s: GameState, sc: SeasonScript): void {
    const now = performance.now();
    const at = (id: number): [number, number] => provinceXZ(s, id);
    const add = (obj: THREE.Object3D, startMs: number, forMs: number, step: (k: number) => void, materials: THREE.Material[] = []): void => {
      obj.visible = false;
      effects.add(obj);
      running.push({
        start: now + startMs,
        end: now + startMs + forMs,
        step: (k) => {
          obj.visible = true;
          step(k);
        },
        done: () => {
          effects.remove(obj);
          for (const m of materials) m.dispose();
        },
      });
    };
    const march = (realm: number, from: number, to: number, startMs: number, forMs: number): void => {
      const [x1, z1] = at(from);
      const [x2, z2] = at(to);
      const y1 = top(from);
      const y2 = top(to);
      const fig = painted(models.soldier, colorOf(realm), enamelCache);
      fig.scale.setScalar(1.7);
      fig.rotation.y = Math.atan2(x2 - x1, z2 - z1);
      add(fig, startMs, forMs, (k) => {
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        // a little hop with each stride
        fig.position.set(x1 + (x2 - x1) * e, y1 + (y2 - y1) * e + Math.abs(Math.sin(k * Math.PI * 4)) * 0.18, z1 + (z2 - z1) * e);
      });
    };
    for (const m of sc.moves) march(m.realm, m.from, m.to, TIMING.march, TIMING.marchFor);
    for (const p of sc.battles) {
      const [x, z] = at(p);
      const mat = new THREE.MeshBasicMaterial({ color: '#f5d76e', transparent: true, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(clashGeo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, top(p) + 0.08, z);
      ring.renderOrder = 6;
      add(
        ring,
        TIMING.battle,
        TIMING.battleFor,
        (k) => {
          ring.scale.setScalar(0.4 + k * 1.6);
          mat.opacity = 1 - k;
        },
        [mat],
      );
      if (p === sc.battles[0]) {
        flash.position.set(x, top(p) + 0.8, z);
        running.push({ start: now + TIMING.battle, end: now + TIMING.battle + TIMING.battleFor, step: (k) => (flash.intensity = 30 * (1 - k)), done: () => (flash.intensity = 0) });
      }
    }
    // the beaten fall back; the destroyed sink into the table
    for (const m of sc.retreats) march(m.realm, m.from, m.to, TIMING.retreat, TIMING.retreatFor);
    for (const l of sc.losses) {
      const [x, z] = at(l.province);
      const y = top(l.province);
      const fig = painted(models.soldier, colorOf(l.realm), enamelCache);
      fig.scale.setScalar(1.7);
      fig.position.set(x + 0.2, y, z + 0.2);
      add(fig, TIMING.loss, TIMING.lossFor, (k) => {
        fig.rotation.z = (k * Math.PI) / 2;
        fig.position.y = y - k * 0.35;
      });
    }
    for (const c of sc.captures) {
      const [x, z] = at(c.province);
      const y = top(c.province);
      const mat = new THREE.MeshStandardMaterial({ color: colorOf(c.realm), side: THREE.DoubleSide, transparent: true, roughness: 0.6 });
      const flag = new THREE.Group();
      flag.add(new THREE.Mesh(poleGeo, enamel('#d8c9a4')));
      const banner = new THREE.Mesh(bannerGeo, mat);
      banner.position.set(0.26, 0.38, 0);
      flag.add(banner);
      flag.position.set(x + 0.35, y, z - 0.3);
      add(
        flag,
        TIMING.capture,
        TIMING.captureFor,
        (k) => {
          const rise = Math.min(1, k / 0.25);
          flag.position.y = y + 0.55 * rise - 0.3 * (1 - rise);
          banner.rotation.y = Math.sin(k * 14) * 0.25;
          mat.opacity = k > 0.8 ? (1 - k) / 0.2 : 1;
        },
        [mat],
      );
    }
  }
  const enamel = (hex: string): THREE.Material => {
    let m = enamelCache.get(`pole:${hex}`);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.5 });
      enamelCache.set(`pole:${hex}`, m);
    }
    return m;
  };

  // picking
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pick = (ev: MouseEvent): number | null => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickTiles, false)[0];
    return hit ? (tileProvince.get(hit.object) ?? null) : null;
  };
  let pickCb: ((p: number) => void) | null = null;
  let hoverCb: ((p: number | null, x: number, y: number) => void) | null = null;
  let downAt: [number, number] | null = null;
  renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener('pointerup', (e) => {
    // a drag rotates the camera; only a click picks
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 5) {
      const p = pick(e);
      if (p !== null) pickCb?.(p);
    }
    downAt = null;
  });
  renderer.domElement.addEventListener('mousemove', (e) => {
    if (!hoverCb) return;
    const r = renderer.domElement.getBoundingClientRect();
    hoverCb(pick(e), e.clientX - r.left, e.clientY - r.top);
  });
  renderer.domElement.addEventListener('mouseleave', () => hoverCb?.(null, 0, 0));

  // sizing and the render loop
  let ready = false;
  const resize = (): void => {
    const w = container.clientWidth;
    // a hidden container has no size; WebGPU can't render into nothing
    ready = w > 0;
    if (!ready) return;
    const h = Math.max(320, Math.min(window.innerHeight - 190, w * 0.72));
    renderer.setSize(w, h, false);
    renderer.domElement.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (!ready) return;
    const t = clock.getElapsedTime();
    // candles flicker
    candles[0]!.intensity = 24 + Math.sin(t * 9.1) * 1.5 + Math.sin(t * 23.7) * 1.2;
    candles[1]!.intensity = 18 + Math.sin(t * 7.3 + 1) * 1.4 + Math.sin(t * 19.1) * 1.0;
    if (running.length) {
      const ms = performance.now();
      running = running.filter((e) => {
        if (ms < e.start) return true;
        if (ms >= e.end) {
          e.done();
          return false;
        }
        e.step((ms - e.start) / (e.end - e.start));
        return true;
      });
    }
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    setState,
    play,
    stopPlayback,
    onPick: (cb) => (pickCb = cb),
    onHover: (cb) => (hoverCb = cb),
    dispose: () => {
      // a playback cut short still frees what it made
      stopPlayback();
      for (const g of [clashGeo, poleGeo, bannerGeo, shrineGeo]) g.dispose();
      shrineMat.dispose();
      observer.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
