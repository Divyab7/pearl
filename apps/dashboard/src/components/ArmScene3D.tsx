// The three.js scene behind ArmView3D (loaded lazily, so three.js stays out of the main bundle).
// Built in the MuJoCo model's frame (sim/mujoco/pearl_mujoco/model.py: metres, x forward, y left, z up) under one
// root group turned so z is up on screen, with the same link lengths, servo mapping and slot/bin placement: slots sit
// where each slot's "down" pose in config/arm.json puts the grasp point, exactly as the simulator places them.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import arm from "../../../../config/arm.json";
import type { ArmProps } from "./ArmView3D";

// geometry (metres), from model.py
const BASE_H = 0.07, UPPER = 0.1, FORE = 0.09, GRASP = 0.03, CUBE = 0.025;
const FINGER_OPEN = 0.024, FINGER_CLOSED = 0.002, POST_HALF = 0.01, BIN_HALF = 0.04, BIN_WALL = 0.035;
const ORANGE = 0xf28c1a, DARK = 0x333338, PLATE = 0x26262b, FINGER = 0xd9d9d9, POST = 0x8c8c99, BIN = 0x4d4d59;
const RAD = Math.PI / 180;

/** Servo degrees -> (base yaw, shoulder pitch, elbow pitch) in radians and finger offset (m): model.py servo_to_qpos. */
function toQ(deg: number[]) {
  const [b, s, e, g] = deg as [number, number, number, number];
  const frac = Math.min(1, Math.max(0, (g - arm.gripOpen) / (arm.gripClosed - arm.gripOpen || 1)));
  return { yaw: (b - 90) * RAD, sh: (s - 90) * RAD, el: (90 - e) * RAD, finger: FINGER_OPEN + (FINGER_CLOSED - FINGER_OPEN) * frac };
}

/** Grasp point of a pose by forward kinematics (shoulder at BASE_H, upper arm along z, forearm along x). */
function grasp(deg: number[]) {
  const { yaw, sh, el } = toQ(deg);
  const r = UPPER * Math.sin(sh) + (FORE + GRASP) * Math.cos(sh + el);
  const z = BASE_H + UPPER * Math.cos(sh) - (FORE + GRASP) * Math.sin(sh + el);
  return { x: r * Math.cos(yaw), y: r * Math.sin(yaw), z, yaw };
}

const SLOT_IDS = ["A1", "A2", "A3"] as const;
const SLOTS = arm.slots as Record<string, { above: number[]; down: number[] }>;
const LAYOUT = Object.fromEntries(Object.keys(SLOTS).map((id) => [id, grasp(SLOTS[id]!.down)]));
const VIEW = { target: new THREE.Vector3(0.1, 0, 0.07), from: new THREE.Vector3(0.5, -0.29, 0.36) }; // MuJoCo frame

const RING_TOKEN: Record<string, string> = { red: "--bad", amber: "--warn", blue: "--accent", cyan: "--info", green: "--ok", white: "--text" };

type Scene = { slots?: Record<string, string | null>; bin?: string[]; holding?: string | null } | null | undefined;

