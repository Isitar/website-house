// Fassade 3D: web viewer for the GLBs that make_web.sh writes (one per variant, see variants.json).
// The GLB keeps Blender's level collections as nodes ("00 Base" ... "06 Outside"), so levels can be
// hidden like the eye icon in Blender. State is kept in the URL hash (#v=O.21&aus=4,5) for sharing.
// Models and PDFs are published encrypted; they are decrypted here after the password is entered.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// collection number -> chip label (order = bottom to top; "Aussen" is not a storey)
const LEVELS = [
  { n: 0, label: "Platte" },
  { n: 1, label: "EG" },
  { n: 2, label: "1. OG" },
  { n: 3, label: "2. OG" },
  { n: 4, label: "Attika" },
  { n: 5, label: "Dach" },
  { n: 6, label: "Aussen", outside: true },
];
const CACHE_SIZE = 2; // loaded variants kept in memory (phones run out of GPU memory quickly)

const $ = (id) => document.getElementById(id);
const view = $("view");

// --- renderer, scene, camera ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.AgXToneMapping; // Blender's default view transform
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const bg = () => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
scene.background = new THREE.Color(bg());
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  scene.background = new THREE.Color(bg());
  render();
});
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

// sun from the south-west, 40 deg up (as the EEVEE walk-through). glTF is y-up: Blender +y (north) = -z.
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.95;
controls.addEventListener("change", render);

// --- state ----------------------------------------------------------------------------------
let variants = [];
let current = null; // { id, root, levels: Map(n -> Object3D) }
let hidden = new Set();
let framed = false;
const cache = new Map(); // id -> { root, levels }

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath("vendor/three/examples/jsm/libs/draco/gltf/");
loader.setDRACOLoader(draco);

// --- rendering on demand (saves the phone's battery) ------------------------------------------
let pending = false;
function render() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (controls.update()) render(); // damping still moving
    renderer.render(scene, camera);
  });
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  render();
}
window.addEventListener("resize", resize);
resize();

// --- loading a variant ----------------------------------------------------------------------
function setLoading(text) {
  $("loading-text").textContent = text;
  $("loading").classList.toggle("done", !text);
}

function prepare(gltf) {
  const root = gltf.scene;
  const levels = new Map();
  root.traverse((o) => {
    const name = o.userData.name || o.name; // three replaces spaces in names, userData keeps the original
    const m = /^0(\d) /.exec(name);
    if (m && !levels.has(+m[1])) levels.set(+m[1], o);
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return { root, levels };
}

function disposeEntry(entry) {
  entry.root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const mat of [o.material].flat()) {
      for (const v of Object.values(mat)) if (v && v.isTexture) v.dispose();
      mat.dispose();
    }
  });
}

async function showVariant(id) {
  const v = variants.find((x) => x.id === id) || variants[variants.length - 1];
  $("variant").value = v.id;
  const pdf = $("pdf");
  pdf.setAttribute("aria-disabled", v.pdf ? "false" : "true");
  pdf.title = v.pdf ? `Pläne ${v.id} (PDF)` : "kein PDF für diese Variante";

  let entry = cache.get(v.id);
  if (!entry) {
    setLoading(`Variante ${v.id} lädt …`);
    try {
      const buf = await fetchDecrypted(v.glb, (p) => setLoading(`Variante ${v.id} lädt … ${p} %`));
      entry = prepare(await loader.parseAsync(buf, ""));
    } catch (err) {
      setLoading(`Fehler beim Laden von ${v.glb}`);
      console.error(err);
      return;
    }
    cache.set(v.id, entry);
    while (cache.size > CACHE_SIZE) {
      const [oldId, old] = cache.entries().next().value;
      if (old.root === current?.root) break;
      cache.delete(oldId);
      disposeEntry(old);
    }
  }
  if ($("variant").value !== v.id) return; // the user picked another variant while this one loaded

  if (current) scene.remove(current.root);
  current = { id: v.id, ...entry };
  scene.add(current.root);
  applyLevels();
  if (!framed) frame();
  setLoading("");
  writeHash();
  render();
}

// --- camera framing -------------------------------------------------------------------------
function houseBox() {
  const box = new THREE.Box3();
  for (const [n, obj] of current.levels) if (n !== 6) box.expandByObject(obj);
  return box.isEmpty() ? new THREE.Box3().setFromObject(current.root) : box;
}

function frame() {
  const box = houseBox();
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  // bird's-eye from the south-west, 35 deg up (as the PDF's bird_sw view)
  const el = THREE.MathUtils.degToRad(35);
  const dir = new THREE.Vector3(-Math.cos(el) * Math.SQRT1_2, Math.sin(el), Math.cos(el) * Math.SQRT1_2);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect)); // narrower of the two
  camera.position.copy(center).addScaledVector(dir, (radius / Math.sin(fit / 2)) * 0.8);
  controls.target.copy(center);
  controls.update();

  // shadow box round the whole site
  const all = new THREE.Box3().setFromObject(current.root);
  site = { center, r: all.getSize(new THREE.Vector3()).length() / 2 };
  placeSun();
  framed = true;
}

// --- sun: real position at a chosen date / time (Aarau Rohr) ------------------------------------
const SITE = { lat: 47.405, lon: 8.07 };  // Parzelle 7109, Aarau Rohr
const NORTH = 10;  // true north is 10 deg east of the model's +y (north arrow on 3_10 Situation)
const DAYS = [
  { id: "jun", label: "21. Juni", m: 5, d: 21 },
  { id: "mar", label: "21. März / Sept.", m: 2, d: 21 },
  { id: "dez", label: "21. Dez.", m: 11, d: 21 },
  { id: "heute", label: "heute" },
];
const HOURS = [8, 12, 18];
let site = null;               // { center, r } from frame()
let sunState = { hour: null, day: "jun" };  // hour null = the old fixed light from the south-west

// Swiss time: CET, CEST from the last Sunday of March to the last Sunday of October (01:00 UTC)
function lastSunday(y, m) { const d = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, d.getUTCDate() - d.getUTCDay(), 1); }
function swissToUtc(y, m, d, h) {
  const guess = Date.UTC(y, m, d, h - 1);
  const dst = guess >= lastSunday(y, 2) && guess < lastSunday(y, 9);
  return Date.UTC(y, m, d, h - (dst ? 2 : 1));
}

// azimuth (deg from north, clockwise) and elevation (deg) of the sun; low-precision almanac (~0.1 deg)
function sunPosition(utcMs) {
  const rad = Math.PI / 180;
  const n = utcMs / 86400000 + 2440587.5 - 2451545.0;
  const L = 280.46 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const H = ((18.697374558 + 24.06570982441908 * n) * 15 + SITE.lon) * rad - ra;
  const phi = SITE.lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { az: ((az / rad) % 360 + 360) % 360, el: el / rad };
}

function sunDirection() {
  if (sunState.hour === null) return { dir: new THREE.Vector3(-Math.cos(0.7) * Math.SQRT1_2, Math.sin(0.7), Math.cos(0.7) * Math.SQRT1_2), el: 40 };
  const now = new Date();
  const day = DAYS.find((x) => x.id === sunState.day) || DAYS[0];
  const [m, d] = day.m === undefined ? [now.getMonth(), now.getDate()] : [day.m, day.d];
  const { az, el } = sunPosition(swissToUtc(now.getFullYear(), m, d, sunState.hour));
  const a = (az - NORTH) * Math.PI / 180, e = el * Math.PI / 180;
  // model frame: x east, y north (glTF: -z); a = bearing in the model frame
  return { dir: new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)), el, az };
}

function placeSun() {
  const { dir, el, az } = sunDirection();
  const up = el > 0;
  sun.visible = up;
  // lower sun: a little weaker and warmer
  const k = Math.min(1, Math.max(0, el) / 20);
  sun.intensity = 2.2 * (0.55 + 0.45 * k);
  sun.color.setRGB(1, 0.82 + 0.18 * k, 0.65 + 0.35 * k);
  const info = $("sun-info");
  info.textContent = sunState.hour === null ? "" : up ? `Sonne ${Math.round(az)}°, ${Math.round(el)}° hoch` : "Sonne unter dem Horizont";
  if (!site) return;
  const { center, r } = site;
  sun.target.position.copy(center);
  sun.position.copy(center).addScaledVector(dir, r * 2);
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.1, far: r * 4 });
  sun.shadow.camera.updateProjectionMatrix();
}