export default function ArmScene3D({ joints, scene, ring, label, showAngles = true, description }: ArmProps & { description: string }) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ setPose: (j: number[]) => void; setScene: (s: Scene) => void; setRing: (r: string) => void } | null>(null);
  const j = joints ?? arm.home;

  useEffect(() => {
    const el = host.current!;
    const css = () => getComputedStyle(el);
    const token = (name: string, fallback: string) => css().getPropertyValue(name).trim() || fallback;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ------------------------------------------------------------ renderer, camera, controls
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.NoToneMapping;
    const canvas = renderer.domElement;
    canvas.className = "arm3d-canvas";
    canvas.setAttribute("role", "img");
    el.appendChild(canvas);
    const labels = new CSS2DRenderer();
    labels.domElement.className = "arm3d-labels";
    labels.domElement.setAttribute("aria-hidden", "true");
    el.appendChild(labels.domElement);

    const world = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    world.environment = env;
    world.environmentIntensity = 0.35;

    const root = new THREE.Group(); // MuJoCo frame: z up
    root.rotation.x = -Math.PI / 2;
    world.add(root);
    const toWorld = (v: THREE.Vector3) => new THREE.Vector3(v.x, v.z, -v.y);

    const camera = new THREE.PerspectiveCamera(32, 4 / 3, 0.01, 10);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 0.22;
    controls.maxDistance = 1.3;
    controls.maxPolarAngle = Math.PI / 2 - 0.06; // stay above the table
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 0.8;
    const home = { target: toWorld(VIEW.target), pos: toWorld(VIEW.from) };
    camera.position.copy(home.pos);
    controls.target.copy(home.target);
    controls.update();
    let resetting = false;
    const onReset = () => {
      resetting = true;
      wake();
    };
    canvas.addEventListener("dblclick", onReset);
    controls.addEventListener("start", () => (resetting = false));

    // ------------------------------------------------------------ lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
    world.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.copy(toWorld(new THREE.Vector3(0.25, -0.35, 0.9)));
    sun.target.position.copy(home.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -0.35;
    sun.shadow.camera.right = 0.35;
    sun.shadow.camera.top = 0.35;
    sun.shadow.camera.bottom = -0.35;
    sun.shadow.camera.near = 0.2;
    sun.shadow.camera.far = 1.6;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.002;
    sun.shadow.radius = 4;
    world.add(sun, sun.target);

    // ------------------------------------------------------------ helpers
    const mats = new Map<string, THREE.MeshStandardMaterial>();
    const mat = (key: string, color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) => {
      let m = mats.get(key);
      if (!m) mats.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...extra })));
      return m;
    };
    const mesh = (geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, at?: [number, number, number]) => {
      const x = new THREE.Mesh(geo, m);
      x.castShadow = true;
      x.receiveShadow = true;
      if (at) x.position.set(...at);
      parent.add(x);
      return x;
    };
    const cylZ = (r: number, h: number, seg = 40) => new THREE.CylinderGeometry(r, r, h, seg).rotateX(Math.PI / 2); // axis z
    const cylY = (r: number, h: number) => new THREE.CylinderGeometry(r, r, h, 24); // axis y (joint axes)
    const label = (text: string, parent: THREE.Object3D, at: [number, number, number]) => {
      const d = document.createElement("span");
      d.className = "arm3d-label";
      d.textContent = text;
      const o = new CSS2DObject(d);
      o.position.set(...at);
      parent.add(o);
    };

    // ------------------------------------------------------------ table
    const table = mesh(new THREE.CircleGeometry(0.42, 96), mat("table", 0x888888, { roughness: 0.9 }), root, [0.08, 0, 0]);
    table.castShadow = false;
    const rim = new THREE.Mesh(new THREE.RingGeometry(0.418, 0.422, 96), new THREE.MeshBasicMaterial({ color: 0x888888 }));
    rim.position.set(0.08, 0, 0.0002);
    root.add(rim);
    const grid = new THREE.PolarGridHelper(0.42, 12, 7, 96);
    const gridMat = grid.material as THREE.LineBasicMaterial;
    gridMat.vertexColors = false;
    gridMat.transparent = true;
    gridMat.depthWrite = false;
    grid.position.set(0.08, 0.0003, 0); // three.js frame: the helper lies in x-z
    world.add(grid);

    // ------------------------------------------------------------ arm (bodies as in model.py)
    const plate = mesh(cylZ(0.055, 0.012), mat("plate", PLATE), root, [0, 0, 0.007]);
    plate.castShadow = true;
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0x000000, roughness: 0.4 });
    const ringMesh = mesh(new THREE.TorusGeometry(0.052, 0.0032, 12, 64), ringMat, root, [0, 0, 0.0135]);
    ringMesh.castShadow = false;
    const turret = new THREE.Group();
    turret.position.z = 0.012;
    root.add(turret);
    mesh(cylZ(0.03, 0.05), mat("orange", ORANGE), turret, [0, 0, 0.025]);
    const shoulderHub = mesh(cylY(0.016, 0.05), mat("dark", DARK), turret, [0, 0, BASE_H - 0.012]);
    shoulderHub.castShadow = true;
    const upper = new THREE.Group();
    upper.position.z = BASE_H - 0.012;
    turret.add(upper);
    mesh(new THREE.CapsuleGeometry(0.011, UPPER, 8, 24).rotateX(Math.PI / 2), mat("orange", ORANGE), upper, [0, 0, UPPER / 2]);
    const fore = new THREE.Group();
    fore.position.z = UPPER;
    upper.add(fore);
    mesh(cylY(0.013, 0.036), mat("dark", DARK), fore);
    mesh(new THREE.CapsuleGeometry(0.009, FORE - 0.008, 8, 24).rotateZ(-Math.PI / 2), mat("dark", DARK), fore, [(FORE - 0.008) / 2, 0, 0]);
    const palm = new THREE.Group();
    palm.position.x = FORE;
    fore.add(palm);
    mesh(new THREE.BoxGeometry(0.012, 0.064, 0.02), mat("dark", DARK), palm);
    const fingerGeo = new THREE.BoxGeometry(0.044, 0.008, 0.016);
    const fl = mesh(fingerGeo, mat("finger", FINGER, { roughness: 0.4 }), palm, [0.026, FINGER_OPEN, 0]);
    const fr = mesh(fingerGeo, mat("finger", FINGER), palm, [0.026, -FINGER_OPEN, 0]);

    // ------------------------------------------------------------ slots and bin (placed by forward kinematics)
    const cubeGeo = new THREE.BoxGeometry(CUBE, CUBE, CUBE);
    const slotTop: Record<string, number> = {};
    for (const id of SLOT_IDS) {
      const p = LAYOUT[id]!;
      const top = Math.max(0.004, p.z - CUBE / 2);
      slotTop[id] = top;
      const post = mesh(new THREE.BoxGeometry(POST_HALF * 2, POST_HALF * 2, top), mat("post", POST), root, [p.x, p.y, top / 2]);
      post.rotation.z = p.yaw;
      const r = Math.hypot(p.x, p.y) + 0.045;
      label(id, root, [r * Math.cos(p.yaw), r * Math.sin(p.yaw), 0.002]);
    }
    const B = LAYOUT.BIN!;
    const bin = new THREE.Group();
    bin.position.set(B.x, B.y, 0);
    bin.rotation.z = B.yaw;
    root.add(bin);
    const t = 0.003, h = BIN_WALL / 2;
    const walls: [number, number, number, number, number, number][] = [
      [0, 0, 0.002, BIN_HALF, BIN_HALF, 0.002],
      [BIN_HALF, 0, h, t, BIN_HALF, h],
      [-BIN_HALF, 0, h, t, BIN_HALF, h],
      [0, BIN_HALF, h, BIN_HALF, t, h],
      [0, -BIN_HALF, h, BIN_HALF, t, h],
    ];
    for (const [px, py, pz, sx, sy, sz] of walls) mesh(new THREE.BoxGeometry(sx * 2, sy * 2, sz * 2), mat("bin", BIN), bin, [px, py, pz]);
    label("BIN", bin, [BIN_HALF + 0.03, 0, 0.002]);

    // ------------------------------------------------------------ cubes (rebuilt when the scene changes)
    const cubes = new THREE.Group();
    root.add(cubes);
    const held = new THREE.Group();
    held.position.x = GRASP;
    palm.add(held);
    let holding = false;
    const cubeMat = (c: string) => mat(`cube-${c}`, c === "red" ? token("--red-cube", "#d93434") : c === "blue" ? token("--blue-cube", "#3552d6") : c, { roughness: 0.45 });
    const setScene = (s: Scene) => {
      cubes.clear();
      held.clear();
      if (!s) {
        holding = false;
        return;
      }
      for (const id of SLOT_IDS) {
        const c = s.slots?.[id];
        if (!c) continue;
        const p = LAYOUT[id]!;
        const m = mesh(cubeGeo, cubeMat(c), cubes, [p.x, p.y, slotTop[id]! + CUBE / 2 + 0.0005]);
        m.rotation.z = p.yaw;
      }
      (s.bin ?? []).forEach((c, i) => {
        const m = mesh(cubeGeo, cubeMat(c), bin, [(i % 2 ? 1 : -1) * 0.009, ((i >> 1) % 2 ? 1 : -1) * 0.006, 0.004 + CUBE / 2 + Math.floor(i / 4) * CUBE]);
        m.rotation.z = (i * 0.4) % 1;
      });
      holding = !!s.holding;
      if (s.holding) mesh(cubeGeo, cubeMat(s.holding), held);
      wake();
    };

    // ------------------------------------------------------------ pose (eased toward the latest telemetry)
    const target = [...arm.home];
    const cur = [...arm.home];
    let first = true;
    const apply = () => {
      const q = toQ(cur);
      turret.rotation.z = q.yaw;
      upper.rotation.y = q.sh;
      fore.rotation.y = q.el;
      const f = holding ? Math.max(q.finger, CUBE / 2 + 0.004) : q.finger; // fingers rest on the cube's faces
      fl.position.y = f;
      fr.position.y = -f;
    };
    const setPose = (jn: number[]) => {
      jn.forEach((v, i) => (target[i] = v));
      if (first || reduce) {
        first = false;
        target.forEach((v, i) => (cur[i] = v));
        apply();
      }
      wake();
    };

    // ------------------------------------------------------------ theme
    const setTheme = () => {
      const bg = new THREE.Color(token("--card", "#171b22"));
      world.background = bg;
      const dark = bg.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
      mats.get("table")!.color.set(token("--raise", "#1d222b")).offsetHSL(0, 0, dark ? 0.03 : -0.07);
      (rim.material as THREE.MeshBasicMaterial).color.set(token("--border-strong", "#343b47"));
      gridMat.color.set(token("--border-strong", "#343b47"));
      gridMat.opacity = 0.5;
      hemi.intensity = dark ? 0.7 : 1.1;
      hemi.groundColor.set(dark ? 0x222222 : 0x888888);
      for (const [k, m] of mats) if (k.startsWith("cube-")) m.color.set(k === "cube-red" ? token("--red-cube", "#d93434") : k === "cube-blue" ? token("--blue-cube", "#3552d6") : k.slice(5));
      setRing(ringNow);
    };
    let ringNow = "";
    const setRing = (r: string) => {
      ringNow = r;
      const tok = RING_TOKEN[r];
      if (tok) {
        const c = new THREE.Color(token(tok, "#8fa8ff"));
        ringMat.color.copy(c);
        ringMat.emissive.copy(c);
        ringMat.emissiveIntensity = 0.9;
      } else {
        ringMat.color.set(token("--text-3", "#8a93a3"));
        ringMat.emissive.set(0x000000);
      }
      wake();
    };
    const themeObs = new MutationObserver(() => {
      setTheme();
      wake();
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // ------------------------------------------------------------ size, visibility, loop
    let w = 0, hgt = 0;
    const resize = () => {
      w = el.clientWidth;
      hgt = el.clientHeight;
      if (!w || !hgt) return;
      renderer.setSize(w, hgt, false);
      labels.setSize(w, hgt);
      camera.aspect = w / hgt;
      camera.updateProjectionMatrix();
      wake();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    let onScreen = true;
    const io = new IntersectionObserver(([e]) => {
      onScreen = !!e?.isIntersecting;
      wake();
    });
    io.observe(el);
    const onVis = () => wake();
    document.addEventListener("visibilitychange", onVis);
    controls.addEventListener("change", () => wake());

    let raf = 0, last = 0, dirty = true, idle = 0;
    function wake() {
      dirty = true;
      if (!raf && onScreen && !document.hidden && w && hgt) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }
    function frame(now: number) {
      raf = 0;
      if (!onScreen || document.hidden) return; // resumes on the next wake()
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      let moving = false;
      const k = 1 - Math.exp(-dt * 9);
      for (let i = 0; i < 4; i++) {
        const d = target[i]! - cur[i]!;
        if (Math.abs(d) > 0.05) {
          cur[i]! += d * k;
          moving = true;
        } else cur[i] = target[i]!;
      }
      if (moving) apply();
      if (resetting) {
        const kk = 1 - Math.exp(-dt * 8);
        camera.position.lerp(home.pos, kk);
        controls.target.lerp(home.target, kk);
        if (camera.position.distanceTo(home.pos) < 0.0005) resetting = false;
      }
      const changed = controls.update(dt);
      if (moving || changed || dirty || resetting) {
        renderer.render(world, camera);
        labels.render(world, camera);
        dirty = false;
        idle = 0;
      } else idle++;
      // keep ticking briefly after the last change so damping settles, then sleep until the next wake()
      if (idle < 30) raf = requestAnimationFrame(frame);
    }

    setTheme();
    apply();
    api.current = { setPose, setScene, setRing };
    resize();

    return () => {
      api.current = null;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      themeObs.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("dblclick", onReset);
      controls.dispose();
      world.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      });
      cubeGeo.dispose();
      fingerGeo.dispose();
      mats.forEach((m) => m.dispose());
      ringMat.dispose();
      env.dispose();
      pmrem.dispose();
      sun.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      labels.domElement.remove();
    };
  }, []);

  const sceneKey = JSON.stringify(scene ?? null);
  useEffect(() => api.current?.setScene(scene), [sceneKey]);
  useEffect(() => api.current?.setPose(j), [j.join(",")]);
  useEffect(() => api.current?.setRing(ring ?? ""), [ring]);
  useEffect(() => {
    host.current?.querySelector("canvas")?.setAttribute("aria-label", description);
  }, [description]);

  return (
    <figure className="armfig">
      {(label || showAngles) && (
        <figcaption className="armcap">
          <span>{label}</span>
          {showAngles && <span className="tabular">Base {j[0]}° · Shoulder {j[1]}° · Elbow {j[2]}° · Gripper {j[3]}°</span>}
        </figcaption>
      )}
      <div className="arm3d" ref={host} title="Drag to rotate · scroll to zoom · double-click to reset" />
    </figure>
  );
}