function applySun() {
  for (const chip of $("sun").querySelectorAll(".chip")) chip.setAttribute("aria-pressed", String(+chip.dataset.h === sunState.hour));
  $("sun-day").value = sunState.day;
  placeSun();
  writeHash();
  render();
}

function buildSun() {
  const box = $("sun");
  for (const h of HOURS) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = `${h}:00`;
    chip.dataset.h = h;
    chip.addEventListener("click", () => { sunState.hour = sunState.hour === h ? null : h; applySun(); });
    box.insertBefore(chip, $("sun-info"));
  }
  const sel = $("sun-day");
  for (const d of DAYS) sel.add(new Option(d.label, d.id));
  sel.addEventListener("change", () => { sunState.day = sel.value; if (sunState.hour === null) sunState.hour = 12; applySun(); });
  applySun();
}

// --- levels ---------------------------------------------------------------------------------
function applyLevels() {
  if (current) for (const [n, obj] of current.levels) obj.visible = !hidden.has(n);
  for (const chip of $("levels").children) chip.setAttribute("aria-pressed", String(!hidden.has(+chip.dataset.n)));
  writeHash();
  render();
}

function buildChips() {
  for (const lv of LEVELS) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = lv.label;
    chip.dataset.n = lv.n;
    let timer = null;
    let long = false;
    chip.addEventListener("pointerdown", () => {
      long = false;
      timer = setTimeout(() => {
        long = true;
        // only up to here: this storey and the ones below on, the ones above off (Aussen untouched)
        if (!lv.outside) for (const o of LEVELS) if (!o.outside) (o.n <= lv.n ? hidden.delete(o.n) : hidden.add(o.n));
        applyLevels();
        navigator.vibrate?.(15);
      }, 450);
    });
    const cancel = () => clearTimeout(timer);
    chip.addEventListener("pointerleave", cancel);
    chip.addEventListener("pointercancel", cancel);
    chip.addEventListener("contextmenu", (e) => e.preventDefault());
    chip.addEventListener("click", () => {
      cancel();
      if (long) return;
      hidden.has(lv.n) ? hidden.delete(lv.n) : hidden.add(lv.n);
      applyLevels();
    });
    $("levels").appendChild(chip);
  }
}

// --- double tap / double click: orbit round the point under the finger --------------------------
const raycaster = new THREE.Raycaster();
function visibleChain(o) {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}
function focusAt(clientX, clientY) {
  if (!current) return;
  const p = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(p, camera);
  const hit = raycaster.intersectObject(current.root, true).find((h) => visibleChain(h.object));
  if (!hit) return;
  // move the camera with the target, so the view does not jump
  const shift = hit.point.clone().sub(controls.target);
  const from = controls.target.clone();
  const camFrom = camera.position.clone();
  const t0 = performance.now();
  (function step(t) {
    const k = Math.min(1, (t - t0) / 300);
    const e = k * (2 - k);
    controls.target.copy(from).addScaledVector(shift, e);
    camera.position.copy(camFrom).addScaledVector(shift, e);
    controls.update();
    render();
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}
let lastTap = { t: 0, x: 0, y: 0 };
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() };
  hideHint();
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10 || performance.now() - down.t > 300) return;
  const now = performance.now();
  if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    focusAt(e.clientX, e.clientY);
    lastTap.t = 0;
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
});

// --- URL hash -------------------------------------------------------------------------------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  hidden = new Set((p.get("aus") || "").split(",").filter(Boolean).map(Number));
  const h = p.get("sonne");
  sunState = { hour: HOURS.includes(+h) ? +h : null, day: DAYS.some((d) => d.id === p.get("tag")) ? p.get("tag") : "jun" };
  return p.get("v");
}
function writeHash() {
  if (!current) return;
  const p = new URLSearchParams({ v: current.id });
  if (hidden.size) p.set("aus", [...hidden].sort().join(","));
  if (sunState.hour !== null) { p.set("sonne", sunState.hour); p.set("tag", sunState.day); }
  history.replaceState(null, "", "#" + p.toString().replace(/%2C/g, ","));
}

let hintTimer = setTimeout(hideHint, 8000);
function hideHint() {
  clearTimeout(hintTimer);
  $("hint").classList.add("gone");
}

// --- decryption (models and PDFs are only published encrypted, see web_encrypt.py) ----------------
// key = PBKDF2-SHA256(password, crypto.json salt), AES-256-GCM; each file is 12-byte IV + ciphertext + tag
let key = null;
const PW_STORE = "fassade-pw";

async function deriveKey(password, cfg) {
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const k = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64(cfg.salt), iterations: cfg.iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  await decrypt(k, b64(cfg.check).buffer); // throws on a wrong password
  return k;
}

function decrypt(k, buf) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(buf, 0, 12) }, k, new Uint8Array(buf, 12));
}

async function fetchDecrypted(url, onProgress) {
  const res = await fetch(url, { cache: "no-cache" }); // revalidate (Pages: max-age 600), 304 when unchanged
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  // content-length is only for the progress: with gzip (GitHub Pages) it is the compressed size, not the data's
  const total = +res.headers.get("content-length") || 0;
  let buf;
  if (total && res.body && onProgress) {
    const chunks = [];
    let got = 0;
    for (const reader = res.body.getReader(); ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(100, Math.round((100 * got) / total)));
    }
    const data = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) {
      data.set(c, at);
      at += c.length;
    }
    buf = data.buffer;
  } else buf = await res.arrayBuffer();
  return decrypt(key, buf);
}

async function downloadPdf() {
  const v = variants.find((x) => x.id === current?.id);
  if (!v?.pdf) return;
  setLoading(`PDF ${v.id} lädt …`);
  try {
    const buf = await fetchDecrypted(v.pdf, (p) => setLoading(`PDF ${v.id} lädt … ${p} %`));
    const url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `plans_${v.id}.pdf` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setLoading("");
  } catch (err) {
    console.error(err);
    setLoading("PDF konnte nicht geladen werden");
  }
}

function login(cfg) {
  // a remembered password first, else the form; resolves once the key is derived and checked
  return new Promise((resolve) => {
    const form = $("login");
    const tryPassword = async (pw, remember) => {
      try {
        key = await deriveKey(pw, cfg);
      } catch {
        return false;
      }
      try {
        remember ? localStorage.setItem(PW_STORE, pw) : localStorage.removeItem(PW_STORE);
      } catch {}
      form.hidden = true;
      resolve();
      return true;
    };
    let stored = null;
    try {
      stored = localStorage.getItem(PW_STORE);
    } catch {}
    (stored ? tryPassword(stored, true) : Promise.resolve(false)).then((ok) => {
      if (ok) return;
      setLoading("");
      form.hidden = false;
      $("pw").focus();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      $("pw-error").hidden = true;
      $("pw-go").disabled = true;
      const ok = await tryPassword($("pw").value, $("pw-remember").checked);
      $("pw-go").disabled = false;
      if (!ok) {
        $("pw-error").hidden = false;
        $("pw").select();
      }
    });
  });
}

// --- start ----------------------------------------------------------------------------------
async function start() {
  buildChips();
  buildSun();
  if (!window.crypto?.subtle) {
    setLoading("Entschlüsseln geht nur über https (oder localhost)");
    return;
  }
  let data, cfg;
  try {
    [data, cfg] = await Promise.all(
      ["variants.json", "crypto.json"].map(async (f) => (await fetch(f, { cache: "no-cache" })).json()));
  } catch {
    setLoading("variants.json / crypto.json fehlen: zuerst ./make_web.sh laufen lassen");
    return;
  }
  await login(cfg);
  variants = data.variants;
  const sel = $("variant");
  for (const v of variants) sel.add(new Option(v.built ? `Variante ${v.id}  (${v.built})` : `Variante ${v.id}`, v.id));
  sel.addEventListener("change", () => showVariant(sel.value));
  $("pdf").addEventListener("click", downloadPdf);
  $("reset").addEventListener("click", () => {
    frame();
    render();
  });
  window.addEventListener("hashchange", () => {
    const id = readHash();
    applyLevels();
    applySun();
    if (id && id !== current?.id) showVariant(id);
  });
  const wanted = readHash() || data.default;
  applyLevels();
  applySun();
  showVariant(wanted);
}
start();
