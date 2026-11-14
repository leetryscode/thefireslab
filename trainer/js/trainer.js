/* FiST Trainer — instructor view: terrain, OPs and viewshed, fires, OPFOR editor, banner and panels.
   The Fires Lab, Catherine Lake Creations LLC. Data comes from data/ through load(). */
(async function () {
  // ---- data: every file the page needs comes through load(), so the loading method can change in one place
  //      (fetch today; script-wrapped files if the page must run from file:// or a USB stick later)
  const DATA_DIR = 'data/';
  async function load(name, as) {
    const r = await fetch(DATA_DIR + name);
    if (!r.ok) throw new Error(name + ' (' + r.status + ')');
    return as === 'json' ? r.json() : as === 'url' ? URL.createObjectURL(await r.blob()) : r.arrayBuffer();
  }
  const [demJ, SKETCH, PHOTO] = await Promise.all([load('dem.json', 'json'), load('ops.json', 'json'), load('photo.jpg', 'url')]);
  const demGz = Uint8Array.from(atob(demJ.data), c => c.charCodeAt(0)).buffer;
  const OCEAN = 'rgb(19,71,106)';     // the photo's deep-water colour, for sea beyond the data
  // ---- terrain: NX x NY heights in decimetres, row 0 = north, -1 = no data (sea)
  const NX = 1200, NY = 1000, CELL = 10, W = 615000, NTOP = 2360000;
  const CE = W + NX * CELL / 2, CN = NTOP - NY * CELL / 2;   // local origin at the centre
  const HW = NX * CELL / 2, HH = NY * CELL / 2;
  // PLAY: the area you can click, route and fire into (Lee, 2026-11-10: room for maritime targets). The elevation grid
  // plus open sea: SEA_PAD m to the west, south and east, none north (land). Outside the grid everything is sea level water.
  const SEA_PAD = 8000, PLAY = { x0: -HW - SEA_PAD, x1: HW + SEA_PAD, z0: -HH, z1: HH + SEA_PAD };
  const inPlay = (x, z) => x >= PLAY.x0 && x <= PLAY.x1 && z >= PLAY.z0 && z <= PLAY.z1;
  // some servers unzip a .gz on the way out and some don't: unpack only if the bytes are still gzip (1f 8b)
  const gz = new Uint8Array(demGz, 0, 2), packed = gz[0] === 0x1f && gz[1] === 0x8b;
  const buf = packed ? await new Response(new Blob([demGz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : demGz;
  const dm = new Int16Array(buf);
  const H = new Float32Array(NX * NY);
  for (let i = 0; i < NX * NY; i++) H[i] = dm[i] < 0 ? 0 : dm[i] / 10;
  // Clip the terrain to the NAIP imagery footprint (outside it the photo is only a painted relief fill, and the
  // seam looked unprofessional). Polygon in photo pixels (4096 x 3412, top = north), traced from the photo's edges.
  const IMG = [[1457, 0], [2531, 0], [4095, 679], [4095, 2300], [3392, 3411], [3030, 3411], [0, 1692], [0, 1668]];
  { const cu = IMG.reduce((t, p) => t + p[0], 0) / IMG.length, cv = IMG.reduce((t, p) => t + p[1], 0) / IMG.length;   // pull in ~10 px so no fill shows at the seam
    for (const p of IMG) { p[0] = cu + (p[0] - cu) * 0.995; p[1] = cv + (p[1] - cv) * 0.995; } }
  const imgPoly = IMG.map(([u, v]) => ({ x: (u / 4096 - 0.5) * (NX - 1) * CELL, z: (v / 3412 - 0.5) * (NY - 1) * CELL }));
  function inImagery(x, z) {
    let inside = false;
    for (let i = 0, j = imgPoly.length - 1; i < imgPoly.length; j = i++) {
      const a = imgPoly[i], b = imgPoly[j];
      if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  }
  // ---- TRIM (Lee, 2026-11-10): the map's outer edge. Outside the photo (the NW corner, the far E and SE) the land is bare
  //      relief. It stays land (sinking it into the sea drew a false coast and made Oahu look like a small island), but past
  //      a ragged line just inside the photo's edge it is 'false land': darkened as if under cloud shadow (SHADE_*) with a
  //      haze over the line (HAZE_*). Only the last ~1.5 km at the grid's own border slopes down to sea level, display only (BORDER), so
  //      no cut wall stands at the rectangle's edge, and the shadow there deepens to the sea's colour.
  //      EDGE: 1 = in play, 0 = deep in the false land. TRIM_IN: how far inside the photo's edge the line sits on average (m);
  //      TRIM_BAND: width of the change; TRIM_NOISE: how ragged the line is (+- m).
  const TRIM_IN = 120, TRIM_BAND = 650, TRIM_NOISE = 320, BORDER_BAND = 1200;
  let trimNoise = null;               // the trim's ragged-edge noise, reused by the haze
  const EDGE = new Float32Array(NX * NY).fill(1), HG = new Float32Array(NX * NY), LAND0 = new Uint8Array(NX * NY), BORDER = new Float32Array(NX * NY).fill(1);   // LAND0: land cells
  {
    const hash = (i, j) => { let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) | 0; h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; };
    const vn = (x, z) => { const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
      const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1); return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v; };
    const noise = (x, z) => (vn(x / 2600, z / 2600) - 0.5) * 1.3 + (vn(x / 900 + 17, z / 900 + 31) - 0.5) * 0.55 + (vn(x / 320 + 5, z / 320 + 9) - 0.5) * 0.2;
    trimNoise = (x, z) => vn(x / 1400 + 41, z / 1400 + 7) * 0.65 + vn(x / 500 + 3, z / 500 + 77) * 0.35;   // 0..1, patchy
    const segs = imgPoly.map((a, k) => { const b = imgPoly[(k + 1) % imgPoly.length]; return [a.x, a.z, b.x - a.x, b.z - a.z, (b.x - a.x) ** 2 + (b.z - a.z) ** 2]; });
    const reach = TRIM_IN + TRIM_BAND + TRIM_NOISE;
    for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) {
      const i = r * NX + c, x = c * CELL - (NX - 1) * CELL / 2, z = r * CELL - (NY - 1) * CELL / 2;
      let d = Math.min(HW - Math.abs(x), HH - Math.abs(z));
      for (const [ax, az, dx, dz, L2] of segs) { const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); d = Math.min(d, Math.hypot(x - ax - dx * t, z - az - dz * t)); }
      if (!inImagery(x, z)) d = -d;
      if (d < reach) {
        const e = Math.max(0, Math.min(1, (d - TRIM_IN + noise(x, z) * TRIM_NOISE) / TRIM_BAND));
        EDGE[i] = e * e * (3 - 2 * e);
      }
      const bd = Math.min(HW - Math.abs(x), HH - Math.abs(z)) + noise(x * 0.7 + 900, z * 0.7 - 400) * 450, t = Math.max(0, Math.min(1, (bd - 100) / BORDER_BAND));   // ragged, so the rectangle doesn't show
      BORDER[i] = t * t * (3 - 2 * t);
      if (dm[i] < 0) continue;
      LAND0[i] = 1;
      HG[i] = H[i] * BORDER[i];                 // display only: H (rules, water mask) keeps the real height, or flat land there reads as water
    }
  }
  const edgeAt = (x, z) => { const c = Math.round((x + HW) / CELL - 0.5), r = Math.round((z + HH) / CELL - 0.5); return c < 0 || r < 0 || c >= NX || r >= NY ? 0 : EDGE[r * NX + c]; };
  const toLocal = (e, n) => ({ x: e - CE, z: CN - n });

  function heightAt(x, z) {             // bilinear, local metres (x east, z south)
    const c = (x + HW) / CELL - 0.5, r = (z + HH) / CELL - 0.5;
    if (c < 0 || r < 0 || c > NX - 1 || r > NY - 1) return 0;
    const c0 = Math.floor(c), r0 = Math.floor(r), c1 = Math.min(c0 + 1, NX - 1), r1 = Math.min(r0 + 1, NY - 1);
    const fc = c - c0, fr = r - r0;
    const a = H[r0 * NX + c0], b = H[r0 * NX + c1], d = H[r1 * NX + c0], e = H[r1 * NX + c1];
    return (a * (1 - fc) + b * fc) * (1 - fr) + (d * (1 - fc) + e * fc) * fr;
  }

  // ---- scene
  const canvas = document.getElementById('view');
  // ---- LITE (demo) mode for phones and tablets (Lee, 2026-11-03): phone browsers kill tabs that use too much memory.
  //      Lite = 1x resolution, no anti-aliasing, civilians Sparse as coloured boxes (no car models), trees simplified at half the distance.
  //      ?lite=1 / ?lite=0 in the address forces it on or off (testing on a laptop, or a capable tablet).
  const LITE = (() => { const q = new URLSearchParams(location.search).get('lite'); if (q === '1') return true; if (q === '0') return false;
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); })();
  window.__lite = LITE;
  // ---- role (multiplayer plan, Trainer/notes/trainer-multiplayer.md, Lee 2026-11-11). ?role=student shows the student screen
  //      (until rooms exist this is the only way in): the 2D map, OPs, UAS, Display basics, Rules, clock. No god's-eye 3D view,
  //      no Play/Pause or speed, no Scenario, Fires or OPFOR panels, and nothing on the map that gives the enemy away
  //      (enemy, enemy routes, civilians, bursts, smoke). Students see the battlefield only through an OP or a UAS feed.
  //      Elements marked class="instr-only" in index.html are hidden for students by trainer.css.
  const STUDENT = new URLSearchParams(location.search).get('role') === 'student';
  document.body.classList.toggle('role-student', STUDENT);
  window.__role = STUDENT ? 'student' : 'instructor';
  // ---- room (multiplayer build step 2). ?room=CODE: an instructor hosts it (runs the whole sim); ?role=student&room=CODE joins
  //      it, optionally with &cs=CALLSIGN. Until the Cloudflare relay (step 3) the link is a BroadcastChannel, so host and
  //      students are tabs of one browser on one computer. NET.emit is filled in by the ROOM module near the end of the file;
  //      until then (and always for students and solo) it does nothing. A student in a room never writes the saved scenario.
  const NET = (() => {
    const q = new URLSearchParams(location.search), room = (q.get('room') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16) || null;
    let cs = (q.get('cs') || '').trim().toUpperCase().slice(0, 20);
    if (!cs && room) cs = STUDENT ? 'STUDENT ' + Math.floor(100 + Math.random() * 900) : 'INSTRUCTOR';
    return { room, host: !!room && !STUDENT, client: !!room && STUDENT, cs, emit() {} };
  })();
  const NOSAVE = NET.client;
  window.__net = NET;
  // ---- edge smoothing (2026-11-04, under comparison): 'msaa' is the browser's 4x (default), 'fxaa' a cheaper pass over the
  //      finished picture, 'off' none. ?aa=msaa / ?aa=fxaa / ?aa=off in the address. It must be chosen before the page's GPU
  //      context exists, so changing it means a reload. Lite stays 'off' unless the address says otherwise.
  const AA = (() => { const q = new URLSearchParams(location.search).get('aa'); return ['msaa', 'fxaa', 'off'].includes(q) ? q : LITE ? 'off' : 'msaa'; })();
  window.__aa = AA;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: AA === 'msaa' });
  renderer.setPixelRatio(LITE ? 1 : Math.min(devicePixelRatio, 2));
  // FXAA: the main view is drawn into a texture, already sRGB-encoded, and this pass smooths its edges onto the canvas.
  // UAS feeds render straight to the canvas as before, so they are unsmoothed in this mode.
  const FXAA = AA !== 'fxaa' ? null : (() => {
    const rt = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false, encoding: THREE.sRGBEncoding });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mat = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { t: { value: rt.texture }, px: { value: new THREE.Vector2(1, 1) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
uniform sampler2D t; uniform vec2 px; varying vec2 vUv;
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 M = texture2D(t, vUv).rgb;
  float nw = lum(texture2D(t, vUv + vec2(-1.0, -1.0) * px).rgb), ne = lum(texture2D(t, vUv + vec2(1.0, -1.0) * px).rgb);
  float sw = lum(texture2D(t, vUv + vec2(-1.0, 1.0) * px).rgb), se = lum(texture2D(t, vUv + vec2(1.0, 1.0) * px).rgb), m = lum(M);
  float lo = min(m, min(min(nw, ne), min(sw, se))), hi = max(m, max(max(nw, ne), max(sw, se)));
  if (hi - lo < max(0.0312, hi * 0.125)) { gl_FragColor = vec4(M, 1.0); return; }   // no edge here: most pixels stop at 5 reads
  vec2 dir = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  float reduce = max((nw + ne + sw + se) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * px;
  vec3 a = 0.5 * (texture2D(t, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(t, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(t, vUv - dir * 0.5).rgb + texture2D(t, vUv + dir * 0.5).rgb);
  float l = lum(b);
  gl_FragColor = vec4(l < lo || l > hi ? a : b, 1.0);
}`
    });
    const tri = new THREE.Mesh(g, mat); tri.frustumCulled = false;
    const sc = new THREE.Scene(); sc.add(tri);
    const cam = new THREE.Camera(), size = new THREE.Vector2();
    return {
      resize() { renderer.getDrawingBufferSize(size); rt.setSize(size.x, size.y); mat.uniforms.px.value.set(1 / size.x, 1 / size.y); },
      render(scene, camera) { renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null); renderer.render(sc, cam); }
    };
  })();
  function liteNote() {                      // shown once the scene is up (a slow phone could otherwise miss it during loading)
    if (!LITE) return;
    const n = document.createElement('div'); n.id = 'lite-note'; n.setAttribute('role', 'status');
    n.innerHTML = '<b>Mobile device detected — demo mode.</b><br>Graphics are simplified for mobile viewing. For full detail and the instructor tools, open the trainer on a laptop or desktop.<span class="x">Tap to close</span>';
    n.addEventListener('click', () => n.remove()); document.body.appendChild(n); setTimeout(() => n.remove(), 15000);
  }
  const scene = new THREE.Scene();
  // sky: a gradient dome that follows the camera; fog fades everything to the horizon colour, so land and sea
  // melt into the sky instead of ending at an edge (both the map view and standing at an OP)
  const HORIZON = 0xbccbd8, ZENITH = 0x5b87b4;
  scene.background = new THREE.Color(HORIZON);
  scene.fog = new THREE.Fog(HORIZON, 12000, 55000);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(70000, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { hz: { value: new THREE.Color(HORIZON) }, zn: { value: new THREE.Color(ZENITH) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 hz; uniform vec3 zn; varying vec3 vP; void main(){ float h = max(normalize(vP).y, 0.0);' +
      ' gl_FragColor = vec4(mix(hz, zn, pow(h, 0.55)), 1.0); }'
  }));
  // Draw order (2026-11-04, perf): the renderer draws solid things nearest-first only within one material, so give the costly
  // full-screen surfaces a late turn and let them skip whatever is already in front: everything else, ground 1, sea 2, sky 3.
  sky.renderOrder = 3; sky.frustumCulled = false;
  const camera = new THREE.PerspectiveCamera(45, 1, 10, 80000);

  const geo = new THREE.PlaneGeometry((NX - 1) * CELL, (NY - 1) * CELL, NX - 1, NY - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, col = new Float32Array(NX * NY * 3);
  const ramp = [[0, [0.27, 0.36, 0.25]], [40, [0.36, 0.43, 0.28]], [150, [0.47, 0.47, 0.31]],
                [350, [0.55, 0.47, 0.35]], [550, [0.62, 0.58, 0.50]], [750, [0.80, 0.78, 0.72]]];
  function tint(h) {
    for (let k = 1; k < ramp.length; k++) if (h <= ramp[k][0]) {
      const [h0, c0] = ramp[k - 1], [h1, c1] = ramp[k], t = (h - h0) / (h1 - h0);
      return c0.map((v, j) => v + (c1[j] - v) * t);
    }
    return ramp[ramp.length - 1][1];
  }
  const SEA = new THREE.Color(OCEAN).convertSRGBToLinear();
  for (let i = 0; i < NX * NY; i++) {
    const c = dm[i] < 0 ? [SEA.r, SEA.g, SEA.b] : tint(H[i]);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const reliefMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const tex = await new THREE.TextureLoader().loadAsync(PHOTO);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); tex.encoding = THREE.sRGBEncoding;
  const photoMat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
  // ---- WATER: one shader function used by the ground (where the elevation data says sea, harbour or canal) and the
  //      open-sea plane: moving ripples, sun glint, sky reflection that grows at low angles, the photo's frozen boats
  //      and whitecaps toned down, and a slow foam line along the shore. Real time, not sim time (cosmetic).
  const WATER = {
    time: { value: 0 },
    sunDir: { value: new THREE.Vector3(-6000, 7000, -4000).normalize() },
    hz: { value: new THREE.Color(0xbccbd8).convertSRGBToLinear() },
    zn: { value: new THREE.Color(0x5b87b4).convertSRGBToLinear() }
  };
  const WATER_GLSL = `
uniform float uTime; uniform vec3 uSun; uniform vec3 uHz; uniform vec3 uZn;
float wh21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wh21(i), wh21(i + vec2(1, 0)), f.x), mix(wh21(i + vec2(0, 1)), wh21(i + vec2(1, 1)), f.x), f.y); }
// surface normal from six directional waves (lengths 4-60 m, mostly running one way, like a trade-wind sea);
// a wave fades out once it is shorter than ~3 screen pixels, so nothing shimmers; slow noise breaks the pattern up
vec3 waveNormal(vec2 q, float px){
  vec2 g = vec2(0.0); float t = uTime, ph = wnoise(q * 0.012) * 6.0 + wnoise(q * 0.05) * 1.5;
  #define WAVE(dx, dy, L, s) { vec2 d = normalize(vec2(dx, dy)); float k = 6.2832 / L, w = sqrt(9.8 * k); \
    float f = 1.0 - smoothstep(0.2, 0.4, px / L); g += d * (s * f * cos(dot(d, q) * k - w * t + ph)); }
  WAVE(0.8, 0.6, 60.0, 0.09) WAVE(0.55, 0.85, 31.0, 0.09) WAVE(0.97, 0.25, 18.0, 0.08)
  WAVE(0.4, 0.92, 11.0, 0.07) WAVE(0.92, -0.15, 7.0, 0.06) WAVE(0.7, 0.72, 4.3, 0.05)
  return normalize(vec3(-g.x, 1.0, -g.y));
}
float wPx;   // metres of water per screen pixel; set first thing in main, outside the land/water branch
vec3 waterShade(vec3 base, vec3 P, float foam){
  vec3 toCam = cameraPosition - P; float dist = length(toCam); vec3 V = toCam / dist;
  vec2 q = P.xz;
  vec3 n = wPx > 24.0 ? vec3(0.0, 1.0, 0.0) : waveNormal(q, wPx);       // from 24 m a pixel every wave has faded to zero: skip them
  float l = dot(base, vec3(0.2126, 0.7152, 0.0722));
  base *= mix(1.0, 0.3 / max(l, 1e-3), smoothstep(0.3, 0.55, l));    // tone down only bright specks: frozen boats, whitecaps
  vec3 r = reflect(-V, n);
  vec3 sky = mix(uHz, uZn, pow(clamp(r.y, 0.0, 1.0), 0.25));
  vec3 ns = normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.6));               // smoother normal for the reflection strength
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(ns, V), 0.0), 5.0);
  base *= 1.0 + 1.4 * (dot(n, uSun) - uSun.y);                          // ripples catch the light a little
  vec3 c = mix(base, sky, clamp(F, 0.0, 1.0) * 0.24);
  float sp = max(dot(r, uSun), 0.0);
  c += vec3(1.0, 0.96, 0.88) * (pow(sp, 200.0) * 2.5 + pow(sp, 40.0) * 0.22);
  if (foam < 0.004) return c;                                           // away from the shore: no foam, so no noise to work out
  float fb = foam * (0.55 + 0.45 * sin(uTime * 0.9 + wnoise(q * 0.05) * 9.0)) * (0.6 + 0.4 * wnoise(q * 0.3 + uTime * 0.2));
  return mix(c, vec3(0.86, 0.9, 0.92), clamp(fb, 0.0, 1.0) * 0.75);
}
`;
  const WATER_MAIN = 'void main() {\n  wPx = max(length(fwidth(vWW.xz)), 0.01);';
  // water mask on the terrain grid: R = water, slightly softened; G = a shore band for the foam (water within ~25 m
  // of land). Water = sea no-data, or ground under 0.4 m (harbour, canal) where the photo also looks like water
  // (blue or turquoise, not the grey/white of piers, car parks and boats) - the marina flooded without that check.
  const waterTex = (() => {
    const c = document.createElement('canvas'); c.width = NX; c.height = NY; const g = c.getContext('2d');
    g.drawImage(tex.image, 0, 0, NX, NY); const ph = g.getImageData(0, 0, NX, NY).data;
    const img = g.createImageData(NX, NY), d = img.data;
    for (let i = 0; i < NX * NY; i++) {
      const R = ph[i * 4], G = ph[i * 4 + 1], B = ph[i * 4 + 2];
      const wet = B > R + 12 && G > R && R + G + B < 560;
      const w = dm[i] < 0 || (H[i] < 0.4 && wet);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = w ? 255 : 0; d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const a = document.createElement('canvas'); a.width = NX; a.height = NY; const ag = a.getContext('2d');
    ag.filter = 'blur(1px)'; ag.drawImage(c, 0, 0);
    const b = document.createElement('canvas'); b.width = NX; b.height = NY; const bg = b.getContext('2d');
    bg.filter = 'blur(2.5px)'; bg.drawImage(c, 0, 0);
    const A = ag.getImageData(0, 0, NX, NY).data, Bd = bg.getImageData(0, 0, NX, NY).data, out = g.createImageData(NX, NY), o = out.data;
    for (let i = 0; i < NX * NY; i++) {
      const w = A[i * 4], wb = Bd[i * 4] / 255;
      o[i * 4] = w; o[i * 4 + 1] = d[i * 4] ? Math.round(255 * Math.max(0, 1 - Math.abs(wb - 0.62) / 0.3)) : 0; o[i * 4 + 2] = 0; o[i * 4 + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter; return t;
  })();
  // ---- SHADOW + HAZE (Lee, 2026-11-10): how the false land looks. hazeTex R = haze, a soft patchy veil in the horizon
  //      colour over the line where play ends (spreads onto the water beside it, thins inland, gone before the grid's edge);
  //      G = shadow: land past the line darkened and greyed, and near the grid's border (land or water) the same open sea
  //      as beyond it, so the rectangle never shows; B = land flag (only land is darkened). Display only.
  const SHADE_CUT = 0.72, SHADE_BORDER = 0.96;   // shadow strength past the line, and at the grid's border (where it meets the sea)
  const HAZE_MAX = 0.55, HAZE_SEA = 26, HAZE_LAND = 0.35;   // HAZE_SEA: spread off the cut, px of 10 m (blur); HAZE_LAND: how far it reaches inland (EDGE)
  const hazeTex = (() => {
    const c = document.createElement('canvas'); c.width = NX; c.height = NY; const g = c.getContext('2d');
    const img = g.createImageData(NX, NY), d = img.data;
    // seed: the line where play ends, not the false land beyond it
    for (let i = 0; i < NX * NY; i++) { const v = LAND0[i] && EDGE[i] > 0.2 && EDGE[i] < 0.6 ? 255 : 0; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    g.putImageData(img, 0, 0);
    const b = document.createElement('canvas'); b.width = NX; b.height = NY; const bg = b.getContext('2d');
    bg.fillStyle = '#000'; bg.fillRect(0, 0, NX, NY); bg.filter = 'blur(' + HAZE_SEA + 'px)'; bg.drawImage(c, 0, 0);
    const B = bg.getImageData(0, 0, NX, NY), bd = B.data;
    for (let r = 0; r < NY; r++) for (let col = 0; col < NX; col++) {
      const i = r * NX + col, x = col * CELL - (NX - 1) * CELL / 2, z = r * CELL - (NY - 1) * CELL / 2;
      const spread = Math.min(1, bd[i * 4] / 255 * 2.6), sea = spread * spread * (3 - 2 * spread);      // soft fall-off over the water
      const t = Math.max(0, Math.min(1, (EDGE[i] - (1 - HAZE_LAND)) / HAZE_LAND)), land = 1 - t * t * (3 - 2 * t);   // thins out inland
      const rim = Math.max(0, Math.min(1, (Math.min(HW - Math.abs(x), HH - Math.abs(z)) - 150) / 1100));   // gone before the grid's own edge
      let v = sea * land * rim * rim * (3 - 2 * rim);
      if (v > 0.003) v *= 0.55 + 0.75 * trimNoise(x, z);                                                // patchy, not a painted band
      v = Math.min(1, v);
      const sh = Math.max(LAND0[i] ? SHADE_CUT * (1 - EDGE[i]) : 0, SHADE_BORDER * (1 - BORDER[i]));   // shadow over the false land; open sea at the border (land or water)
      bd[i * 4] = Math.round(255 * v); bd[i * 4 + 1] = Math.round(255 * sh); bd[i * 4 + 2] = LAND0[i] ? 255 : 0;   // B: land, so only land is darkened bd[i * 4 + 3] = 255;
    }
    bg.putImageData(B, 0, 0);
    const t = new THREE.CanvasTexture(b); t.minFilter = THREE.LinearFilter; return t;
  })();
  const HAZE = { map: { value: hazeTex }, col: { value: new THREE.Color(HORIZON).convertSRGBToLinear().multiplyScalar(0.92) }, shade: { value: new THREE.Color(OCEAN).convertSRGBToLinear().multiplyScalar(1.05) } };   // shade: the open sea's lit base colour window.__haze = HAZE;
  const HAZE_GLSL = `
uniform sampler2D hazeMap; uniform vec3 uHazeCol; uniform vec3 uShadeCol;
vec2 hazeUv(vec3 P){ return vec2(P.x / ${(NX - 1) * CELL}.0 + 0.5, 0.5 - P.z / ${(NY - 1) * CELL}.0); }
vec3 shadeOver(vec3 c, vec3 P){      // the false land: land in deep shadow; at the grid's border it becomes the same open sea as beyond
  vec4 m = texture2D(hazeMap, hazeUv(P)); float k = m.g;
  vec3 dim = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), 0.6) * 0.42;
  c = mix(c, dim, min(1.0, k / ${SHADE_CUT}) * m.b);
  float kb = smoothstep(${SHADE_CUT}, ${SHADE_BORDER}, k);
  return kb > 0.001 ? mix(c, waterShade(uShadeCol, P, 0.0), kb) : c;
}
vec3 hazeOver(vec3 c, vec3 P){       // world position -> haze grid; past the grid's edge it carries on and dies away over ~500 m
  vec2 h = vec2(${(NX - 1) * CELL / 2}.0, ${(NY - 1) * CELL / 2}.0);
  float k = texture2D(hazeMap, hazeUv(P)).r;
  k *= exp(-length(max(abs(P.xz) - h, 0.0)) / 500.0);
  return mix(c, uHazeCol, k * ${HAZE_MAX});
}
`;
  function waterUniforms(sh) { sh.uniforms.uTime = WATER.time; sh.uniforms.uSun = WATER.sunDir; sh.uniforms.uHz = WATER.hz; sh.uniforms.uZn = WATER.zn; sh.uniforms.hazeMap = HAZE.map; sh.uniforms.uHazeCol = HAZE.col; sh.uniforms.uShadeCol = HAZE.shade; }

  // Colour grade for the photo ground: the photo already carries real sunlight and shadow, so show it at its own
  // brightness, keep only half of the 3D terrain shading (enough to read slopes, not the plastic sheen), then a
  // gentle contrast and saturation lift (linear space). FLAT = the lights' strength on level ground.
  const GRADE_GLSL = `
vec3 gradeGround(vec3 base, vec3 lit){
  const float FLAT = 1.07;
  vec3 shade = lit / max(base, vec3(1e-4)) / FLAT;
  vec3 c = base * mix(vec3(1.0), shade, 0.5) * 0.97;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.2);
  return max(pow(max(c, 0.0), vec3(1.1)) * 1.06, 0.0);
}
`;
  renderer.outputEncoding = THREE.sRGBEncoding;
  const clipTex = (() => {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 853; const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#fff'; g.beginPath();
    IMG.forEach(([u, v], i) => g[i ? 'lineTo' : 'moveTo'](u / 4096 * c.width, v / 3412 * c.height)); g.closePath(); g.fill();
    return new THREE.CanvasTexture(c);
  })();
  // Soft edge instead of a hard clip: outside the photo the ground shows its relief/sea colour, and the photo fades
  // into it over ~700 m (a blurred copy of the footprint mask), so there is no seam and the sea runs to the horizon.
  const fadeTex = (() => {
    // mask = real photo pixels (not the deep-water fill the photo carries outside its data) inside the traced footprint
    const w = 1024, h = 853, a = document.createElement('canvas'); a.width = w; a.height = h; const g = a.getContext('2d');
    g.drawImage(tex.image, 0, 0, w, h); const px = g.getImageData(0, 0, w, h);
    const fp = document.createElement('canvas'); fp.width = w; fp.height = h; const f = fp.getContext('2d');
    f.fillStyle = '#000'; f.fillRect(0, 0, w, h); f.fillStyle = '#fff'; f.beginPath();
    IMG.forEach(([u, v], i) => f[i ? 'lineTo' : 'moveTo'](u / 4096 * w, v / 3412 * h)); f.closePath(); f.fill();
    const inFp = f.getImageData(0, 0, w, h).data, d = px.data;
    for (let i = 0; i < d.length; i += 4) {
      const fill = Math.abs(d[i] - 19) + Math.abs(d[i + 1] - 71) + Math.abs(d[i + 2] - 106) < 24;
      const v = !fill && inFp[i] > 127 ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    g.putImageData(px, 0, 0);
    // shrink, then blur: the fade runs ~300 m and ends inside the real photo
    const c = document.createElement('canvas'); c.width = w; c.height = h; const k = c.getContext('2d');
    k.fillStyle = '#000'; k.fillRect(0, 0, w, h); k.filter = 'blur(12px)'; k.drawImage(a, 0, 0);   // ~300 m since the TRIM: the land now ends near the photo's edge
    const b = k.getImageData(0, 0, w, h), bd = b.data;   // keep only the inner part of the blurred edge
    for (let i = 0; i < bd.length; i += 4) { const v = Math.max(0, Math.min(255, (bd[i] - 128) * 2)); bd[i] = bd[i + 1] = bd[i + 2] = v; }
    k.putImageData(b, 0, 0);
    return new THREE.CanvasTexture(c);
  })();
  photoMat.extensions = { derivatives: true };
  // Hybrid ground: in built-up blocks the photo (leaning walls, frozen shadows, blur) fades to plain pavement and the
  // map roads are drawn on top; open ground keeps the photo. URBAN.map is a quarter-size mask made by CITY.
  const URBAN = { map: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) }, on: { value: 1 } };
  photoMat.onBeforeCompile = sh => {
    sh.uniforms.fadeMap = { value: fadeTex }; sh.uniforms.waterMap = { value: waterTex }; waterUniforms(sh);
    sh.uniforms.urbanMap = URBAN.map; sh.uniforms.urbanOn = URBAN.on;
    sh.vertexShader = 'varying vec3 vWW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform sampler2D fadeMap;\nuniform sampler2D waterMap;\nuniform sampler2D urbanMap;\nuniform float urbanOn;\nvarying vec3 vWW;\n' + GRADE_GLSL + WATER_GLSL + HAZE_GLSL + sh.fragmentShader.replace('void main() {', WATER_MAIN).replace('#include <color_fragment>',
      '#ifdef USE_COLOR\n  diffuseColor.rgb = mix(vColor, diffuseColor.rgb, texture2D(fadeMap, vUv).r);\n#endif\n' +
      '  { float u = texture2D(urbanMap, vUv).r * urbanOn; float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n' +
      '    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.24, 0.235, 0.22), vec3(lum), 0.2), u * 0.92); }')
      .replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', 'outgoingLight = gradeGround(diffuseColor.rgb, outgoingLight);\n  { vec4 wm = texture2D(waterMap, vUv); if (wm.r > 0.004) outgoingLight = mix(outgoingLight, waterShade(outgoingLight, vWW, wm.g), wm.r); }\n  outgoingLight = hazeOver(shadeOver(outgoingLight, vWW), vWW);\n  gl_FragColor = vec4( outgoingLight, diffuseColor.a );');   // r128 has no output_fragment chunk
  };
  // Terrain in tiles (perf, 2026-11-03): the same one grid and the same shared vertex data, split into ~1.5 km tiles so
  // the renderer skips tiles outside the view. Nothing changes on screen. Each tile's bounds are set by hand
  // (three's own bounds would cover the whole grid) and refreshed when the exaggeration changes.
  const TILE = 150;                                         // quads per tile side (10 m cells)
  const ground = new THREE.Group(); ground.material = photoMat; scene.add(ground);
  const tiles = [];
  for (let ty = 0; ty < NY - 1; ty += TILE) for (let tx = 0; tx < NX - 1; tx += TILE) {
    const x1 = Math.min(NX - 1, tx + TILE), y1 = Math.min(NY - 1, ty + TILE);
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]);
    g.boundingSphere = new THREE.Sphere();
    const m = new THREE.Mesh(g, photoMat); m.userData.tile = { tx, ty, x1, y1 }; m.renderOrder = 1; ground.add(m); tiles.push(m);
  }
  // ---- ground detail by distance (2026-11-04, perf): at map range a 10 m cell is about a pixel, so past GROUND_MID a tile
  //      uses every 2nd grid point and past GROUND_FAR every 4th. Display only: heights, sight lines and clicks still use the
  //      10 m grid. Distances are 'effective', like the trees': they shrink with zoom and grow with screen height, so a change
  //      happens at the same size on screen. Vertices are shared, so a level costs only its index list, made on first use.
  //      Where a tile meets a coarser neighbour its outer ring is rebuilt to the neighbour's points, so no crack opens.
  const GROUND = (() => {
    const Q = LITE ? 0.5 : 1, GROUND_MID = 3500 * Q, GROUND_FAR = 8500 * Q, BAND = 1.1, T45 = Math.tan(Math.PI / 8);
    const COLS = Math.ceil((NX - 1) / TILE), wanted = d => d < GROUND_MID ? 1 : d < GROUND_FAR ? 2 : 4;
    const stops = (a, b, s) => { const o = []; for (let v = a; v < b; v += s) o.push(v); o.push(b); return o; };
    function level(m, s) {                     // index list for stride s: the inner cells, then room for the outer ring
      const L = m.userData.levels || (m.userData.levels = {}); if (L[s]) return L[s];
      const { tx, ty, x1, y1 } = m.userData.tile, xs = stops(tx, x1, s), ys = stops(ty, y1, s), idx = new Uint32Array((xs.length - 1) * (ys.length - 1) * 6);
      let k = 0;
      for (let j = 1; j < ys.length - 2; j++) for (let i = 1; i < xs.length - 2; i++) {
        const a = ys[j] * NX + xs[i], b = ys[j + 1] * NX + xs[i], c = ys[j + 1] * NX + xs[i + 1], d = ys[j] * NX + xs[i + 1];
        idx[k++] = a; idx[k++] = b; idx[k++] = d; idx[k++] = b; idx[k++] = c; idx[k++] = d;   // PlaneGeometry's own winding
      }
      return L[s] = { attr: new THREE.BufferAttribute(idx, 1), ring: k, xs, ys, used: k };
    }
    function setLevel(m, s, N, E, S, W) {      // N, E, S, W: the stride each outer edge must use (this tile's, or a coarser neighbour's)
      const Lv = level(m, s), { xs, ys, ring } = Lv, idx = Lv.attr.array, { tx, ty, x1, y1 } = m.userData.tile;
      const nx = xs.length - 1, ny = ys.length - 1; let k = ring;
      const tri = (ax, ay, bx, by, cx, cy) => {   // always the same facing as PlaneGeometry's triangles
        const flip = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0;
        idx[k++] = ay * NX + ax; idx[k++] = (flip ? cy : by) * NX + (flip ? cx : bx); idx[k++] = (flip ? by : cy) * NX + (flip ? bx : cx);
      };
      // one side of the ring: the outer edge's points against the first inner row's, always advancing the one that lags
      const side = (outer, inner, outerAt, innerAt) => {
        let i = 0, j = 0;
        while (i < outer.length - 1 || j < inner.length - 1) {
          const [ax, ay] = outerAt(outer[i]), [cx, cy] = innerAt(inner[j]);
          if (j === inner.length - 1 || (i < outer.length - 1 && outer[i + 1] <= inner[j + 1])) { const [bx, by] = outerAt(outer[++i]); tri(ax, ay, bx, by, cx, cy); }
          else { const [dx, dy] = innerAt(inner[++j]); tri(ax, ay, cx, cy, dx, dy); }
        }
      };
      const ix = xs.slice(1, nx), iy = ys.slice(1, ny);
      side(stops(tx, x1, N), ix, x => [x, ty], x => [x, ys[1]]);
      side(stops(tx, x1, S), ix, x => [x, y1], x => [x, ys[ny - 1]]);
      side(stops(ty, y1, W), iy, y => [tx, y], y => [xs[1], y]);
      side(stops(ty, y1, E), iy, y => [x1, y], y => [xs[nx - 1], y]);
      Lv.attr.updateRange.offset = ring; Lv.attr.updateRange.count = Math.max(k, Lv.used) - ring; Lv.attr.needsUpdate = true; Lv.used = k;
      m.geometry.setIndex(Lv.attr); m.geometry.setDrawRange(0, k);
    }
    const near = (m, c) => Math.max(0, c.position.distanceTo(m.geometry.boundingSphere.center) - m.geometry.boundingSphere.radius);
    const key = new Array(tiles.length).fill(''), now = new Array(tiles.length).fill(1);
    function fit() {                           // apply the strides in 'now', with each edge matched to its neighbour
      tiles.forEach((m, n) => {
        const s = now[n], at = (dc, dr) => { const c = n % COLS + dc, q = n + dc + dr * COLS; return c < 0 || c >= COLS || q < 0 || q >= tiles.length ? s : Math.max(s, now[q]); };
        const N = at(0, -1), E = at(1, 0), S = at(0, 1), W = at(-1, 0), k = s + ',' + N + ',' + E + ',' + S + ',' + W;
        if (k !== key[n]) { key[n] = k; setLevel(m, s, N, E, S, W); }
      });
    }
    fit();
    function update(cams) {
      const px = 800 / Math.max(400, renderer.domElement.height), vs = vsMesh.visible && VS.op ? toLocal(VS.op.e, VS.op.n) : null;
      tiles.forEach((m, n) => {
        let d = Infinity; for (const c of cams) d = Math.min(d, near(m, c) * Math.tan(c.fov * Math.PI / 360) / T45 * px);
        // the viewshed overlay is drawn on the full 10 m grid, so the ground under it has to match or the overlay breaks up
        if (vs) { const b = m.geometry.boundingSphere; if (Math.hypot(b.center.x - vs.x, b.center.z - vs.z) - b.radius < VS.range) { now[n] = 1; return; } }
        const hi = wanted(d), lo = wanted(d / BAND);     // inside the band around a change, stay put so the level doesn't flicker
        if (now[n] < lo || now[n] > hi) now[n] = hi;
      });
      fit();
    }
    return { update, debug: { now, wanted } };
  })();
  window.__ground = GROUND;
  function tileBounds() {
    const P = geo.attributes.position;
    for (const m of tiles) {
      const { tx, ty, x1, y1 } = m.userData.tile; let lo = Infinity, hi = -Infinity;
      for (let iy = ty; iy <= y1; iy += 2) for (let ix = tx; ix <= x1; ix += 2) { const y = P.getY(iy * NX + ix); if (y < lo) lo = y; if (y > hi) hi = y; }
      const a = iy0 => iy0 * NX, p0 = new THREE.Vector3(P.getX(a(ty) + tx), lo, P.getZ(a(ty) + tx)), p1 = new THREE.Vector3(P.getX(a(y1) + x1), hi, P.getZ(a(y1) + x1));
      m.geometry.boundingSphere.center.copy(p0).add(p1).multiplyScalar(0.5); m.geometry.boundingSphere.radius = p0.distanceTo(p1) / 2 + 30;
    }
  }
  Object.defineProperty(ground, 'material', { get() { return tiles[0].material; }, set(v) { for (const m of tiles) m.material = v; } });
  // open ocean beyond the data, in the photo's deep-water colour, so the horizon is sea rather than void
  scene.add(sky);
  const seaMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(OCEAN).convertSRGBToLinear() });
  seaMat.extensions = { derivatives: true };
  seaMat.onBeforeCompile = sh => {
    waterUniforms(sh);
    sh.vertexShader = 'varying vec3 vWW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'varying vec3 vWW;\n' + WATER_GLSL + HAZE_GLSL + sh.fragmentShader.replace('void main() {', WATER_MAIN).replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
      'outgoingLight = hazeOver(waterShade(outgoingLight, vWW, 0.0), vWW);\n  gl_FragColor = vec4( outgoingLight, diffuseColor.a );');
  };
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(160000, 160000, 1, 1), seaMat);
  sea.rotation.x = -Math.PI / 2; sea.position.y = -2; sea.renderOrder = 2; scene.add(sea);
  scene.add(new THREE.HemisphereLight(0xdfe6d8, 0x2a2a22, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(-6000, 7000, -4000);
  scene.add(sun);

  // ---- overlays, rebuilt when exaggeration changes
  let mapView = false;                 // 2D Map view (set by the Fires module's setMap): grid margin labels show
  let ex = 1, onExCity = null;          // onExCity: the CITY module's exaggeration hook (set once it exists)
  const groups = { grid: new THREE.Group(), sketch: new THREE.Group() };
  scene.add(groups.grid, groups.sketch);
  function drape(pts, lift, step) {      // densify a polyline (local x/z) and lay it on the ground
    const out = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1], L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / step));
      for (let j = 0; j < n; j++) {
        const t = j / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        out.push(new THREE.Vector3(x, heightAt(x, z) * ex + lift, z));
      }
    }
    const l = pts[pts.length - 1]; out.push(new THREE.Vector3(l.x, heightAt(l.x, l.z) * ex + lift, l.z));
    return out;
  }
  function clear(g) { while (g.children.length) { const o = g.children.pop(); o.geometry && o.geometry.dispose(); } }

  function buildGrid() {                 // 1 km lines over the play area: land, sea and the open sea beyond the grid
    clear(groups.grid);
    const pts = [], sea = [], keep = (x, z) => edgeAt(x, z) > 0.75 || heightAt(x, z) <= 0;   // not over the hazy edge band
    const E0 = CE + PLAY.x0, E1 = CE + PLAY.x1, N0 = CN - PLAY.z1, N1 = CN - PLAY.z0;
    const add = v => { for (let k = 0; k < v.length - 1; k++) { const x = (v[k].x + v[k + 1].x) / 2, z = (v[k].z + v[k + 1].z) / 2; if (keep(x, z)) (heightAt(x, z) > 0 ? pts : sea).push(v[k], v[k + 1]); } };
    for (let e = Math.ceil(E0 / 1000) * 1000; e <= E1; e += 1000) add(drape([toLocal(e, N1 - 5), toLocal(e, N0 + 5)], 4, CELL));
    for (let n = Math.ceil(N0 / 1000) * 1000; n <= N1; n += 1000) add(drape([toLocal(E0 + 5, n), toLocal(E1 - 5, n)], 4, CELL));
    groups.grid.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xd6b25a, transparent: true, opacity: 0.45 })));
    groups.grid.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(sea),      // fainter over water
      new THREE.LineBasicMaterial({ color: 0xd6b25a, transparent: true, opacity: 0.2 })));
  }

  // map symbols share one look (Lee, 2026-11-02): friendly blue fill, dark outline; labels uppercase condensed in the
  // side's colour with a dark halo, no box — the same as the HTML .tag labels. SYM_K = sprite scale per canvas pixel.
  const SYM_K = 0.085 / 256, FRIEND = '#6fb4ff', SYM_FILL = 'rgba(111,180,255,0.92)', SYM_EDGE = '#0b1a2a';
  function symLabel(g, text, x, y, maxW) {
    let px = 46; text = String(text).toUpperCase(); g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.lineJoin = 'round';
    do { g.font = '700 ' + px + 'px "Barlow Condensed", "Arial Narrow", sans-serif'; } while (g.measureText(text).width > maxW && (px -= 2) > 22);
    g.lineWidth = 9; g.strokeStyle = 'rgba(5,8,6,.9)'; g.strokeText(text, x, y); g.fillStyle = FRIEND; g.fillText(text, x, y);
  }
  const opTex = (() => {                // observation post: filled triangle with a dark centre dot
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.lineJoin = 'round'; g.beginPath(); g.moveTo(64, 16); g.lineTo(114, 104); g.lineTo(14, 104); g.closePath();
    g.fillStyle = SYM_FILL; g.fill(); g.lineWidth = 7; g.strokeStyle = SYM_EDGE; g.stroke();
    g.beginPath(); g.arc(64, 74, 10, 0, Math.PI * 2); g.fillStyle = SYM_EDGE; g.fill();
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  })();
  const tags = [];
  const labelBox = document.getElementById('labels');
  function tag(text, cls, v) { const d = document.createElement('div'); d.className = 'tag ' + cls; d.textContent = text; labelBox.appendChild(d); tags.push({ d, v }); }
  function buildSketch() {
    clear(groups.sketch); labelBox.textContent = ''; tags.length = 0;
    // Lee's KML routes and border are retired (2026-10-31); only the friendly positions are drawn
    // friendly positions: the observation-post symbol (triangle with a centre dot), screen-sized
    for (const o of SKETCH.ops) {
      const p = toLocal(o.e, o.n), g = heightAt(p.x, p.z) * ex;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: opTex, depthTest: false, transparent: true, sizeAttenuation: false }));
      s.scale.set(0.028, 0.028, 1); s.center.set(0.5, 0.15); s.renderOrder = 12; s.position.set(p.x, g + 2, p.z); groups.sketch.add(s);
      tag(o.name, 'op', new THREE.Vector3(p.x, g + 2, p.z));
    }
    labelBox.hidden = !(showLabels && groups.sketch.visible);
  }
  let showLabels = true;
  function rebuild() {
    if (window.__firesHook) window.__firesHook();
    for (let i = 0; i < NX * NY; i++) pos.setY(i, HG[i] * ex);
    pos.needsUpdate = true; geo.computeVertexNormals(); tileBounds();
    buildGrid(); buildSketch();
    if (onExCity) onExCity();
  }
  rebuild();

  // ---- camera
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 150; controls.maxDistance = 40000;
  controls.enableDamping = false;       // no inertia: the view stops when the mouse or key stops (Google Earth feel)
  controls.screenSpacePanning = false;  // 3D view: pan across the ground, not up into the sky (map mode turns it on)
  // Google Earth mouse layout (Lee, 2026-11-02): left-drag moves the terrain, Shift+left-drag (or right-drag) orbits and
  // tilts; one finger pans, two fingers pinch-zoom and rotate. OrbitControls turns PAN into ROTATE when Shift/Ctrl is held.
  function setButtons(map) {
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = map ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.touches.ONE = THREE.TOUCH.PAN;
    controls.touches.TWO = map ? THREE.TOUCH.DOLLY_PAN : THREE.TOUCH.DOLLY_ROTATE;
  }
  setButtons(false);
  function home() { camera.position.set(1200, 8200, 10200); controls.target.set(-2200, 0, 600); }
  home();

  // keyboard navigation in the god's-eye view: arrows / WASD pan, Shift+←/→ or Q/E orbit, Shift+↑/↓ tilt,
  // PageUp/PageDown or +/− zoom. Held keys move smoothly, scaled to distance so it feels the same at any zoom.
  const navKeys = new Set(); let navShift = false;
  const NAV_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
    'PageUp', 'PageDown', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract']);
  const navTyping = () => { const a = document.activeElement; return !!a && /INPUT|SELECT|TEXTAREA/.test(a.tagName); };
  addEventListener('keydown', e => {
    navShift = e.shiftKey;
    if (obs || navTyping() || e.ctrlKey || e.metaKey || e.altKey || !NAV_CODES.has(e.code)) return;
    navKeys.add(e.code); e.preventDefault();
  });
  addEventListener('keyup', e => { navShift = e.shiftKey; navKeys.delete(e.code); });
  addEventListener('blur', () => { navKeys.clear(); navShift = false; });
  const navOff = new THREE.Vector3(), navSph = new THREE.Spherical(), NAV_Y = new THREE.Vector3(0, 1, 0);
  // pivot reticle (Google Earth style): marks the ground point the view turns around. Shown while Shift is held (the
  // rotate modifier), while a rotate drag is moving (Shift+left or right button), and while Q/E or Shift+arrows turn the
  // view; hidden otherwise. Styled inline so it never depends on a cached trainer.css.
  const pivotRet = document.createElement('div'); pivotRet.id = 'pivot-reticle'; pivotRet.setAttribute('aria-hidden', 'true');
  const RET_PATH = '<circle r="9"/><path d="M0-15v5M0 10v5M-15 0h5M10 0h5"/>';
  pivotRet.innerHTML = '<svg viewBox="-16 -16 32 32" width="32" height="32">' +
    '<g fill="none" stroke="rgba(0,0,0,.55)" stroke-width="3.5">' + RET_PATH + '</g>' +
    '<g fill="none" stroke="#fff" stroke-width="1.6">' + RET_PATH + '</g>' +
    '<circle r="1.8" fill="#fff" stroke="rgba(0,0,0,.55)" stroke-width="1"/></svg>';
  Object.assign(pivotRet.style, { position: 'fixed', left: '0', top: '0', width: '32px', height: '32px', margin: '-16px 0 0 -16px',
    pointerEvents: 'none', zIndex: '5', opacity: '0', visibility: 'hidden', transition: 'opacity .12s' });
  document.body.appendChild(pivotRet);
  let rotDrag = null, keyTurn = false, retOn = false;   // rotDrag: { x, y, moved } while a rotate drag is held
  const retPos = new THREE.Vector3();
  canvas.addEventListener('pointerdown', e => {
    rotDrag = null;
    if (obs || !controls.enabled || !controls.enableRotate) return;
    let rot;
    if (e.pointerType === 'touch') rot = e.isPrimary && controls.touches.ONE === THREE.TOUCH.ROTATE;
    else {                              // OrbitControls swaps rotate and pan when Ctrl, Shift or Cmd is held
      const act = [controls.mouseButtons.LEFT, controls.mouseButtons.MIDDLE, controls.mouseButtons.RIGHT][e.button];
      const mod = e.ctrlKey || e.metaKey || e.shiftKey;
      rot = (act === THREE.MOUSE.ROTATE && !mod) || (act === THREE.MOUSE.PAN && mod);
    }
    if (rot) rotDrag = { x: e.clientX, y: e.clientY, moved: false };
  });
  addEventListener('pointermove', e => {
    if (!rotDrag) return;
    if (e.pointerType === 'touch' && !e.isPrimary) { rotDrag = null; return; }   // second finger: pinch/pan, not orbit
    if (!rotDrag.moved && Math.hypot(e.clientX - rotDrag.x, e.clientY - rotDrag.y) > 3) rotDrag.moved = true;
  });
  addEventListener('pointerup', () => { rotDrag = null; });
  addEventListener('pointercancel', () => { rotDrag = null; });
  function reticleTick() {
    const on = !obs && controls.enabled && controls.enableRotate && ((navShift && !navTyping()) || (rotDrag && rotDrag.moved) || keyTurn);
    if (on) {
      camera.updateMatrixWorld(); retPos.copy(controls.target).project(camera);   // this frame's camera, not last frame's
      const x = (retPos.x + 1) / 2 * canvas.clientWidth, y = (1 - retPos.y) / 2 * canvas.clientHeight;
      pivotRet.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    }
    if (on !== retOn) { retOn = on; pivotRet.style.opacity = on ? '1' : '0'; pivotRet.style.visibility = on ? 'visible' : 'hidden'; }
  }

  function navTick(dt) {
    const t = controls.target; keyTurn = false;
    if (navKeys.size && controls.enabled) {
      const k = c => (navKeys.has(c) ? 1 : 0);
      const up = k('ArrowUp') | k('KeyW'), dn = k('ArrowDown') | k('KeyS'), lf = k('ArrowLeft') | k('KeyA'), rt = k('ArrowRight') | k('KeyD');
      let fwd = 0, side = 0, tilt = 0, spin = k('KeyE') - k('KeyQ');
      if (navShift) { spin += rt - lf; tilt = up - dn; } else { fwd = up - dn; side = rt - lf; }
      keyTurn = !!(spin || tilt) && controls.enableRotate;
      const zoom = (k('PageDown') | k('Minus') | k('NumpadSubtract')) - (k('PageUp') | k('Equal') | k('NumpadAdd'));
      navOff.subVectors(camera.position, t);
      const dist = navOff.length();
      if (fwd || side) {                // along the ground, in the direction the camera faces (north-up in map mode)
        let fx = -navOff.x, fz = -navOff.z; const L = Math.hypot(fx, fz) || 1; fx /= L; fz /= L;
        const s = 0.5 * dist * dt;
        const dx = (fx * fwd - fz * side) * s, dz = (fz * fwd + fx * side) * s;
        t.x += dx; t.z += dz; camera.position.x += dx; camera.position.z += dz;
        navOff.subVectors(camera.position, t);
      }
      if (spin) navOff.applyAxisAngle(NAV_Y, spin * 1.2 * dt);   // map mode: update() clamps the azimuth back to north-up
      if (tilt || zoom) {
        navSph.setFromVector3(navOff);
        navSph.phi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, navSph.phi + tilt * 0.8 * dt));
        navSph.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, navSph.radius * Math.exp(zoom * 1.2 * dt)));
        navSph.makeSafe(); navOff.setFromSpherical(navSph);
      }
      camera.position.copy(t).add(navOff);
    }
    // the pivot stays on the ground (mouse or key pans used to leave it floating in the air or buried); the camera
    // keeps its height, so panning over a ridge does not bob the view. Never let the camera sink into the terrain.
    const g = heightAt(t.x, t.z) * ex;
    if (isFinite(g) && t.y !== g) t.y = g;
    const cg = heightAt(camera.position.x, camera.position.z) * ex + 30;
    if (camera.position.y < cg) camera.position.y = cg;
  }
  function lookAt(o) {                  // stand off the position, looking at it and past it toward the area centre
    const p = toLocal(o.e, o.n), g = heightAt(p.x, p.z) * ex;
    const away = new THREE.Vector3(p.x, 0, p.z).normalize();
    if (!isFinite(away.x)) away.set(0, 0, 1);
    controls.target.set(p.x, g, p.z);
    camera.position.set(p.x + away.x * 1300, g + 700, p.z + away.z * 1300);
  }
  const list = document.getElementById('oplist');
  SKETCH.ops.forEach((o, i) => {
    const row = document.createElement('div'); row.className = 'oprow';
    const b = document.createElement('button'); b.id = 'op' + i;
    const n = document.createElement('span'); n.textContent = o.name;
    const h = document.createElement('span'); h.textContent = o.h == null ? '' : Math.round(o.h) + ' m';
    b.append(n, h); b.title = o.note || ''; b.addEventListener('click', () => { if (obs) leaveObserver(); lookAt(o); });
    const s = document.createElement('button'); s.id = 'stand' + i; s.className = 'stand'; s.textContent = 'Stand';
    s.title = 'Stand at ' + o.name + ' at eye height'; s.addEventListener('click', () => enterObserver(o));
    row.append(b, s); list.appendChild(row);
  });
  document.getElementById('home').addEventListener('click', () => { if (obs) leaveObserver(); home(); });

  // thick screen-space lines (vendor/fatlines.js): plain WebGL lines are always 1 px, too faint on the imagery
  const fatMats = new Set();
  function fatMat(color, width, o) {
    const m = new THREE.LineMaterial(Object.assign({ color, linewidth: width, transparent: true, depthTest: false }, o || {}));
    if (o && o.dashed) { m.defines.USE_DASH = ''; m.needsUpdate = true; }   // r128 needs the define set by hand
    m.resolution.set(innerWidth, innerHeight); fatMats.add(m); return m;
  }
  function fatLine(pts, mat, loop) {
    const a = []; for (const p of loop ? [...pts, pts[0]] : pts) a.push(p.x, p.y, p.z);
    const g = new THREE.LineGeometry(); g.setPositions(a);
    const l = new THREE.Line2(g, mat); l.computeLineDistances(); return l;
  }
  function dropFat(o) { if (!o) return; o.parent && o.parent.remove(o); o.geometry && o.geometry.dispose(); if (o.material) { fatMats.delete(o.material); o.material.dispose(); } }
  function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); if (FXAA) FXAA.resize(); camera.aspect = w / h; camera.updateProjectionMatrix(); for (const m of fatMats) m.resolution.set(w, h); }
  addEventListener('resize', resize); resize();



  // ---- viewshed: radial sweep over the height grid, with earth curvature and standard refraction
  const VS = { op: null, eye: 1.8, tgt: 2.5, range: 10000 };
  const vis = new Uint8Array(NX * NY);            // 0 beyond range, 1 hidden, 2 visible
  const vsCanvas = document.createElement('canvas'); vsCanvas.width = NX; vsCanvas.height = NY;
  const vsCtx = vsCanvas.getContext('2d'), vsImg = vsCtx.createImageData(NX, NY);
  const vsTex = new THREE.CanvasTexture(vsCanvas); vsTex.magFilter = THREE.NearestFilter;
  const vsMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: vsTex, alphaMap: clipTex, alphaTest: 0.5, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  vsMesh.visible = false; scene.add(vsMesh);
  const R_EARTH = 6371000, K_REFR = 0.13, NEAR = 60;
  // HB = what blocks sight: the ground, raised to building roofs and tree tops where those layers are on (CITY sets it)
  const HB = new Float32Array(H);
  let standAt = (x, z) => heightAt(x, z);      // ground or roof under a position (CITY replaces it)
  function viewshed(ox, oz, eye, tgt, range) {
    // Pass 1: march rays outward and record the steepest ground slope seen so far along each ray.
    // Pass 2: judge every cell against the one ray that points straight at it, so a cell is never
    // called visible because a neighbouring ray happened to graze it.
    vis.fill(0);
    const h0 = standAt(ox, oz) + eye;
    const nRays = Math.ceil(2 * Math.PI * range / CELL * 1.25), SUB = 2, steps = Math.ceil(range / CELL) * SUB;
    const c0 = (ox + HW) / CELL - 0.5, r0 = (oz + HH) / CELL - 0.5, oc = Math.round(c0), orr = Math.round(r0);
    if (!viewshed.buf || viewshed.buf.length < nRays * (steps + 1)) viewshed.buf = new Float32Array(nRays * (steps + 1));
    const M = viewshed.buf, curv = (1 - K_REFR) / (2 * R_EARTH);
    for (let k = 0; k < nRays; k++) {
      const a = 2 * Math.PI * k / nRays, dc = Math.cos(a) / SUB, dr = Math.sin(a) / SUB, base = k * (steps + 1);
      let maxS = -Infinity; M[base] = maxS;
      for (let s = 1; s <= steps; s++) {
        const c = Math.round(c0 + dc * s), r = Math.round(r0 + dr * s);
        if (c < 0 || r < 0 || c >= NX || r >= NY) { for (let q = s; q <= steps; q++) M[base + q] = maxS; break; }
        const d = s * CELL / SUB, g = (c === oc && r === orr ? H : HB)[r * NX + c] - d * d * curv;   // the observer's own cell never blocks
        M[base + s] = maxS;                      // what blocks the view of anything at step s (cells before it)
        const sG = (g - h0) / d; if (sG > maxS) maxS = sG;
      }
    }
    const rc = Math.ceil(range / CELL);
    for (let r = Math.max(0, Math.floor(r0 - rc)); r <= Math.min(NY - 1, Math.ceil(r0 + rc)); r++) {
      for (let c = Math.max(0, Math.floor(c0 - rc)); c <= Math.min(NX - 1, Math.ceil(c0 + rc)); c++) {
        const dcl = c - c0, drl = r - r0, dCells = Math.hypot(dcl, drl);
        if (dCells < 0.5 || dCells * CELL > range) continue;
        let a = Math.atan2(drl, dcl); if (a < 0) a += 2 * Math.PI;
        const k = Math.round(a / (2 * Math.PI) * nRays) % nRays, s = Math.min(steps, Math.max(1, Math.round(dCells * SUB)));
        const d = dCells * CELL, i = r * NX + c, sT = (H[i] + tgt - d * d * curv - h0) / d;
        let blocked = sT < M[k * (steps + 1) + s];
        // near field: walk the exact line through the first 60 m, where ground right beside the observer decides most
        if (!blocked) {
          const nearCells = Math.min(dCells - 0.75, NEAR / CELL);
          for (let q = 0.1; q <= nearCells; q += 0.1) {
            const t2 = q / dCells, cc = Math.round(c0 + dcl * t2), rr = Math.round(r0 + drl * t2);
            if (cc === c && rr === r) break;
            const dd = q * CELL; if (dd < CELL) continue;
            if (!(cc === oc && rr === orr) && (HB[rr * NX + cc] - h0) / dd > sT) { blocked = true; break; }
          }
        }
        vis[i] = blocked ? 1 : 2;
      }
    }
    const px = vsImg.data;
    for (let i = 0; i < NX * NY; i++) {
      const v = vis[i], o = i * 4;
      if (v === 2) { px[o + 3] = 0; }
      else if (v === 1) { px[o] = 200; px[o + 1] = 64; px[o + 2] = 44; px[o + 3] = 120; }
      else { px[o] = 27; px[o + 1] = 31; px[o + 2] = 26; px[o + 3] = 150; }
    }
    vsCtx.putImageData(vsImg, 0, 0); vsTex.needsUpdate = true;
  }
  function visAt(x, z) {
    const c = Math.round((x + HW) / CELL - 0.5), r = Math.round((z + HH) / CELL - 0.5);
    return (c < 0 || r < 0 || c >= NX || r >= NY) ? 0 : vis[r * NX + c];
  }
  const covEl = document.getElementById('cov');
  function coverage() {
    covEl.textContent = '';
    if (!VS.op) return;
    const enemy = (window.__opfor ? window.__opfor.groups : []).map(g => ({ name: g.name, pts: window.__opfor.pathEN(g).map(q => [q.e, q.n]) })).filter(r => r.pts.length >= 2);
    if (!enemy.length) { const p0 = document.createElement('p'); p0.className = 'hint'; p0.textContent = 'No enemy routes yet: draw OPFOR groups to see how much of each route ' + VS.op.name + ' can see.'; covEl.appendChild(p0); return; }
    for (const rt of enemy) {
      let seen = 0, total = 0;
      const p = rt.pts.map(q => toLocal(q[0], q[1]));
      for (let k = 0; k < p.length - 1; k++) {
        const L = Math.hypot(p[k + 1].x - p[k].x, p[k + 1].z - p[k].z), n = Math.max(1, Math.ceil(L / 10));
        for (let j = 0; j < n; j++) {
          const x = p[k].x + (p[k + 1].x - p[k].x) * j / n, z = p[k].z + (p[k + 1].z - p[k].z) * j / n, v = visAt(x, z);
          if (v) { total++; if (v === 2) seen++; }
        }
      }
      const pc = total ? Math.round(100 * seen / total) : 0;
      const row = document.createElement('div');
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = rt.name;
      const bar = document.createElement('span'); bar.className = 'bar'; const fill = document.createElement('i'); fill.style.width = pc + '%'; bar.appendChild(fill);
      const pcs = document.createElement('span'); pcs.className = 'pc'; pcs.textContent = total ? pc + '%' : 'out';
      row.title = total ? rt.name + ': ' + pc + '% of the route in range is visible' : rt.name + ': beyond range';
      row.append(nm, bar, pcs); covEl.appendChild(row);
    }
    const cap = document.createElement('p'); cap.className = 'hint'; cap.style.margin = '2px 0 0';
    cap.textContent = 'Share of each OPFOR route, within range, where a vehicle is visible from ' + VS.op.name + '.';
    covEl.appendChild(cap);
  }
  function runViewshed() {
    if (!VS.op) { vsMesh.visible = false; covEl.textContent = ''; return; }
    const p = toLocal(VS.op.e, VS.op.n), t0 = performance.now();
    viewshed(p.x, p.z, VS.eye, VS.tgt, VS.range);
    window.__vsMs = performance.now() - t0;
    vsMesh.visible = true; coverage();
  }
  const vsSel = document.getElementById('vs-op');
  SKETCH.ops.forEach((o, i) => { const opt = document.createElement('option'); opt.value = String(i); opt.textContent = o.name; vsSel.appendChild(opt); });
  vsSel.addEventListener('change', () => { VS.op = vsSel.value === '' ? null : SKETCH.ops[+vsSel.value]; runViewshed(); });
  function pair(a, b, onA, onB) {
    const A = document.getElementById(a), B = document.getElementById(b);
    A.addEventListener('click', () => { A.setAttribute('aria-pressed', 'true'); B.setAttribute('aria-pressed', 'false'); onA(); runViewshed(); });
    B.addEventListener('click', () => { B.setAttribute('aria-pressed', 'true'); A.setAttribute('aria-pressed', 'false'); onB(); runViewshed(); });
  }
  pair('vs-stand', 'vs-prone', () => { VS.eye = 1.8; }, () => { VS.eye = 0.5; });
  pair('vs-veh', 'vs-gnd', () => { VS.tgt = 2.5; }, () => { VS.tgt = 0; });
  pair('vs-5', 'vs-10', () => { VS.range = 5000; }, () => { VS.range = 10000; });

  // ---- CITY: lidar buildings and trees (data/city.json, built by Trainer\pipeline\build_city.py + pack_city.py).
  //      Loads after the terrain is up. Buildings: one mesh per 1 km square, light baked into vertex colours.
  //      Trees: one instanced crown each. Both feed the viewshed through HB when their layer is on.
  const CITY = (() => {
    const grp = new THREE.Group(); grp.visible = false; scene.add(grp);
    const bGrp = new THREE.Group(), tGrp = new THREE.Group(); grp.add(bGrp, tGrp);
    const st = { buildings: true, trees: true, ready: false, parts: 0, trees_n: 0, ms: 0 };
    let roofStyle = 'plain';   // Display > Roofs: Plain (default) or Photo
    let OB = null, OT = null;                       // 10 m blocking grids, metres (0 = nothing)
    const idx = new Map(); const IDX = 50;          // 50 m buckets of building parts, for roofAt()
    let P = [];                                     // parts: { r: rings (dm), top (m), x0, z0, x1, z1 }
    onExCity = () => { grp.scale.y = ex; };
    const lin = v => Math.round(255 * Math.pow(v / 255, 2.2));   // sRGB byte -> linear byte (MeshBasic colours are linear)
    const L = new THREE.Vector3(-6000, 7000, -4000).normalize();
    async function grid(b64) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const raw = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const a = new Int16Array(raw), out = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = a[i] / 10;
      return out;
    }
    function inRing(r, x, z) {          // x, z in dm
      let inside = false;
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
        if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    }
    function roofAt(x, z, any) {        // highest building roof over a point (local metres), or null; any = even if Buildings are switched off
      if (!st.ready || (!st.buildings && !any)) return null;
      const list = idx.get(Math.floor(x / IDX) + ',' + Math.floor(z / IDX)); if (!list) return null;
      const X = x * 10, Z = z * 10; let best = null;
      for (const k of list) {
        const p = P[k]; if (X < p.x0 || X > p.x1 || Z < p.z0 || Z > p.z1) continue;
        if (!inRing(p.r[0], X, Z)) continue;
        let hole = false; for (let h = 1; h < p.r.length; h++) if (inRing(p.r[h], X, Z)) { hole = true; break; }
        if (!hole && (best === null || p.top > best)) best = p.top;
      }
      return best;
    }
    standAt = (x, z) => { const g = heightAt(x, z), r = roofAt(x, z); return r !== null && r > g ? r : g; };
    function blockers() {
      HB.set(H);
      if (st.ready) for (let i = 0; i < HB.length; i++) {
        if (st.buildings && OB[i] > HB[i]) HB[i] = OB[i];
        if (st.trees && OT[i] > HB[i]) HB[i] = OT[i];
      }
    }
    function area(r) { let a = 0; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1]; return a / 2; }
    function oriented(r, wantNeg) {     // outer rings: area < 0 so walls face out; holes: area > 0
      if ((area(r) < 0) === wantNeg) return r;
      const o = []; for (let i = r.length - 2; i >= 0; i -= 2) o.push(r[i], r[i + 1]); return o;
    }
    function buildBuildings(B) {
      // bucket parts by 1 km square (of the first vertex) -> one mesh each
      const sq = new Map();
      for (const b of B) {
        const rings = [oriented(b[3], true)]; for (let h = 4; h < b.length; h++) rings.push(oriented(b[h], false));
        const o = rings[0]; let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, gMin = Infinity;
        for (let i = 0; i < o.length; i += 2) {
          x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]);
          gMin = Math.min(gMin, heightAt(o[i] / 10, o[i + 1] / 10));
        }
        // base: down to the lower of the lidar ground and the 10 m terrain, so nothing floats.
        // Bridge decks (flag bit 24, from OSM): a 1.5 m slab in asphalt grey with open space under it.
        const deck = (b[2] >> 24) & 1;
        const base = deck ? b[1] / 10 - 1.5 : Math.min(b[0] / 10, gMin) - 1, top = deck ? b[1] / 10 : Math.max(b[1] / 10, base + 2.5);
        const key = Math.floor(o[0] / 10000) + ',' + Math.floor(o[1] / 10000);
        if (!sq.has(key)) sq.set(key, []);
        if (deck) { st.decks = (st.decks || 0) + 1; sq.get(key).push({ rings, base, top, rgb: 0x5c5c5a }); continue; }
        const k = P.length; P.push({ r: rings, top, x0, z0, x1, z1 });
        for (let bx = Math.floor(x0 / 10 / IDX); bx <= Math.floor(x1 / 10 / IDX); bx++)
          for (let bz = Math.floor(z0 / 10 / IDX); bz <= Math.floor(z1 / 10 / IDX); bz++) {
            const key = bx + ',' + bz; if (!idx.has(key)) idx.set(key, []); idx.get(key).push(k);
          }
        sq.get(key).push({ rings, base, top, rgb: b[2] & 0xffffff });
      }
      // walls: flat colours with the sun baked in, plus a window pattern (floors every 3.2 m, bays every 2.8 m) that
      // fades out with distance; roofs up to 40 m: the NAIP photo draped on top (lit like the ground, so they match it);
      // taller roofs keep a flat colour because tall towers lean in the photo and their roof image is offset
      const wallMat = new THREE.MeshBasicMaterial({ vertexColors: true });
      wallMat.extensions = { derivatives: true };
      wallMat.onBeforeCompile = sh => {
        sh.vertexShader = 'attribute vec3 fac;\nvarying vec3 vFac;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFac = fac * 0.1;');
        sh.fragmentShader = 'varying vec3 vFac;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec3 f = vFac; float fl = f.y / 3.2, cx = f.x / 2.8;
    float fw = max(fwidth(fl), fwidth(cx)), near = 1.0 - smoothstep(0.12, 0.35, fw);
    if (f.z > 6.0 && f.y > 1.5 && f.y < f.z - 0.8) {
      float wy = smoothstep(0.28, 0.34, fract(fl)) * (1.0 - smoothstep(0.78, 0.84, fract(fl)));
      float wx = smoothstep(0.14, 0.22, fract(cx)) * (1.0 - smoothstep(0.78, 0.86, fract(cx)));
      vec3 glass = diffuseColor.rgb * 0.35 + vec3(0.015, 0.025, 0.04);
      diffuseColor.rgb = mix(diffuseColor.rgb, glass, mix(0.16, wx * wy * 0.6, near));   // far: an average tone
    }
    diffuseColor.rgb *= mix(0.68, 1.0, smoothstep(0.0, 6.0, f.y));                          // darker at street level
  }`);
      };
      const roofMat = new THREE.MeshLambertMaterial({ map: tex, color: new THREE.Color(1.08, 1.08, 1.06) });   // Photo roofs: a touch brighter than the ground
      // Plain roofs: one tone per building (its photo colour, toned and varied), mottled in world space so it isn't flat
      const plainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
      plainMat.onBeforeCompile = sh => {
        sh.vertexShader = 'varying vec2 vW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vW = (modelMatrix * vec4(transformed, 1.0)).xz;');
        sh.fragmentShader = `varying vec2 vW;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
` + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= 0.9 + 0.12 * vnoise(vW * 0.35) + 0.08 * vnoise(vW * 0.06);');
      };
      const rimMat = new THREE.LineBasicMaterial({ color: 0x8c8880, transparent: true, opacity: 0.45, depthWrite: false });   // faint roof edge, so a roof reads against the ground behind it
      const WP = (NX - 1) * CELL, HP = (NY - 1) * CELL, TALL = 40;
      const FAC_LOW = [[226, 222, 212], [214, 204, 186], [196, 182, 158], [172, 168, 160], [190, 186, 176], [205, 196, 182], [160, 150, 136]];
      const FAC_TALL = [[232, 230, 224], [222, 218, 208], [200, 196, 186], [150, 166, 182], [118, 134, 152], [176, 170, 160], [208, 198, 180]];
      for (const [key, list] of sq) {
        const [kx, kz] = key.split(',').map(Number), ox = kx * 10000, oz = kz * 10000;   // mesh origin, dm
        let nw = 0, nwi = 0, nr = 0, nri = 0, ne = 0;
        for (const b of list) for (const r of b.rings) {
          const n = r.length / 2; nw += n * 4 + n; nwi += n * 6 + (n + 2) * 3; nr += n; nri += (n + 2) * 3; ne += n * 2;
        }
        const pos = new Int16Array(nw * 3), colr = new Uint8Array(nw * 3), fac = new Int16Array(nw * 3), ind = new Uint32Array(nwi);
        // roofs: two sets, RR (normal: Plain or Photo) and RT (over 40 m: always Plain, towers lean in the photo)
        const mkR = () => ({ pos: new Int16Array(nr * 3), uv: new Float32Array(nr * 2), col: new Uint8Array(nr * 3), ind: new Uint32Array(nri), v: 0, q: 0 });
        const RR = mkR(), RT = mkR();
        let v = 0, q = 0;
        const epos = new Int16Array(ne * 3); let e = 0;
        for (const b of list) {
          const R = b.rgb >> 16 & 255, G = b.rgb >> 8 & 255, Bl = b.rgb & 255;
          const yb = Math.round(b.base * 10), yt = Math.round(b.top * 10), hh = yt - yb;
          // walls: a facade colour per building (white render, tan, stone, concrete, blue-grey glass; towers lean to
          // white and glass), with a quarter of the roof colour mixed in so neighbours differ
          const wh = Math.imul((b.rgb ^ (yb * 31) ^ (yt * 7919) ^ (b.rings[0].length * 104729)) >>> 0, 2246822519) >>> 0;
          const FAC = hh > 300 ? FAC_TALL : FAC_LOW, fc = FAC[wh % FAC.length], fl = 0.92 + ((wh >> 10) & 63) / 63 * 0.16;
          const wr = (fc[0] * 0.75 + R * 0.25) * fl, wg = (fc[1] * 0.75 + G * 0.25) * fl, wb = (fc[2] * 0.75 + Bl * 0.25) * fl;
          for (const r of b.rings) {
            const n = r.length / 2; let u = 0;
            for (let i = 0; i < n; i++) {           // walls: 4 vertices per edge, flat shade from the sun
              const j = (i + 1) % n, ax = r[2 * i] - ox, az = r[2 * i + 1] - oz, bx = r[2 * j] - ox, bz = r[2 * j + 1] - oz;
              const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
              const s = 0.5 + 0.55 * Math.max(0, (-dz / len) * L.x + (dx / len) * L.z);   // stronger sun / shade sides
              const c = [lin(wr * s), lin(wg * s), lin(wb * s)];
              const u0 = u % 30000, u1 = u0 + Math.round(len); u += Math.round(len);
              for (const [x, y, z, uu, hy] of [[ax, yb, az, u0, 0], [bx, yb, bz, u1, 0], [bx, yt, bz, u1, hh], [ax, yt, az, u0, hh]]) {
                pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z; colr.set(c, v * 3);
                fac[v * 3] = uu; fac[v * 3 + 1] = hy; fac[v * 3 + 2] = hh; v++;
              }
              const a = v - 4; ind.set([a, a + 1, a + 2, a, a + 2, a + 3], q); q += 6;
              epos.set([ax, yt + 2, az, bx, yt + 2, bz], e * 3); e += 2;   // roof rim, 0.2 m up
            }
          }
          // roof: earcut over the outer ring with its holes
          const outer = [], holes = [], all = [];
          const toV = r => { const a = []; for (let i = 0; i < r.length; i += 2) a.push(new THREE.Vector2(r[i], r[i + 1])); return a; };
          b.rings.forEach((r, h) => { const pts = toV(r); (h ? holes.push(pts) : outer.push(...pts)); all.push(...pts); });
          const tris = THREE.ShapeUtils.triangulateShape(outer, holes);
          // plain tone: the photo colour, a third of the way to grey, lifted, then varied per building
          const hsh = Math.imul((b.rgb ^ (yt * 7919) ^ (all.length * 104729)) >>> 0, 2654435761) >>> 0;
          const gr = (R + G + Bl) / 3, vb = 0.86 + (hsh & 255) / 255 * 0.3, warm = ((hsh >> 8) & 255) / 255 - 0.5;
          const tone = c => Math.max(0, Math.min(255, ((c * 0.65 + gr * 0.35) * 1.12 + 10) * vb));
          const rc = [lin(tone(R + warm * 14)), lin(tone(G)), lin(tone(Bl - warm * 14))];
          const A = b.top - b.base > TALL ? RT : RR, s0 = A.v;
          for (const p of all) {
            A.pos[A.v * 3] = p.x - ox; A.pos[A.v * 3 + 1] = yt; A.pos[A.v * 3 + 2] = p.y - oz;
            A.uv[A.v * 2] = (p.x / 10 + WP / 2) / WP; A.uv[A.v * 2 + 1] = (HP / 2 - p.y / 10) / HP; A.col.set(rc, A.v * 3); A.v++;
          }
          for (const t of tris) { A.ind.set([s0 + t[0], s0 + t[2], s0 + t[1]], A.q); A.q += 3; }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
        g.setAttribute('color', new THREE.BufferAttribute(colr.subarray(0, v * 3), 3, true));
        g.setAttribute('fac', new THREE.BufferAttribute(fac.subarray(0, v * 3), 3));
        g.setIndex(new THREE.BufferAttribute(ind.subarray(0, q), 1));
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, wallMat); m.scale.setScalar(0.1); m.position.set(ox / 10, 0, oz / 10);
        bGrp.add(m);
        for (const [A, tall] of [[RR, false], [RT, true]]) {
          if (!A.v) continue;
          const rg = new THREE.BufferGeometry();
          rg.setAttribute('position', new THREE.BufferAttribute(A.pos.subarray(0, A.v * 3), 3));
          rg.setAttribute('uv', new THREE.BufferAttribute(A.uv.subarray(0, A.v * 2), 2));
          rg.setAttribute('color', new THREE.BufferAttribute(A.col.subarray(0, A.v * 3), 3, true));
          const nrm = new Int8Array(A.v * 3); for (let k = 0; k < A.v; k++) nrm[k * 3 + 1] = 127;
          rg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
          rg.setIndex(new THREE.BufferAttribute(A.ind.subarray(0, A.q), 1));
          rg.computeBoundingSphere();
          const rm = new THREE.Mesh(rg, tall || roofStyle === 'plain' ? plainMat : roofMat); rm.scale.setScalar(0.1); rm.position.set(ox / 10, 0, oz / 10);
          if (!tall) rm.userData = { roofStyle: true, plain: plainMat, photo: roofMat };
          bGrp.add(rm);
        }
        if (e) {
          const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.BufferAttribute(epos.subarray(0, e * 3), 3));
          eg.computeBoundingSphere();
          const em = new THREE.LineSegments(eg, rimMat); em.scale.setScalar(0.1); em.position.set(ox / 10, 0, oz / 10); bGrp.add(em);
        }
      }
    }
    // The ground photo still shows every roof, so with 3D buildings each roof appears twice and the eye can't tell
    // roof from ground. Paint the footprints out of the ground copy (filled from the surrounding ground, toned toward
    // pavement) and darken a soft ring at each base. Roofs keep the original photo. Buildings off -> original ground.
    let groundTex = null;
    function cleanGround() {
      // blurs run on a quarter-size copy (full-size canvas blurs froze some browsers); only the cut-out and the
      // pavement tint are drawn at full size
      const t0 = performance.now();
      const img = tex.image, w = img.width, h = img.height, WP = (NX - 1) * CELL, HP = (NY - 1) * CELL;
      // footprints are traced straight into each context (a shared Path2D with ~55k outlines took over a minute to build)
      const XS = [];                  // one entry per building part: its rings in canvas pixels
      for (const p of P) XS.push(p.r.map(r => {
        const q = new Float32Array(r.length);
        for (let i = 0; i < r.length; i += 2) { q[i] = (r[i] / 10 + WP / 2) / WP * w; q[i + 1] = (r[i + 1] / 10 + HP / 2) / HP * h; }
        return q;
      }));
      const fillFp = ctx => {         // many small fills: one fill of a 55k-outline path took over a minute
        for (const rings of XS) {
          ctx.beginPath();
          for (const q of rings) { ctx.moveTo(q[0], q[1]); for (let i = 2; i < q.length; i += 2) ctx.lineTo(q[i], q[i + 1]); ctx.closePath(); }
          ctx.fill('evenodd');
        }
      };
      const mk = (cw, ch) => { const c = document.createElement('canvas'); c.width = cw; c.height = ch; return [c, c.getContext('2d')]; };
      const sw = w >> 2, shh = h >> 2;
      // full size: photo with the footprints cut out
      const [A, a] = mk(w, h); a.drawImage(img, 0, 0); a.globalCompositeOperation = 'destination-out'; fillFp(a);
      // quarter size: the surrounding ground smeared into the holes, and a soft footprint mask for the base ring
      const [S, sctx] = mk(sw, shh);
      sctx.fillStyle = '#86857f'; sctx.fillRect(0, 0, sw, shh);
      sctx.filter = 'blur(6px)'; sctx.drawImage(A, 0, 0, sw, shh); sctx.filter = 'blur(2px)'; sctx.drawImage(A, 0, 0, sw, shh); sctx.filter = 'none';
      const [M, m] = mk(sw, shh);
      const [M0, m0] = mk(sw, shh);
      m0.fillStyle = '#fff'; m0.fillRect(0, 0, sw, shh); m0.scale(0.25, 0.25); m0.fillStyle = 'rgb(150,150,150)'; fillFp(m0);
      m.fillStyle = '#fff'; m.fillRect(0, 0, sw, shh); m.filter = 'blur(3px)'; m.drawImage(M0, 0, 0); m.filter = 'none';
      const t1 = performance.now();
      const [O, o] = mk(w, h);
      o.imageSmoothingEnabled = true; o.drawImage(S, 0, 0, w, h); o.drawImage(A, 0, 0);
      o.globalAlpha = 0.35; o.fillStyle = '#7f7e79'; fillFp(o); o.globalAlpha = 1;      // toward pavement
      o.globalCompositeOperation = 'multiply'; o.drawImage(M, 0, 0, w, h); o.globalCompositeOperation = 'source-over';   // base ring
      // urban mask (quarter size): share of building within ~60 m, minus green and water, so parks and fields keep the photo
      {
        const [Dn, dn] = mk(sw, shh); dn.filter = 'blur(5px)'; dn.drawImage(M0, 0, 0); dn.filter = 'none';
        const dd = dn.getImageData(0, 0, sw, shh).data;
        const [Pq, pq] = mk(sw, shh); pq.drawImage(img, 0, 0, sw, shh); const pd = pq.getImageData(0, 0, sw, shh).data;
        const [U, uc] = mk(sw, shh), ud = uc.createImageData(sw, shh), u8 = ud.data;
        for (let i = 0; i < sw * shh; i++) {
          const cov = (255 - dd[i * 4]) / 105, R = pd[i * 4], G = pd[i * 4 + 1], B = pd[i * 4 + 2];
          let u = Math.min(1, Math.max(0, (cov - 0.06) / 0.16));
          if (G > R + 6 && G > B + 2) u *= 0.15;            // grass and trees stay photo
          if (B > R + 12 && G > R) u = 0;                    // water stays water
          u8[i * 4] = u8[i * 4 + 1] = u8[i * 4 + 2] = Math.round(u * 255); u8[i * 4 + 3] = 255;
        }
        uc.putImageData(ud, 0, 0);
        const [U2, u2] = mk(sw, shh); u2.filter = 'blur(1.5px)'; u2.drawImage(U, 0, 0);
        const ut = new THREE.CanvasTexture(U2); ut.minFilter = THREE.LinearFilter; URBAN.map.value = ut;
      }
      groundTex = new THREE.CanvasTexture(O); groundTex.encoding = THREE.sRGBEncoding; groundTex.anisotropy = tex.anisotropy;
      photoMat.map = groundTex; photoMat.needsUpdate = true;
      st.groundMs = [Math.round(t1 - t0), Math.round(performance.now() - t1)];
    }
    // ---- tree culling (perf, 2026-11-03): trees are drawn only in 250 m cells some camera (main view or an open UAS feed)
    //      can see, in three levels of detail by distance (all devices): full trees close in; past TREE_NEAR a 20-triangle
    //      crown, a 20-triangle palm and no trunk (a trunk is under a pixel wide there); past TREE_MID an 8-triangle crown;
    //      past TREE_FAR nothing. Distances are 'effective': they shrink with zoom and grow with screen height in pixels,
    //      so a swap happens at the same size on screen (~10 px crown at TREE_NEAR on a 800 px view). Lite halves them.
    const TREE_CELL = 250, TREE_Q = LITE ? 0.5 : 1, TREE_NEAR = 600 * TREE_Q, TREE_MID = 2000 * TREE_Q, TREE_FAR = 20000 * TREE_Q;
    let treeLOD = null;
    function makeTreeLOD(cats) {
      const NCX = Math.ceil(2 * HW / TREE_CELL), NCZ = Math.ceil(2 * HH / TREE_CELL), cellOf = (x, z) => Math.min(NCX - 1, Math.max(0, Math.floor((x + HW) / TREE_CELL))) + NCX * Math.min(NCZ - 1, Math.max(0, Math.floor((z + HH) / TREE_CELL)));
      const cellTop = new Float32Array(NCX * NCZ).fill(-1e9);
      for (const c of cats) {                        // master copy, grouped by cell
        const m = c.src, n = m.count, M = m.instanceMatrix.array, C = m.instanceColor ? m.instanceColor.array : null, cell = new Int32Array(n), ord = [];
        for (let i = 0; i < n; i++) { const x = M[i * 16 + 12], y = M[i * 16 + 13], z = M[i * 16 + 14]; cell[i] = cellOf(x, z); cellTop[cell[i]] = Math.max(cellTop[cell[i]], y + 40); ord.push(i); }
        ord.sort((a, b) => cell[a] - cell[b]);
        c.M = new Float32Array(n * 16); c.C = C ? new Float32Array(n * 3) : null; c.start = new Int32Array(NCX * NCZ + 1);
        ord.forEach((i, j) => { c.M.set(M.subarray(i * 16, i * 16 + 16), j * 16); if (C) c.C.set(C.subarray(i * 3, i * 3 + 3), j * 3); c.start[cell[i] + 1]++; });
        for (let k = 0; k < NCX * NCZ; k++) c.start[k + 1] += c.start[k];
      }
      const cells = []; for (let k = 0; k < NCX * NCZ; k++) if (cellTop[k] > -1e9) cells.push(k);
      const sph = new THREE.Sphere(), fr = new THREE.Frustum(), pm = new THREE.Matrix4(), last = { key: '' };
      function update(cams, force) {
        const key = cams.map(c => [c.position.x, c.position.y, c.position.z].map(v => Math.round(v / 20)).join(',') + ':' + c.quaternion.toArray().map(v => v.toFixed(2)).join(',') + ':' + Math.round(c.fov)).join('|');
        if (!force && key === last.key) return; last.key = key;
        const px = 800 / Math.max(400, renderer.domElement.height), T45 = Math.tan(Math.PI / 8);
        const frs = cams.map(c => { c.updateMatrixWorld(); const f = new THREE.Frustum(); f.setFromProjectionMatrix(pm.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse)); return { c, f, k: Math.tan(c.fov * Math.PI / 360) / T45 * px }; });
        for (const c of cats) for (const t of c.tiers) if (t.mesh) t.mesh._n = 0;
        for (const k of cells) {
          const cx = (k % NCX + 0.5) * TREE_CELL - HW, cz = (Math.floor(k / NCX) + 0.5) * TREE_CELL - HH;
          sph.center.set(cx, cellTop[k] * ex * 0.5, cz); sph.radius = TREE_CELL * 0.75 + Math.max(0, cellTop[k]) * ex * 0.5;
          let d = Infinity;
          for (const q of frs) if (q.f.intersectsSphere(sph)) d = Math.min(d, Math.max(0, q.c.position.distanceTo(sph.center) - sph.radius) * q.k);
          if (d === Infinity) continue;
          for (const c of cats) {
            const a = c.start[k], b = c.start[k + 1]; if (a === b) continue;
            const t = c.tiers.find(t => d < t.to), dst = t && t.mesh; if (!dst) continue;
            dst.instanceMatrix.array.set(c.M.subarray(a * 16, b * 16), dst._n * 16); if (c.C) dst.instanceColor.array.set(c.C.subarray(a * 3, b * 3), dst._n * 3);
            dst._n += b - a;
          }
        }
        for (const c of cats) for (const { mesh: m } of c.tiers) if (m) {
          m.count = m._n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
        }
      }
      return { update, cells: cells.length };
    }
    function buildTrees(T) {
      // Lumpy crowns (4 shapes, darker underneath) on trunks, coloured from the photo under each tree;
      // tall narrow trees (palms, mostly) get a thin leaning trunk and a star of drooping fronds.
      const n = T.length / 4;
      const pc = document.createElement('canvas'); pc.width = 2048; pc.height = 1706;
      const pg = pc.getContext('2d'); pg.drawImage(tex.image, 0, 0, pc.width, pc.height);
      const PX = pg.getImageData(0, 0, pc.width, pc.height).data;
      const WP = (NX - 1) * CELL, HP = (NY - 1) * CELL;
      function photoAt(x, z) {                // average 2 x 2 photo pixels (~6 m) under a point, sRGB 0-255
        const c = Math.floor((x + WP / 2) / WP * pc.width), r = Math.floor((z + HP / 2) / HP * pc.height);
        let R = 0, G = 0, B = 0, k = 0;
        for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
          const cc = Math.min(pc.width - 1, Math.max(0, c + dc)), rr = Math.min(pc.height - 1, Math.max(0, r + dr)), o = (rr * pc.width + cc) * 4;
          R += PX[o]; G += PX[o + 1]; B += PX[o + 2]; k++;
        }
        return [R / k, G / k, B / k];
      }
      function leafColour(x, z, out, palm) {
        // photo colour pulled toward a leaf green (the 6 m sample often catches pavement or roof), kept mid-dark
        let [R, G, B] = photoAt(x, z);
        const w = palm ? 0.35 : 0.45;
        R = R * w + 62 * (1 - w); G = G * w + 92 * (1 - w); B = B * w + 48 * (1 - w);
        const lum = 0.3 * R + 0.59 * G + 0.11 * B, k = Math.min(1.15, Math.max(0.75, 92 / Math.max(1, lum)));
        return out.setRGB(Math.min(1, R * k / 255), Math.min(1, G * k / 255), Math.min(1, B * k / 255)).convertSRGBToLinear();
      }
      function crownGeo(seed, detail = 1) {     // detail 1: 80 triangles, 0: 20, -1: an 8-triangle octahedron
        const g = detail < 0 ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, detail), p = g.attributes.position, c = new Float32Array(p.count * 3);
        const a = 3.1 + seed, b = 2.7 + seed * 0.7, d = 3.3 + seed * 1.3;
        for (let i = 0; i < p.count; i++) {
          let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          const k = 1 + 0.24 * Math.sin(a * x + seed) * Math.sin(b * y + 2 * seed) * Math.sin(d * z + 3 * seed) + 0.08 * Math.sin(7 * x + 5 * z + seed);
          x *= k; y *= k; z *= k;
          if (y < -0.5) y = -0.5 + (y + 0.5) * 0.4;                    // flatter underneath
          p.setXYZ(i, x, y, z);
          const sh = 0.55 + 0.45 * Math.min(1, Math.max(0, (y + 0.6) / 1.5)); c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = sh;
        }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.computeVertexNormals(); return g;
      }
      function palmGeo(F = 9, S = 4) {          // F fronds of S segments: 9 x 4 = 72 triangles, 5 x 2 = 20
        const P = [], C = [];
        for (let f = 0; f < F; f++) {
          const ang = f / F * Math.PI * 2 + (f % 2) * 0.2, ca = Math.cos(ang), sa = Math.sin(ang), up = f % 3 === 0 ? 0.25 : 0;
          for (let s2 = 0; s2 < S; s2++) {
            const t0 = s2 / S, t1 = (s2 + 1) / S;
            const pt = (t, side) => { const w = 0.16 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * side, yy = up * t - 0.6 * t * t;
              return [ca * t - sa * w, yy, sa * t + ca * w]; };
            const q = [pt(t0, -1), pt(t1, -1), pt(t1, 1), pt(t0, 1)];
            for (const k of [0, 1, 2, 0, 2, 3]) { P.push(...q[k]); const sh = 0.6 + 0.4 * (1 - (k === 0 || k === 3 ? t0 : t1)); C.push(sh, sh, sh); }
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
        g.computeVertexNormals(); return g;
      }
      const isPalm = i => { const h = T[4 * i + 2] / 10, r = T[4 * i + 3] / 10; return h >= 9 && r <= 3.2 && h >= 3.2 * r; };
      const VAR = 4, counts = new Array(VAR).fill(0); let nPalm = 0;
      const hash = i => (Math.imul(i + 1, 2654435761) >>> 0);
      for (let i = 0; i < n; i++) { if (isPalm(i)) nPalm++; else counts[hash(i) % VAR]++; }
      const leafMat = new THREE.MeshLambertMaterial({ vertexColors: true });
      const lod = (geo, mat, c) => { const m = new THREE.InstancedMesh(geo, mat, Math.max(1, c)); m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, c) * 3), 3); m.count = 0; return m; };
      const crowns = counts.map((c, k) => new THREE.InstancedMesh(crownGeo(k * 1.7 + 0.4), leafMat, Math.max(1, c)));
      const crownsMid = counts.map((c, k) => lod(crownGeo(k * 1.7 + 0.4, 0), leafMat, c)), crownsFar = counts.map((c, k) => lod(crownGeo(k * 1.7 + 0.4, -1), leafMat, c));
      const palmMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      const palms = new THREE.InstancedMesh(palmGeo(), palmMat, Math.max(1, nPalm)), palmsFar = lod(palmGeo(5, 2), palmMat, nPalm);
      const tg = new THREE.CylinderGeometry(0.5, 0.75, 1, 6, 1, true); tg.translate(0, 0.5, 0);
      const trunks = new THREE.InstancedMesh(tg, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
      const mtx = new THREE.Matrix4(), col = new THREE.Color(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
      const e = new THREE.Euler(), up = new THREE.Vector3();
      const BARK = new THREE.Color(0x4a3b2c).convertSRGBToLinear(), PALMBARK = new THREE.Color(0x8a7c66).convertSRGBToLinear();
      const used = new Array(VAR).fill(0); let pi = 0, ti = 0;
      for (let i = 0; i < n; i++) {
        const x = T[4 * i] / 10, z = T[4 * i + 1] / 10, h = T[4 * i + 2] / 10, r = T[4 * i + 3] / 10, g0 = heightAt(x, z), hs = hash(i);
        if (isPalm(i)) {
          // leaning trunk, fronds at the top
          e.set(((hs & 255) / 255 - 0.5) * 0.18, 0, (((hs >> 8) & 255) / 255 - 0.5) * 0.18); q.setFromEuler(e);
          const L = h - 0.4; up.set(0, L, 0).applyQuaternion(q);
          p.set(x, g0, z); sc.set(0.32, L, 0.32); mtx.compose(p, q, sc); trunks.setMatrixAt(ti, mtx); trunks.setColorAt(ti++, PALMBARK);
          e.set(0, (hs % 628) / 100, 0); q.setFromEuler(e);
          const fr = Math.max(2.5, r * 1.15);
          p.set(x + up.x, g0 + up.y + 0.4, z + up.z); sc.set(fr, fr, fr); mtx.compose(p, q, sc);
          palms.setMatrixAt(pi, mtx); palms.setColorAt(pi++, leafColour(x, z, col, true));
          continue;
        }
        const v = hs % VAR, cv = Math.max(1, Math.min(r * 1.15, h * 0.5)), yc = g0 + h - cv;   // crown about the top 60 % of the tree
        e.set(0, (hs % 628) / 100, 0); q.setFromEuler(e);
        const sq2 = 0.9 + ((hs >> 12) & 255) / 255 * 0.25;
        p.set(x, yc, z); sc.set(r * sq2, cv, r / sq2); mtx.compose(p, q, sc);
        crowns[v].setMatrixAt(used[v], mtx); crowns[v].setColorAt(used[v]++, leafColour(x, z, col, false));
        const th = yc - g0;
        if (th > 0.8) {
          const tr = Math.min(0.6, Math.max(0.14, r * 0.07));
          p.set(x, g0, z); sc.set(tr, th, tr); mtx.compose(p, q, sc); trunks.setMatrixAt(ti, mtx); trunks.setColorAt(ti++, BARK);
        }
      }
      trunks.count = ti; palms.count = pi; crowns.forEach((m, k) => { m.count = used[k]; });
      for (const m of [...crowns, ...crownsMid, ...crownsFar, palms, palmsFar, trunks]) { m.frustumCulled = false; tGrp.add(m); }
      // ---- tree culling (2026-11-03, perf): the instance lists above become the master copy, sorted by 250 m cell.
      //      Each update copies only the cells some camera can see into the live list of the level of detail that
      //      cell's distance calls for (see TREE_NEAR / TREE_MID / TREE_FAR).
      treeLOD = makeTreeLOD([
        ...crowns.map((m, k) => ({ src: m, tiers: [{ mesh: m, to: TREE_NEAR }, { mesh: crownsMid[k], to: TREE_MID }, { mesh: crownsFar[k], to: TREE_FAR }] })),
        { src: palms, tiers: [{ mesh: palms, to: TREE_NEAR }, { mesh: palmsFar, to: TREE_FAR }] },
        { src: trunks, tiers: [{ mesh: trunks, to: TREE_NEAR }] }
      ]);
      st.palms = pi;
    }
    const metaEl = document.getElementById('city-meta');
    async function init() {
      let d;
      try { d = await load('city.json', 'json'); }
      catch (e) { console.warn('city.json not loaded:', e.message); if (metaEl) metaEl.textContent = 'Buildings and trees: data not found.'; return; }
      const t0 = performance.now();
      [OB, OT] = await Promise.all([grid(d.ob), grid(d.ot)]);
      { // trimmed edge (TRIM): drop buildings and trees out in the false land, where they would stand bright in the shadow
        d.b = d.b.filter(b => edgeAt(b[3][0] / 10, b[3][1] / 10) > 0.75);
        const t = []; for (let i = 0; i < d.t.length; i += 4) if (edgeAt(d.t[i] / 10, d.t[i + 1] / 10) > 0.75) t.push(d.t[i], d.t[i + 1], d.t[i + 2], d.t[i + 3]); d.t = t; }
      buildBuildings(d.b); cleanGround(); buildTrees(d.t);
      st.parts = d.b.length; st.trees_n = d.t.length / 4; st.ms = Math.round(performance.now() - t0);
      grp.scale.y = ex; grp.visible = true; bGrp.visible = st.buildings; tGrp.visible = st.trees;
      st.ready = true; blockers(); if (VS.op) runViewshed(); if (onCityReady) onCityReady();
      if (metaEl) metaEl.textContent = 'Buildings and trees: lidar 2020 (NOAA, ~15 pts/m²), roof colour from NAIP; roads and bridges © OpenStreetMap contributors (ODbL). Sight is blocked on a 10 m grid.';
    }
    function setRoofs(style) {
      roofStyle = style;
      for (const m of bGrp.children) if (m.userData.roofStyle) m.material = style === 'plain' ? m.userData.plain : m.userData.photo;
    }
    function set(which, on) {
      st[which] = on; (which === 'buildings' ? bGrp : tGrp).visible = on;
      if (which === 'buildings' && groundTex) { photoMat.map = on ? groundTex : tex; photoMat.needsUpdate = true; }
      blockers(); if (VS.op) runViewshed();
    }
    init();
    return { set, setRoofs, roofAt, treeTick: (cams, force) => { if (treeLOD) treeLOD.update(cams, force); }, solidAt: (x, z) => roofAt(x, z, true) !== null, get ready() { return st.ready; }, debug: { st, P, roofAt, idx, get HB() { return HB; }, bGrp, tGrp } };
  })();
  window.__city = CITY.debug; window.__trees = CITY.treeTick;

  // ---- ROADS: OpenStreetMap roads (data/roads.json, pack_roads.py) as flat ribbons draped on the terrain - shapes,
  //      not pixels, so they stay crisp at any zoom with no texture. Asphalt with light kerb strips on streets and
  //      arterials; service lanes plain. Shown with Ground: Hybrid.
  // ---- ROADNET: the OSM roads as a graph, for road-snapped enemy routes (Lee, 2026-11-02: snapping is the default).
  //      Nodes = road vertices (shared vertices join roads at junctions). Edge cost = length × class weight, so columns
  //      prefer bigger roads a little. No one-way streets (OSM direction not kept) — military traffic, accepted.
  let ROADNET = null, onRoadNet = null, onCityReady = null;
  const ROAD_W = [1.0, 1.1, 1.3];       // cost per metre by road class (0 major, 1 mid, 2 minor) — placeholder
  const ROAD_REACH = 300;               // a clicked point snaps to a road only if one is within this many metres
  function buildRoadNet(R) {
    const key = new Map(), X = [], Z = [], E = [], WD = [];  // E: [a, b, cls]; WD: road width m per edge
    const node = (x, z) => { const k = x * 262144 + z; let i = key.get(k); if (i === undefined) { i = X.length; key.set(k, i); X.push(x / 10); Z.push(z / 10); } return i; };
    for (const [wd, cls, f] of R) { let p = node(f[0], f[1]); for (let i = 2; i < f.length; i += 2) { const q = node(f[i], f[i + 1]); if (q !== p) { E.push(p, q, cls); WD.push(wd / 10); } p = q; } }
    const n = X.length, deg = new Int32Array(n + 1);
    for (let e = 0; e < E.length; e += 3) { deg[E[e] + 1]++; deg[E[e + 1] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const to = new Int32Array(deg[n]), w = new Float32Array(deg[n]), eid = new Int32Array(deg[n]), fill = deg.slice(0, n);
    const SEG = 100, seg = new Map();                          // 100 m buckets of edge ids
    for (let e = 0; e < E.length; e += 3) {
      const a = E[e], b = E[e + 1], c = ROAD_W[E[e + 2]] * Math.hypot(X[b] - X[a], Z[b] - Z[a]);
      eid[fill[a]] = e / 3; eid[fill[b]] = e / 3; to[fill[a]] = b; w[fill[a]++] = c; to[fill[b]] = a; w[fill[b]++] = c;
      const x0 = Math.floor(Math.min(X[a], X[b]) / SEG), x1 = Math.floor(Math.max(X[a], X[b]) / SEG), z0 = Math.floor(Math.min(Z[a], Z[b]) / SEG), z1 = Math.floor(Math.max(Z[a], Z[b]) / SEG);
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const k = i + ',' + j; let l = seg.get(k); if (!l) seg.set(k, l = []); l.push(e / 3); }
    }
    function nearest(x, z) {                                    // closest point on any road within ROAD_REACH
      const ci = Math.floor(x / SEG), cj = Math.floor(z / SEG), r = Math.ceil(ROAD_REACH / SEG); let best = null;
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        const l = seg.get(i + ',' + j); if (!l) continue;
        for (const s of l) {
          const a = E[s * 3], b = E[s * 3 + 1], dx = X[b] - X[a], dz = Z[b] - Z[a], L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - X[a]) * dx + (z - Z[a]) * dz) / L2)), px = X[a] + dx * t, pz = Z[a] + dz * t, d = Math.hypot(x - px, z - pz);
          if (d <= ROAD_REACH && (!best || d < best.d)) best = { s, a, b, t, x: px, z: pz, d, cls: E[s * 3 + 2] };
        }
      }
      return best;
    }
    // shortest road path between two points; null if either is more than ROAD_REACH from a road or no road path joins them.
    // pen (optional): nodes a sibling already used; each is 50 % dearer, so a line spreads over parallel streets but never
    // takes a detour much over 1.5x the direct way (it would race to keep up). The result carries .nodes, the junctions it passes.
    function path(ax, az, bx, bz, pen) {
      const A = nearest(ax, az), B = nearest(bx, bz); if (!A || !B) return null;
      const P = [{ x: ax, z: az }, { x: A.x, z: A.z }];
      if (A.s === B.s) { P.push({ x: B.x, z: B.z }, { x: bx, z: bz }); P.nodes = []; return P; }
      const segLen = s => Math.hypot(X[E[s * 3 + 1]] - X[E[s * 3]], Z[E[s * 3 + 1]] - Z[E[s * 3]]) * ROAD_W[E[s * 3 + 2]];
      const g = new Map(), prev = new Map(), heap = [];
      const push = (i, c, p) => { if (g.has(i) && g.get(i) <= c) return; g.set(i, c); prev.set(i, p);
        heap.push([c + Math.hypot(X[i] - B.x, Z[i] - B.z), i]); let k = heap.length - 1;
        while (k) { const q = (k - 1) >> 1; if (heap[q][0] <= heap[k][0]) break; [heap[q], heap[k]] = [heap[k], heap[q]]; k = q; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0;
        for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
      const la = segLen(A.s);
      push(A.a, la * A.t, -1); push(A.b, la * (1 - A.t), -1);
      const lb = segLen(B.s), endCost = i => i === B.a ? lb * B.t : i === B.b ? lb * (1 - B.t) : null;
      let best = Infinity, bestEnd = -1, done = new Set();
      while (heap.length) {
        const [f, i] = pop(); if (f >= best) break; if (done.has(i)) continue; done.add(i);
        const gi = g.get(i), ec = endCost(i); if (ec !== null && gi + ec < best) { best = gi + ec; bestEnd = i; }
        for (let k = deg[i]; k < deg[i + 1]; k++) push(to[k], gi + w[k] * (pen && pen.has(to[k]) ? 1.5 : 1), i);
        if (done.size > 60000) break;
      }
      if (bestEnd < 0) return null;
      const mid = [], ids = []; for (let i = bestEnd; i !== -1; i = prev.get(i)) { mid.push({ x: X[i], z: Z[i] }); ids.push(i); }
      P.push(...mid.reverse(), { x: B.x, z: B.z }, { x: bx, z: bz });
      const out = P.filter((p, k) => !k || Math.hypot(p.x - P[k - 1].x, p.z - P[k - 1].z) > 0.5); out.nodes = ids; return out;
    }
    return { path, nearest, nodes: n, edges: E.length / 3, X, Z, E, WD, deg, to, eid };
  }

  const ROADS = (() => {
    const grp = new THREE.Group(); scene.add(grp); window.__roads = grp;
    const prevEx = onExCity; onExCity = () => { if (prevEx) prevEx(); grp.scale.y = ex; };
    const lin = v => Math.pow(v / 255, 2.2);
    const ASPH = [[86, 88, 92], [98, 99, 102], [116, 116, 114]].map(c => c.map(lin)), KERB = [184, 182, 174].map(lin);
    (async () => {
      let d; try { d = await load('roads.json', 'json'); } catch (e) { console.warn('roads.json not loaded:', e.message); return; }
      // trimmed edge (TRIM): cut each road where the false land begins, keeping the pieces in play
      d.r = d.r.flatMap(([wd, cls, f]) => {
        const out = []; let run = [];
        for (let i = 0; i < f.length; i += 2) {
          if (edgeAt(f[i] / 10, f[i + 1] / 10) > 0.75) { run.push(f[i], f[i + 1]); continue; }
          if (run.length >= 4) out.push([wd, cls, run]); run = [];
        }
        if (run.length >= 4) out.push([wd, cls, run]);
        return out;
      });
      const P = [], C = [], I = [], RA = [];   // RA: across (-1..1 asphalt, +-1.5 kerb), along (m), half-width (m)
      let v = 0;
      for (const [wd, cls, f] of d.r) {
        const hw = wd / 20, kerb = cls < 2 ? Math.min(0.45, hw * 0.12) : 0, lift = [0.42, 0.36, 0.3][cls];
        // densify to <= 10 m so the ribbon follows the 10 m terrain
        const pts = [];
        for (let i = 0; i < f.length - 2; i += 2) {
          const ax = f[i] / 10, az = f[i + 1] / 10, bx = f[i + 2] / 10, bz = f[i + 3] / 10, n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 10));
          for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
        }
        pts.push([f[f.length - 2] / 10, f[f.length - 1] / 10]);
        if (pts.length < 2) continue;
        const cols = kerb ? 6 : 2, start = v; let along = 0;
        for (let k = 0; k < pts.length; k++) {
          if (k) along += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
          const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
          let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
          const px = dz, pz = -dx, [x, z] = pts[k], y = heightAt(x, z);
          const ai = hw - kerb;
          const across = kerb ? [[hw, KERB, -0.04, 1.5], [ai, KERB, -0.04, 1.5], [ai, ASPH[cls], 0, 1], [-ai, ASPH[cls], 0, -1], [-ai, KERB, -0.04, -1.5], [-hw, KERB, -0.04, -1.5]]
                              : [[hw, ASPH[cls], 0, 1], [-hw, ASPH[cls], 0, -1]];
          for (const [o, c, dy, a] of across) { P.push(x + px * o, y + lift + dy, z + pz * o); C.push(c[0], c[1], c[2]); RA.push(a, along, ai); v++; }
          if (k) {
            const r0 = start + (k - 1) * cols, r1 = start + k * cols;
            const strips = kerb ? [0, 2, 4] : [0];
            for (const j of strips) I.push(r0 + j, r0 + j + 1, r1 + j, r0 + j + 1, r1 + j + 1, r1 + j);   // wound to face up
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      g.setAttribute('ra', new THREE.Float32BufferAttribute(RA, 3));
      const nrm = new Int8Array(v * 3); for (let k = 0; k < v; k++) nrm[k * 3 + 1] = 127;
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
      g.setIndex(I); g.computeBoundingSphere();
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      // worn asphalt, all procedural: grain, patch repairs, wheel paths, grime at the edges, worn dashed centre line on
      // two-lane roads; concrete grain on the kerbs. Fine detail fades out by screen-pixel size so nothing shimmers.
      mat.extensions = { derivatives: true };
      mat.onBeforeCompile = sh => {
        sh.vertexShader = 'attribute vec3 ra;\nvarying vec3 vRA;\nvarying vec2 vRW;\n' + sh.vertexShader.replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  vRA = ra; vRW = (modelMatrix * vec4(transformed, 1.0)).xz;');
        sh.fragmentShader = `varying vec3 vRA; varying vec2 vRW;
float rh21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rh21(i), rh21(i + vec2(1, 0)), f.x), mix(rh21(i + vec2(0, 1)), rh21(i + vec2(1, 1)), f.x), f.y); }
` + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  {
    float px = max(length(fwidth(vRW)), 0.01), a = abs(vRA.x), hw = max(vRA.z, 0.5);
    float fine = 1.0 - smoothstep(0.15, 0.6, px), mid = 1.0 - smoothstep(0.8, 3.0, px);
    float grain = mix(0.5, rnoise(vRW * 2.2) * 0.6 + rnoise(vRW * 6.0) * 0.4, fine);
    if (a > 1.01) {                                         // kerb: concrete
      diffuseColor.rgb *= 0.86 + 0.24 * grain;
    } else {
      float patchN = rnoise(vRW * 0.09 + 3.7), patch2 = rnoise(vRW * 0.33 + 9.1);
      float shade = 0.9 + 0.2 * grain * fine + 0.1 * (1.0 - fine);
      shade *= 0.9 + 0.2 * smoothstep(0.35, 0.8, patchN) * mid - 0.06 * smoothstep(0.6, 0.85, patch2) * mid;
      float wheel = smoothstep(0.18, 0.3, a) * (1.0 - smoothstep(0.42, 0.56, a)) * step(3.0, hw);
      shade *= 1.0 - 0.07 * wheel * mid;                                    // wheel paths
      shade *= mix(0.84, 1.0, smoothstep(0.98, 0.78, a));                   // grime by the kerb
      diffuseColor.rgb *= shade;
      float lw = 0.08 / hw, dash = step(fract(vRA.y / 9.0), 0.5);           // 0.16 m line, 4.5 m dashes
      float line = (1.0 - smoothstep(lw * 0.6, lw, a)) * dash * step(2.8, hw) * mid * (0.55 + 0.45 * rnoise(vRW * 1.3));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.5, 0.47), line * 0.75);
    }
  }`);
      };
      const mesh = new THREE.Mesh(g, mat); grp.add(mesh); grp.scale.y = ex;
      grp.visible = URBAN.on.value === 1;
      window.__roadsStat = { roads: d.r.length, verts: v, tris: I.length / 3 };
      ROADNET = buildRoadNet(d.r);
      if (onRoadNet) onRoadNet();
    })();
    return { grp };
  })();
  { const tb = document.getElementById('tg-bldg'), tt = document.getElementById('tg-trees');
    if (tb) toggle('tg-bldg', on => CITY.set('buildings', on));
    if (tt) toggle('tg-trees', on => CITY.set('trees', on));
    const rp = document.getElementById('rf-plain'), rh = document.getElementById('rf-photo');
    if (rp && rh) {
      rp.addEventListener('click', () => { rp.setAttribute('aria-pressed', 'true'); rh.setAttribute('aria-pressed', 'false'); CITY.setRoofs('plain'); });
      rh.addEventListener('click', () => { rh.setAttribute('aria-pressed', 'true'); rp.setAttribute('aria-pressed', 'false'); CITY.setRoofs('photo'); });
    } }

  // ---- observer mode: stand at a position at eye height, look around, raise the binoculars
  // Mils: 6400 to the circle. Binocular true field 7.5 deg is an assumed value for an 8x30 (not from the M30r spec).
  const MIL = 2 * Math.PI / 6400, EYE = 1.8, NAKED_FOV = 55, BINO_FIELD_DEG = 7.5;
  let obs = null, yaw = 0, pitch = 0, binos = false;
  const obsbar = document.getElementById('obsbar'), reticle = document.getElementById('reticle'), rctx = reticle.getContext('2d');
  const binoBtn = document.getElementById('bino');
  function setEx1() { if (ex !== 1) { ex = 1; exBtns.forEach((o, j) => o.setAttribute('aria-pressed', String(j === 0))); rebuild(); } }
  function applyLook() {
    const d = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    camera.lookAt(camera.position.clone().add(d));
  }
  function setFov() {
    // binoculars: the circular field fills 92% of the screen height
    camera.fov = binos ? BINO_FIELD_DEG / 0.92 : NAKED_FOV;
    camera.near = 0.5; camera.updateProjectionMatrix();
    reticle.hidden = !binos; binoBtn.setAttribute('aria-pressed', String(binos));
    labelBox.hidden = binos || !(showLabels && groups.sketch.visible);
    drawReticle();
  }
  function enterObserver(o) {
    setEx1();
    const p = toLocal(o.e, o.n);
    obs = o; controls.enabled = false;
    camera.position.set(p.x, standAt(p.x, p.z) + EYE, p.z);   // on the roof when the position is in a building
    // face the centre of the battlespace to start, level
    const c = SKETCH.border.reduce((a, q) => [a[0] + q[0] / SKETCH.border.length, a[1] + q[1] / SKETCH.border.length], [0, 0]);
    const cl = toLocal(c[0], c[1]);
    yaw = Math.atan2(cl.x - p.x, -(cl.z - p.z)); pitch = -0.02;
    binos = false; setFov(); applyLook();
    document.getElementById('obswhere').textContent = o.name;
    obsbar.hidden = false; document.getElementById('rngbox').hidden = false; document.getElementById('dirbox').hidden = false;
    // daylight sky and haze while standing; the map panel and the sketch step aside
    scene.fog.near = 3000; scene.fog.far = 28000;
    if (window.__wins) window.__wins.observer(true); groups.sketch.visible = false; groups.grid.visible = false; ovl.setAttribute('aria-pressed', 'false');
    labelBox.hidden = true;
  }
  function leaveObserver() {
    obs = null; binos = false; controls.enabled = true;
    scene.fog.near = 12000; scene.fog.far = 55000;
    if (window.__wins) window.__wins.observer(false);
    groups.sketch.visible = document.getElementById('tg-sketch').getAttribute('aria-pressed') === 'true';
    groups.grid.visible = document.getElementById('tg-grid').getAttribute('aria-pressed') === 'true';
    camera.fov = 45; camera.near = 10; camera.updateProjectionMatrix();
    reticle.hidden = true; obsbar.hidden = true; labelBox.hidden = !(showLabels && groups.sketch.visible);
    document.getElementById('rngbox').hidden = true; document.getElementById('dirbox').hidden = true;
    home();
  }
  binoBtn.addEventListener('click', () => { if (obs) { binos = !binos; setFov(); } });
  const ovl = document.getElementById('ovl');
  ovl.addEventListener('click', () => {
    const on = ovl.getAttribute('aria-pressed') !== 'true'; ovl.setAttribute('aria-pressed', String(on));
    groups.sketch.visible = on; labelBox.hidden = binos || !(on && showLabels);
  });
  document.getElementById('obsexit').addEventListener('click', leaveObserver);
  addEventListener('keydown', e => {
    if (!obs) return;
    const step = (binos ? 0.004 : 0.04);
    if (e.key === 'b' || e.key === 'B') { binos = !binos; setFov(); }
    else if (e.key === 'Escape') leaveObserver();
    else if (e.key === 'ArrowLeft') { yaw -= step; applyLook(); }
    else if (e.key === 'ArrowRight') { yaw += step; applyLook(); }
    else if (e.key === 'ArrowUp') { pitch = Math.min(1.3, pitch + step); applyLook(); }
    else if (e.key === 'ArrowDown') { pitch = Math.max(-1.3, pitch - step); applyLook(); }
    else return;
    e.preventDefault();
  });
  let drag = null;
  canvas.addEventListener('pointerdown', e => { if (obs) { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); } });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointermove', e => {
    if (!obs || !drag) return;
    // one screen height of drag turns the view by one field of view, so binoculars pan finely
    const k = THREE.MathUtils.degToRad(camera.fov) / canvas.clientHeight;
    yaw -= (e.clientX - drag.x) * k; pitch = Math.max(-1.3, Math.min(1.3, pitch + (e.clientY - drag.y) * k));
    drag = { x: e.clientX, y: e.clientY }; applyLook();
  });
  function drawReticle() {
    if (reticle.hidden) return;
    const dpr = Math.min(devicePixelRatio, 2), w = reticle.clientWidth, h = reticle.clientHeight;
    reticle.width = w * dpr; reticle.height = h * dpr; rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = w / 2, cy = h / 2, f = (h / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const px = m => f * Math.tan(m * MIL);                 // mils off the centre -> pixels, true angular scale
    const R = f * Math.tan(THREE.MathUtils.degToRad(BINO_FIELD_DEG) / 2);
    // black outside the circular field
    rctx.fillStyle = '#000'; rctx.beginPath(); rctx.rect(0, 0, w, h); rctx.arc(cx, cy, R, 0, Math.PI * 2, true); rctx.fill('evenodd');
    rctx.strokeStyle = '#000'; rctx.lineWidth = 3; rctx.beginPath(); rctx.arc(cx, cy, R, 0, Math.PI * 2); rctx.stroke();
    // the Steiner M30r scale: horizontal +/-50, vertical +70/-50, labels every 10, ticks every 5
    rctx.strokeStyle = 'rgba(10,10,10,.9)'; rctx.fillStyle = 'rgba(10,10,10,.95)'; rctx.lineWidth = 1.6;
    rctx.font = '600 12px "IBM Plex Mono", monospace'; rctx.textAlign = 'center'; rctx.textBaseline = 'middle';
    const L = 7, S = 4;
    rctx.beginPath(); rctx.moveTo(cx - px(50), cy); rctx.lineTo(cx + px(50), cy); rctx.moveTo(cx, cy - px(70)); rctx.lineTo(cx, cy + px(50)); rctx.stroke();
    for (let m = -50; m <= 50; m += 5) {
      if (m === 0) continue;
      const x = cx + px(m), big = m % 10 === 0;
      rctx.beginPath(); rctx.moveTo(x, cy - (big ? L : S)); rctx.lineTo(x, cy + (big ? L : S)); rctx.stroke();
      if (big) rctx.fillText(String(Math.abs(m)), x, cy + 18);
    }
    for (let m = -50; m <= 70; m += 5) {
      if (m === 0) continue;
      const y = cy - px(m), big = m % 10 === 0;
      rctx.beginPath(); rctx.moveTo(cx - (big ? L : S), y); rctx.lineTo(cx + (big ? L : S), y); rctx.stroke();
      if (big) rctx.fillText(String(Math.abs(m)), cx - 22, y);
    }
  }
  addEventListener('resize', drawReticle);
  const rngEl = document.getElementById('rng'), dirEl = document.getElementById('dir');
  function obsReadout(p) {
    if (!obs || !p) { rngEl.textContent = '—'; dirEl.textContent = '—'; return; }
    const dx = p.x - camera.position.x, dz = p.z - camera.position.z;
    rngEl.textContent = Math.round(Math.hypot(dx, dz)) + ' m';
    let az = Math.atan2(dx, -dz); if (az < 0) az += 2 * Math.PI;
    dirEl.textContent = String(Math.round(az / MIL) % 6400).padStart(4, '0') + ' mils grid';
  }

  // ---- hover readout: march the mouse ray against the height grid
  const gEl = document.getElementById('g'), hEl = document.getElementById('h');
  const ray = new THREE.Raycaster(), m = new THREE.Vector2();
  function pick(px, py) {
    const r = canvas.getBoundingClientRect();
    m.set(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(m, camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    // the click lands on what you see: a roof or wall if buildings are shown, else the ground
    const surf = (x, z) => { const g = heightAt(x, z), r = typeof CITY !== 'undefined' ? CITY.roofAt(x, z) : null; return (r !== null && r > g ? r : g) * ex; };
    let prev = 0;
    for (let t = 0; t < 70000; t += 8) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (!inPlay(x, z)) { prev = t; continue; }
      if (y <= surf(x, z)) {
        let lo = prev, hi = t;
        for (let k = 0; k < 20; k++) { const mid = (lo + hi) / 2; if (o.y + d.y * mid <= surf(o.x + d.x * mid, o.z + d.z * mid)) hi = mid; else lo = mid; }
        return { x: o.x + d.x * hi, z: o.z + d.z * hi };
      }
      prev = t;
    }
    return null;
  }
  const pad = v => String(Math.round(v)).padStart(5, '0');
  canvas.addEventListener('pointermove', e => {
    const p = pick(e.clientX, e.clientY);
    obsReadout(p);
    if (!p) { gEl.textContent = '—'; hEl.textContent = '—'; return; }
    const E = CE + p.x, N = CN - p.z;
    gEl.textContent = '4Q FJ ' + pad(E - 600000) + ' ' + pad(N - 2300000);
    const c = Math.max(0, Math.min(NX - 1, Math.round((p.x + HW) / CELL - 0.5))), rr = Math.max(0, Math.min(NY - 1, Math.round((p.z + HH) / CELL - 0.5)));
    hEl.textContent = Math.abs(p.x) > HW || Math.abs(p.z) > HH ? 'open sea' : dm[rr * NX + c] < 0 ? 'sea (no data)' : heightAt(p.x, p.z).toFixed(0) + ' m';
  });

  // ---- controls
  const exBtns = [1, 2, 3].map(n => document.getElementById('ex' + n));
  exBtns.forEach((b, k) => b.addEventListener('click', () => { ex = k + 1; exBtns.forEach((o, j) => o.setAttribute('aria-pressed', String(j === k))); rebuild(); }));
  function toggle(id, fn) { const b = document.getElementById(id); b.addEventListener('click', () => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); fn(on); }); }
  const gh = document.getElementById('gr-hybrid'), gp = document.getElementById('gr-photo'), gr = document.getElementById('gr-relief');
  function groundMode(m) {
    ground.material = m === 'relief' ? reliefMat : photoMat; URBAN.on.value = m === 'hybrid' ? 1 : 0;
    if (window.__roads) window.__roads.visible = m === 'hybrid';
    for (const [b, k] of [[gh, 'hybrid'], [gp, 'photo'], [gr, 'relief']]) if (b) b.setAttribute('aria-pressed', String(k === m));
  }
  if (gh) gh.addEventListener('click', () => groundMode('hybrid'));
  gp.addEventListener('click', () => groundMode('photo'));
  gr.addEventListener('click', () => groundMode('relief'));
  toggle('tg-grid', on => { groups.grid.visible = on; });
  toggle('tg-enemy', on => { if (window.__opfor) window.__opfor.showEnemy = on; });
  toggle('tg-eroutes', on => { if (window.__opfor) window.__opfor.showRoutes = on; });
  let friendlyOn = true;                // Display → Friendly: every friendly position — OPs, cameras, firing units, UAS launch points
  toggle('tg-sketch', on => { friendlyOn = on; groups.sketch.visible = on; labelBox.hidden = !(on && showLabels); if (window.__fires) window.__fires.unitGroup.visible = on; });
  toggle('tg-labels', on => { showLabels = on; labelBox.hidden = !(on && groups.sketch.visible); });

  // ---- FIRES: instructor firing units, point-and-shoot, bursts and arcs, on one sim clock.
  // Everything that decides an outcome reads sim time and a per-mission seed, so a run can be replayed.
  // The working scenario in this browser. A scenario file is these saved together; loading one writes them and reloads the page.
  const STORE = { opfor: 'fist-trainer-opfor-v2', units: 'fist-trainer-units-v1', lps: 'fist-trainer-lps-v1', name: 'fist-trainer-scenario-name-v1' };

  const FIRES = (() => {
    // Placeholder figures, all in one place. Replace with real values when supplied.
    const TYPES = {
      m777: { label: 'M777 155 mm battery', short: 'M777', tubes: 6, min: 2500, max: 22000, angle: 'low',
              interval: 15, sheaf: 100, sR: R => 10 + 0.0035 * R, sD: R => 5 + 0.0015 * R, burst: 1.0 },
      m119: { label: 'M119 105 mm battery', short: 'M119', tubes: 6, min: 1500, max: 11500, angle: 'low',
              interval: 10, sheaf: 80, sR: R => 8 + 0.004 * R, sD: R => 4 + 0.002 * R, burst: 0.75 },
      m120: { label: '120 mm mortar section', short: '120mm', tubes: 4, min: 200, max: 7200, angle: 'high',
              interval: 8, sheaf: 60, sR: R => 10 + 0.008 * R, sD: R => 6 + 0.004 * R, burst: 0.8 },
      m252: { label: '81 mm mortar section', short: '81mm', tubes: 4, min: 80, max: 5600, angle: 'high',
              interval: 5, sheaf: 40, sR: R => 8 + 0.01 * R, sD: R => 5 + 0.005 * R, burst: 0.55 }
    };
    let simT = 0, speed = 1, nextId = 1, mapMode = false, arcsOn = true;
    const units = [], missions = [], fx = [], impactFns = [];   // impactFns: damage listens here (registered by DAMAGE)
    const $ = id => document.getElementById(id);
    const fmt = t => { const s = Math.max(0, Math.floor(t)); return 'T+' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
    const gridTxt = (e, n) => { const g = toGrid(e, n); return g ? g : Math.round(e) + 'E ' + Math.round(n) + 'N'; };

    // ---- grids: MGRS in zone 4Q (this battlespace). Squares follow the zone-4 lettering.
    const COLS = 'ABCDEFGH', ROWS = 'ABCDEFGHJKLMNPQRSTUV';
    function toGrid(e, n) {
      const ci = Math.floor(e / 100000) - 1, ri = (Math.floor((n % 2000000) / 100000) + 5) % 20;
      if (ci < 0 || ci > 7) return null;
      return '4Q ' + COLS[ci] + ROWS[ri] + ' ' + String(Math.floor(e % 100000)).padStart(5, '0') + ' ' + String(Math.floor(n % 100000)).padStart(5, '0');
    }
    function parseGrid(str) {
      let s = String(str || '').toUpperCase().replace(/\s+/g, '');
      s = s.replace(/^0?4Q/, '');
      let sq = 'FJ';
      const m = s.match(/^([A-H])([A-HJ-NP-V])(\d+)$/);
      if (m) { sq = m[1] + m[2]; s = m[3]; }
      if (!/^\d+$/.test(s) || s.length % 2 || s.length < 6 || s.length > 10) return { err: 'Grid needs 6, 8 or 10 digits, e.g. 4Q FJ 21500 55200.' };
      const k = s.length / 2, mul = Math.pow(10, 5 - k);
      const e0 = (COLS.indexOf(sq[0]) + 1) * 100000, n0 = 2000000 + ((ROWS.indexOf(sq[1]) - 5 + 20) % 20) * 100000;
      // centre of the grid square named by the precision given
      return { e: e0 + Number(s.slice(0, k)) * mul + mul / 2 * (k < 5 ? 1 : 0), n: n0 + Number(s.slice(k)) * mul + mul / 2 * (k < 5 ? 1 : 0) };
    }
    const onMap = (e, n) => { const p = toLocal(e, n); return Math.abs(p.x) <= HW && Math.abs(p.z) <= HH; };
    const groundAt = (e, n) => { const p = toLocal(e, n); return heightAt(p.x, p.z); };

    // ---- deterministic randomness per mission
    function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

    // ---- unit symbols: friendly frame with a filled dot (artillery) or a dot under a chevron (mortar). Not checked against APP-6.
    function symbolTexture(t, name) {
      const c = document.createElement('canvas'); c.width = 384; c.height = 128; const g = c.getContext('2d');   // frame ~25 px on screen
      g.fillStyle = SYM_FILL; g.strokeStyle = SYM_EDGE; g.lineWidth = 5;
      g.fillRect(155, 10, 74, 50); g.strokeRect(155, 10, 74, 50);
      g.fillStyle = SYM_EDGE; g.beginPath(); g.arc(192, 37, 8, 0, Math.PI * 2); g.fill();
      if (t.angle === 'high') { g.lineWidth = 4; g.beginPath(); g.moveTo(192, 16); g.lineTo(192, 29); g.stroke(); g.beginPath(); g.moveTo(184, 23); g.lineTo(192, 15); g.lineTo(200, 23); g.stroke(); }
      symLabel(g, name, 192, 104, 370);
      const tx = new THREE.CanvasTexture(c); tx.encoding = THREE.sRGBEncoding; return tx;
    }
    const unitGroup = new THREE.Group(), fxGroup = new THREE.Group(), arcGroup = new THREE.Group();
    scene.add(unitGroup, fxGroup, arcGroup);
    function placeSprite(u) {
      const onm = onMap(u.e, u.n);
      let p = toLocal(u.e, u.n), y = (onm ? heightAt(p.x, p.z) * ex : 0) + 60;
      if (!onm) { const k = Math.min(HW / Math.abs(p.x || 1e-9), HH / Math.abs(p.z || 1e-9)) * 0.985; p = { x: p.x * k, z: p.z * k }; }
      u.sprite.position.set(p.x, y, p.z);
    }
    // name on the map: callsign then type ("Steel Rain M777"); no callsign keeps the old "M777 A"
    function addUnit(type, e, n, alt, cs) {
      const t = TYPES[type], count = units.filter(u => u.type === type).length + 1;
      cs = String(cs || '').trim();
      const name = cs ? cs + ' ' + t.short : t.short + ' ' + 'ABCDEFGHJKLMNPQRSTUVWXYZ'[(count - 1) % 24];
      const u = { id: nextId++, type, name, cs, e, n, alt: onMap(e, n) ? null : (alt || 0) };
      u.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: symbolTexture(t, name), depthTest: false, transparent: true }));
      u.sprite.scale.set(384 * SYM_K, 128 * SYM_K, 1); u.sprite.material.sizeAttenuation = false; u.sprite.renderOrder = 10;
      unitGroup.add(u.sprite); placeSprite(u); units.push(u);
      log('Placed ' + name + ' at ' + gridTxt(e, n) + (onMap(e, n) ? '' : ' (off map)'));
      drawUnits(); return u;
    }
    function gunPos(u) {                     // world position of the guns, used for arcs and range
      const p = toLocal(u.e, u.n); const g = onMap(u.e, u.n) ? heightAt(p.x, p.z) : (u.alt || 0);
      return new THREE.Vector3(p.x, g * ex + 3, p.z);
    }

    // ---- UI: units
    let placing = null, moving = null, picking = false;
    const placeMsg = $('place-msg'), fmMsg = $('fm-msg');
    function msg(el, text, cls) { el.textContent = text; el.className = 'msg' + (cls ? ' ' + cls : ''); }
    // Position firing units (Lee, 2026-11-11): one dropdown, cannon artillery or a one-way attack UAS launch point.
    // A UAS choice places a launch point in the UAS module (launched from the UAS panel). Values: gun type key, or 'uas:<family>'.
    const OWA = { altius: 'Altius launch point', switchblade: 'Switchblade launch point', lucas: 'LUCAS launch point' };
    const UAS_SHORT = { altius: 'Altius', switchblade: 'Switchblade', lucas: 'LUCAS' };
    { const s = $('place-type'), grp = (label, items) => { const og = document.createElement('optgroup'); og.label = label;
        for (const [v, t] of items) { const o = document.createElement('option'); o.value = v; o.textContent = t; og.appendChild(o); } s.appendChild(og); };
      grp('Cannon artillery', Object.entries(TYPES).map(([k, t]) => [k, t.label]));
      grp('One-way attack UAS', Object.entries(OWA).map(([k, t]) => ['uas:' + k, t])); }
    function placeAt(kind, e, n, alt) {      // returns an error string, or '' when placed
      const cs = $('place-cs').value.trim();
      if (kind.startsWith('uas:')) {
        const fam = kind.slice(4), p = toLocal(e, n);
        if (!onMap(e, n) && fam !== 'lucas') return 'Altius and Switchblade launch points must be on the map.';
        const lp = UAS.debug.addLP(fam, p.x, p.z, cs ? cs + ' ' + UAS_SHORT[fam] : undefined);
        msg(placeMsg, 'Placed ' + lp.name + '. Launch it from the UAS panel.'); return '';
      }
      const u = addUnit(kind, e, n, alt, cs); msg(placeMsg, 'Placed ' + u.name + '.'); return '';
    }
    function armPlace() {
      const k = $('place-type').value, label = k.startsWith('uas:') ? OWA[k.slice(4)] : TYPES[k].label;
      placing = k; moving = null; picking = false; msg(placeMsg, 'Click the map to place the ' + label + '. Esc cancels.', 'arm');
    }
    $('place-click').addEventListener('click', armPlace);
    $('place-go').addEventListener('click', () => {
      const g = parseGrid($('place-grid').value); if (g.err) return msg(placeMsg, g.err, 'bad');
      if (moving) { moveUnit(moving, g.e, g.n, Number($('place-alt').value) || 0); return; }
      placing = null; const err = placeAt($('place-type').value, g.e, g.n, Number($('place-alt').value) || 0); if (err) msg(placeMsg, err, 'bad');
    });
    let UL = null;                           // the UAS module's launch points, linked once UAS starts (it is built after FIRES)
    function moveUnit(u, e, n, alt) {
      if (u.lp) { const p = toLocal(e, n), err = UL.moveLP(u.lp, p.x, p.z); moving = null; return msg(placeMsg, err || 'Moved ' + u.lp.name + '.', err ? 'bad' : ''); }
      u.e = e; u.n = n; u.alt = onMap(e, n) ? null : (alt || 0); placeSprite(u); moving = null;
      log('Moved ' + u.name + ' to ' + gridTxt(e, n) + (onMap(e, n) ? '' : ' (off map)')); msg(placeMsg, 'Moved.'); drawUnits();
    }
    const unitList = () => units.map(u => ({ type: u.type, cs: u.cs || undefined, e: Math.round(u.e), n: Math.round(u.n), alt: u.alt }));
    // room: a student's firing units follow the host's list (friendly positions on the map)
    function setUnits(list) {
      for (const u of units) unitGroup.remove(u.sprite); units.length = 0;
      for (const u of list || []) if (TYPES[u.type]) addUnit(u.type, u.e, u.n, u.alt, u.cs);
    }
    function drawUnits() {
      if (!NOSAVE) try { localStorage.setItem(STORE.units, JSON.stringify(unitList())); } catch (e) {}
      const L = $('ulist'); L.textContent = '';
      for (const u of units) {
        const row = document.createElement('div'); row.className = 'urow';
        const nm = document.createElement('span'); nm.className = 'un'; nm.textContent = u.name;
        const gr = document.createElement('span'); gr.className = 'ug'; gr.textContent = gridTxt(u.e, u.n) + (onMap(u.e, u.n) ? '' : '  off map'); nm.appendChild(gr);
        const mv = document.createElement('button'); mv.textContent = 'Move'; mv.addEventListener('click', () => { moving = u; placing = null; msg(placeMsg, 'Click the map, or type a grid and press Place, to move ' + u.name + '.', 'arm'); });
        const rm = document.createElement('button'); rm.textContent = 'Remove'; rm.addEventListener('click', () => { unitGroup.remove(u.sprite); units.splice(units.indexOf(u), 1); log('Removed ' + u.name); drawUnits(); });
        row.append(nm, mv, rm); L.appendChild(row);
      }
      if (UL) for (const lp of UL.lps) {          // UAS launch points: same list, moved and removed through the UAS module
        const row = document.createElement('div'); row.className = 'urow';
        const nm = document.createElement('span'); nm.className = 'un'; nm.textContent = lp.name;
        const gr = document.createElement('span'); gr.className = 'ug'; const E = CE + lp.x, N = CN - lp.z;
        gr.textContent = 'Launch point · ' + gridTxt(E, N) + (onMap(E, N) ? '' : '  off map'); nm.appendChild(gr);
        const mv = document.createElement('button'); mv.textContent = 'Move'; mv.addEventListener('click', () => { moving = { lp }; placing = null; picking = false; msg(placeMsg, 'Click the map, or type a grid and press Place, to move ' + lp.name + '.', 'arm'); });
        row.append(nm, mv, UL.lpRemoveBtn(lp, (t, c) => msg(placeMsg, t, c))); L.appendChild(row);
      }
      const sel = $('fm-unit'), keep = sel.value; sel.textContent = '';
      if (!units.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'Place a unit first'; sel.appendChild(o); }
      for (const u of units) { const o = document.createElement('option'); o.value = String(u.id); o.textContent = u.name; sel.appendChild(o); }
      if (units.some(u => String(u.id) === keep)) sel.value = keep;
      if (typeof syncAngle === 'function') syncAngle();
      if (typeof syncCff === 'function') syncCff();
    }

    // ---- BALLISTICS (Lee, 2026-11-02): a point-mass shell with gravity and quadratic drag (a = −k|v|v), constant air
    //      density, stepped at 0.05 s. Notional, not firing tables: top muzzle velocity per weapon is a public round figure,
    //      charges are fractions of it, and k was fitted (once, offline) so the top charge's maximum range = the unit's
    //      max range. Every value here is a placeholder. The path drives the drawn arc, the shells, time of flight and masking.
    const BAL = (() => {
      const G = 9.81, DT = 0.05, MIL = 6400 / (2 * Math.PI);
      const W = {                      // v: top muzzle velocity m/s; ch: charges as fractions of v; k: fitted drag constant
        m777: { v: 827, ch: [0.35, 0.5, 0.65, 0.8, 1],        k: 5.362e-5 },
        m119: { v: 494, ch: [0.35, 0.5, 0.65, 0.8, 1],        k: 7.284e-5 },
        m120: { v: 318, ch: [0.2, 0.35, 0.5, 0.7, 0.85, 1],   k: 5.849e-5 },
        m252: { v: 264, ch: [0.15, 0.3, 0.45, 0.6, 0.8, 1],   k: 5.117e-5 }
      };
      const LOW_MAX = 600, HIGH_BEST = 1150, HIGH_MIN = 800, HIGH_MAX = 1350;   // charge choice, mils
      function fly(v, th, k, dh, keep) {   // until the shell comes down through height dh (target minus gun); x along the line, y up, t s
        let x = 0, y = 0, vx = v * Math.cos(th), vy = v * Math.sin(th), t = 0; const pts = keep ? [{ x: 0, y: 0, t: 0 }] : null;
        for (let i = 0; i < 20000; i++) {
          const s = Math.hypot(vx, vy), nvx = vx - k * s * vx * DT, nvy = vy + (-G - k * s * vy) * DT;
          const nx = x + (vx + nvx) / 2 * DT, ny = y + (vy + nvy) / 2 * DT;
          if (nvy < 0 && ny <= dh) { const f = (y - dh) / ((y - ny) || 1); x += (nx - x) * f; t += DT * f; if (keep) pts.push({ x, y: dh, t }); return { R: x, tof: t, pts }; }
          x = nx; y = ny; vx = nvx; vy = nvy; t += DT; if (keep) pts.push({ x, y, t });
        }
        return { R: x, tof: t, pts };
      }
      const maxCache = new Map();
      function maxR(v, k, dh) {
        const key = v + '|' + Math.round(dh / 20); if (maxCache.has(key)) return maxCache.get(key);
        let a = 0.2, b = 1.2; for (let i = 0; i < 30; i++) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3; if (fly(v, m1, k, dh).R < fly(v, m2, k, dh).R) a = m1; else b = m2; }
        const th = (a + b) / 2, r = { th, R: fly(v, th, k, dh).R }; maxCache.set(key, r); return r;
      }
      function solveCharge(v, k, R, dh, high) {
        const m = maxR(v, k, dh); if (m.R < R) return null;
        let a = high ? m.th : 0.005, b = high ? 1.48 : m.th;
        if (high && fly(v, b, k, dh).R > R) return null;          // too close for this charge at high angle
        for (let i = 0; i < 36; i++) { const c = (a + b) / 2, r = fly(v, c, k, dh).R; if ((r < R) !== high) a = c; else b = c; }
        const th = (a + b) / 2; return { th, qe: th * MIL, ...fly(v, th, k, dh, true) };
      }
      // the FDC's pick: low angle = lowest charge that reaches below LOW_MAX mils (else the lowest that reaches);
      // high angle = the charge whose QE is closest to HIGH_BEST within HIGH_MIN..HIGH_MAX (else any high-angle solution)
      function solve(type, R, dh, high) {
        const w = W[type], sols = w.ch.map((c, i) => { const s = solveCharge(w.v * c, w.k, R, dh, high); return s && Object.assign(s, { ch: i + 1, v: w.v * c }); }).filter(Boolean);
        if (!sols.length) return { err: high ? 'No charge reaches at high angle' : 'No charge reaches' };
        let s;
        if (!high) s = sols.find(o => o.qe <= LOW_MAX) || sols[0];
        else { const band = sols.filter(o => o.qe >= HIGH_MIN && o.qe <= HIGH_MAX); s = (band.length ? band : sols).reduce((a, o) => Math.abs(o.qe - HIGH_BEST) < Math.abs(a.qe - HIGH_BEST) ? o : a); }
        s.high = high; return s;
      }
      return { solve, W, MIL, LOW_MAX, HIGH_BEST, HIGH_MIN, HIGH_MAX, fly };
    })();
    // walk one round's path (the mission path stretched to the round's own range and bearing): the first building or
    // terrain crest below it is where it bursts. Off-map stretches are not checked; the first 30 m from the guns are skipped.
    const MASK_TOP = 1200;             // only test where the shell is below this height (m) — buildings and hills are lower
    function maskRound(sol, G, gH, ux, uz, Rr) {
      const P = sol.pts, sc = Rr / (sol.R || 1);
      for (let i = 1; i < P.length; i++) {
        const a = P[i - 1], b = P[i]; if (Math.min(a.y, b.y) + gH > MASK_TOP) continue;
        const L = (b.x - a.x) * sc, n = Math.max(1, Math.ceil(L / 5));
        for (let j = 1; j <= n; j++) {
          const f = j / n, x = (a.x + (b.x - a.x) * f) * sc; if (x < 30 || x > Rr - 1) continue;
          const px = G.x + ux * x, pz = G.z + uz * x; if (Math.abs(px) > HW || Math.abs(pz) > HH) continue;
          const h = gH + a.y + (b.y - a.y) * f, gr = heightAt(px, pz), roof = CITY.roofAt(px, pz, true);
          if (roof !== null && h < roof) { const y = h > roof - 6 ? roof : h; return { x: px, z: pz, y, t: a.t + (b.t - a.t) * f, what: 'building', above: y - gr }; }   // through the roof: burst on it
          if (h < gr - 0.5) return { x: px, z: pz, y: gr, t: a.t + (b.t - a.t) * f, what: 'terrain', above: 0 };
        }
      }
      return null;
    }
    // ---- CALL FOR FIRE (Lee, 2026-11-11): the Fire Mission Sim's call for fire (js/sim-missions.js).
    //      TYPE OF MISSION sets how many tubes fire, how many rounds each and how far apart: the sim's table, sized to the
    //      unit ('all' = every tube, 'half' = half rounded up, the sim's 3 of 6). Fire for effect keeps the rounds-per-tube
    //      choice (no ammunition limit, Lee 2026-11-02). iv null = the unit's own interval.
    //      METHOD OF CONTROL says only WHEN the guns fire; the flight is the same once they do. When ready: on Send.
    //      At my command: laid and held until the instructor presses FIRE. Time on target: fired at TOT − time of flight,
    //      so the first rounds land at the TOT (sim clock); a TOT inside the time of flight is refused, with the earliest.
    //      A held mission is solved again when it fires, so a unit moved meanwhile shoots from where it is now, and one
    //      removed or out of range cancels with a log line. No acknowledgement delay: the instructor is the FDC.
    const MTYPES = {
      ffe:  { label: 'Fire for effect',       tubes: 'all',  per: null, iv: null },
      isup: { label: 'Immediate suppression', tubes: 'all',  per: 1,    iv: null },
      adj:  { label: 'Adjust fire',           tubes: 'half', per: 1,    iv: null },
      sup:  { label: 'Suppression',           tubes: 1,      per: 18,   iv: 7 }
    };
    const CTL = { ready: 'when ready', amc: 'at my command', tot: 'time on target' };
    for (const [k, v] of Object.entries(MTYPES)) { const o = document.createElement('option'); o.value = k; o.textContent = v.label; $('fm-type').appendChild(o); }
    function shapeOf(t, mt, rds) {
      const M = MTYPES[mt] || MTYPES.ffe;
      return { n: M.tubes === 'all' ? t.tubes : M.tubes === 'half' ? Math.ceil(t.tubes / 2) : M.tubes, per: M.per || rds, iv: M.iv || t.interval };
    }
    const held = [];                        // laid missions waiting: { id, spec, ctl, tot, fireAt (null = at my command) }
    let nextMid = 1;
    function plan(s) {                      // s: { uid, e, n, mt, rds, angle } → the solved mission, or { err }
      const u = units.find(x => x.id === s.uid); if (!u) return { err: 'Firing unit removed' };
      const g = { e: s.e, n: s.n }, t = TYPES[u.type], R = Math.hypot(g.e - u.e, g.n - u.n);
      if (R > t.max) return { err: `Out of range: ${(R / 1000).toFixed(1)} km, ${t.short} max ${(t.max / 1000).toFixed(1)} km.` };
      if (R < t.min) return { err: `Inside minimum range: ${Math.round(R)} m, ${t.short} min ${t.min} m.` };
      const high = t.angle === 'high' || s.angle === 'high';
      const G = toLocal(u.e, u.n), gH = onMap(u.e, u.n) ? heightAt(G.x, G.z) : (u.alt || 0), tl = toLocal(g.e, g.n), tH = heightAt(tl.x, tl.z);
      const sol = BAL.solve(u.type, R, tH - gH, high);
      if (sol.err) return { err: `${sol.err}: ${(R / 1000).toFixed(1)} km${high && t.angle !== 'high' ? '. Try Low.' : '.'}` };
      return { u, t, g, R, high, G, gH, sol, tof: sol.tof, sh: shapeOf(t, s.mt, s.rds), mt: s.mt };
    }
    function launch(id, p, t0) {            // the guns fire at t0
      const { u, t, g, R, G, gH, sol, tof, sh, high } = p, r = rng(id * 2654435761 + u.id * 97);
      const ux = (g.e - u.e) / R, uy = (g.n - u.n) / R;       // gun-target line, east/north components
      const impacts = [], volEnd = [];
      for (let k = 0; k < sh.per; k++) for (let j = 0; j < sh.n; j++) {
        const lat = sh.n > 1 ? (j / (sh.n - 1) - 0.5) * t.sheaf * (sh.n - 1) / (t.tubes - 1) : 0;  // parallel sheaf across the gun-target line
        const dr = gauss(r) * t.sR(R), dd = gauss(r) * t.sD(R) + lat;
        const e = g.e + ux * dr - uy * dd, n = g.n + uy * dr + ux * dd, fired = t0 + k * sh.iv + r() * 1.5;
        const Rr = Math.hypot(e - u.e, n - u.n), hit = maskRound(sol, G, gH, (e - u.e) / Rr, -(n - u.n) / Rr, Rr);
        const imp = hit ? { t: fired + hit.t, e: CE + hit.x, n: CN - hit.z, y: hit.y, what: hit.what, above: hit.above, done: false }
                        : { t: fired + tof, e, n, done: false };
        impacts.push(imp); volEnd[k] = Math.max(volEnd[k] || 0, imp.t);
      }
      const m = { id, u, t, g, R, tof, per: sh.per, iv: sh.iv, t0, impacts, splash: false, endT: Math.max(...impacts.map(i => i.t)), arc: null, shells: [], sol, G, gH, volEnd };
      missions.push(m); buildArc(m);
      const masked = impacts.filter(i => i.what).length;
      log(`M${id} ${u.name} → ${gridTxt(g.e, g.n)}, ${sh.per} rd × ${sh.n}, range ${(R / 1000).toFixed(1)} km, ${high ? 'HIGH' : 'LOW'} ch ${sol.ch} QE ${Math.round(sol.qe)} mils, ToF ${Math.round(tof)} s — SHOT`);
      msg(fmMsg, `Mission ${id} away (${high ? 'high' : 'low'} angle, charge ${sol.ch}, QE ${Math.round(sol.qe)} mils). Splash in ${Math.round(tof + t0 - simT)} s.` + (masked ? ` ${masked} of ${impacts.length} rounds will hit a building or crest first.` : ''));
    }
    function parseTot(v) {                  // "T+05:30" or "5:30" (sim clock, minutes may pass 59) → seconds, or null
      const m = /^\s*(?:T\s*\+\s*)?(\d{1,4}):([0-5]\d)\s*$/i.exec(v || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    }
    $('fm-pick').addEventListener('click', () => { picking = true; placing = null; moving = null; msg(fmMsg, 'Click the target on the map. Esc cancels.', 'arm'); });
    $('fm-fire').addEventListener('click', send);
    function send() {
      const u = units.find(x => String(x.id) === $('fm-unit').value);
      if (!u) return msg(fmMsg, 'Place a firing unit first.', 'bad');
      const g = parseGrid($('fm-grid').value); if (g.err) return msg(fmMsg, g.err, 'bad');
      { const q = toLocal(g.e, g.n); if (!inPlay(q.x, q.z)) return msg(fmMsg, 'That target is off the map.', 'bad'); }
      const spec = { uid: u.id, e: g.e, n: g.n, mt: $('fm-type').value, rds: Number($('fm-rds').value), angle };
      const p = plan(spec); if (p.err) return msg(fmMsg, p.err, 'bad');
      const ctl = $('fm-control').value; let tot = null;
      if (ctl === 'tot') {
        tot = parseTot($('fm-tot').value);
        if (tot === null) return msg(fmMsg, 'Time on target needs a sim clock time, as T+MM:SS.', 'bad');
        if (tot - p.tof < simT) return msg(fmMsg, `Unable: time of flight ${Math.round(p.tof)} s. Earliest TOT is ${fmt(Math.ceil(simT + p.tof + 1))}.`, 'bad');
      }
      const id = nextMid++;
      log(`M${id} CFF ${u.name}: ${MTYPES[spec.mt].label.toLowerCase()}, grid ${gridTxt(g.e, g.n)}, ${p.sh.per} rd × ${p.sh.n}, ${CTL[ctl]}${tot !== null ? ' ' + fmt(tot) : ''}`);
      if (ctl === 'ready') return launch(id, p, simT);
      held.push({ id, spec, ctl, tot, fireAt: tot !== null ? tot - p.tof : null, name: u.name, label: MTYPES[spec.mt].label });
      msg(fmMsg, ctl === 'tot' ? `Mission ${id} laid. Fires at ${fmt(tot - p.tof)}, first rounds land at ${fmt(tot)}.`
                               : `Mission ${id} laid and waiting. Press FIRE below when you want it.`);
      drawHeld();
    }
    function fireHeld(h, t0) {
      held.splice(held.indexOf(h), 1);
      const p = plan(h.spec);
      if (p.err) { log(`M${h.id} cancelled: ${p.err}`); msg(fmMsg, `Mission ${h.id} cancelled: ${p.err}`, 'bad'); }
      else { if (h.ctl === 'amc') log(`M${h.id} FIRE`); launch(h.id, p, t0); }
      drawHeld();
    }
    function drawHeld() {
      const L = $('fm-held'); L.textContent = '';
      for (const h of held) {
        const row = document.createElement('div'); row.className = 'urow';
        const nm = document.createElement('span'); nm.className = 'un'; nm.textContent = `M${h.id} ${h.name} · ${h.label}`;
        const gr = document.createElement('span'); gr.className = 'ug';
        gr.textContent = h.ctl === 'tot' ? `TOT ${fmt(h.tot)} · fires ${fmt(h.fireAt)}` : 'At my command · laid'; nm.appendChild(gr); row.appendChild(nm);
        if (h.ctl === 'amc') { const f = document.createElement('button'); f.className = 'fire-btn'; f.textContent = 'FIRE'; f.addEventListener('click', () => fireHeld(h, simT)); row.appendChild(f); }
        const c = document.createElement('button'); c.textContent = 'Cancel';
        c.addEventListener('click', () => { held.splice(held.indexOf(h), 1); log(`M${h.id} cancelled`); msg(fmMsg, `Mission ${h.id} cancelled.`); drawHeld(); });
        row.appendChild(c); L.appendChild(row);
      }
    }
    function tickHeld() {                   // a time on target fires on its own, at the exact moment
      for (const h of held.slice()) if (h.fireAt !== null && simT >= h.fireAt) fireHeld(h, h.fireAt);
    }
    // the form follows the choices: rounds per tube only for fire for effect (the other types fix it), TOT field only for TOT
    function syncCff() {
      const mt = $('fm-type').value, u = units.find(x => String(x.id) === $('fm-unit').value), ffe = mt === 'ffe';
      $('fm-rds').hidden = !ffe; const sh = $('fm-shape'); sh.hidden = ffe;
      if (!ffe) { const s = shapeOf(u ? TYPES[u.type] : { tubes: 6, interval: 15 }, mt, 1);
        sh.textContent = `${s.n} tube${s.n === 1 ? '' : 's'} × ${s.per} rd${s.per === 1 ? '' : 's'}` + (s.per > 1 ? `, ${s.iv} s apart` : ''); }
      const tot = $('fm-control').value === 'tot', ti = $('fm-tot'); ti.hidden = !tot;
      if (tot && !ti.value) ti.value = fmt(Math.ceil((simT + 180) / 60) * 60);   // a suggestion: the next whole minute, 3 or more out
    }
    $('fm-type').addEventListener('change', syncCff); $('fm-control').addEventListener('change', syncCff); $('fm-unit').addEventListener('change', syncCff);
    // Low / High angle (Lee, 2026-11-02: High is the default — most of this terrain needs it). Mortars are always high.
    let angle = 'high';
    function syncAngle() {
      const u = units.find(x => String(x.id) === $('fm-unit').value), mortar = !!u && TYPES[u.type].angle === 'high';
      $('fm-low').disabled = mortar; $('fm-low').title = mortar ? 'Mortars fire high angle only' : 'Low angle: flatter, faster, masked by buildings';
      const a = mortar ? 'high' : angle; $('fm-high').setAttribute('aria-pressed', String(a === 'high')); $('fm-low').setAttribute('aria-pressed', String(a === 'low'));
    }
    $('fm-high').addEventListener('click', () => { angle = 'high'; syncAngle(); });
    $('fm-low').addEventListener('click', () => { angle = 'low'; syncAngle(); });
    $('fm-unit').addEventListener('change', syncAngle);

    // ---- QUICK FIRE (Lee, 2026-11-11): the instructor paints effects on a point. No firing unit, no flight: rounds land
    //      now, scattered round the aim point (gaussian, sd m 1σ each axis), one every gap s. Damage rolls as for any burst,
    //      with the radii in DAMAGE.R under the same key. All figures placeholders (Claude's proposal, unsourced).
    //      n: default count · sd: default spread · gap: s between impacts · burst: visual size (155 = 1)
    const QF = {
      m777:    { cat: 'Artillery', label: '155 mm',            n: 6,  ns: [1, 6, 12, 18, 36], sd: 35, gap: 0.6, burst: 1.0 },
      m119:    { cat: 'Artillery', label: '105 mm',            n: 6,  ns: [1, 6, 12, 18, 36], sd: 30, gap: 0.6, burst: 0.75 },
      m120:    { cat: 'Artillery', label: '120 mm mortar',     n: 4,  ns: [1, 4, 8, 16],      sd: 30, gap: 0.6, burst: 0.8 },
      m252:    { cat: 'Artillery', label: '81 mm mortar',      n: 4,  ns: [1, 4, 8, 16],      sd: 25, gap: 0.6, burst: 0.55 },
      gmlrs:   { cat: 'Rocket artillery', label: 'GMLRS (unitary)', n: 1, ns: [1, 2, 4, 6, 12], sd: 4,  gap: 4,   burst: 1.4 },
      rt_mk15: { cat: 'Rocket artillery', label: 'RT-2000 Mk15 117 mm', n: 45, ns: [1, 15, 45, 90], sd: 90, gap: 0.25, burst: 0.7 },
      rt_mk30: { cat: 'Rocket artillery', label: 'RT-2000 Mk30 180 mm', n: 27, ns: [1, 9, 27, 54], sd: 120, gap: 0.35, burst: 0.9 },
      rt_mk45: { cat: 'Rocket artillery', label: 'RT-2000 Mk45 227 mm', n: 12, ns: [1, 6, 12, 24], sd: 150, gap: 0.5, burst: 1.1 },
      atacms:  { cat: 'Rocket artillery', label: 'ATACMS (unitary)', n: 1, ns: [1, 2],            sd: 6,  gap: 0,   burst: 2.0 },
      mk81:    { cat: 'Bombs', label: '250 lb',                n: 1,  ns: [1, 2, 4, 8],       sd: 5,  gap: 0.15, burst: 1.6 },
      mk82:    { cat: 'Bombs', label: '500 lb',                n: 1,  ns: [1, 2, 4, 8],       sd: 5,  gap: 0.15, burst: 2.0 },
      mk83:    { cat: 'Bombs', label: '1,000 lb',              n: 1,  ns: [1, 2, 4],          sd: 5,  gap: 0.15, burst: 2.6 },
      mk84:    { cat: 'Bombs', label: '2,000 lb',              n: 1,  ns: [1, 2, 4],          sd: 5,  gap: 0.15, burst: 3.3 }
    };
    const quicks = []; let painting = false, qfId = 0;
    const qfMsg = $('qf-msg'), qfMun = $('qf-mun'), qfN = $('qf-n');
    { let og = null; for (const [k, q] of Object.entries(QF)) {
        if (!og || og.label !== q.cat) { og = document.createElement('optgroup'); og.label = q.cat; qfMun.appendChild(og); }
        const o = document.createElement('option'); o.value = k; o.textContent = q.label; og.appendChild(o); } }
    function qfCounts() {
      const q = QF[qfMun.value]; qfN.textContent = '';
      for (const n of q.ns) { const o = document.createElement('option'); o.value = String(n); o.textContent = n + (q.cat === 'Bombs' ? (n > 1 ? ' bombs' : ' bomb') : q.cat === 'Artillery' ? ' rds' : n > 1 ? ' rockets' : ' rocket'); qfN.appendChild(o); }
      qfN.value = String(q.n);
    }
    qfMun.addEventListener('change', qfCounts); qfCounts();
    function quickFire(e, n) {
      const k = qfMun.value, q = QF[k];
      { const p = toLocal(e, n); if (!inPlay(p.x, p.z)) return msg(qfMsg, 'That point is off the map.', 'bad'); }
      const cnt = Number(qfN.value) || q.n, sd = Number($('qf-sd').value) || q.sd, id = ++qfId, r = rng(id * 40503 + 7), impacts = [];
      for (let j = 0; j < cnt; j++) {
        const ie = e + (cnt > 1 || sd > 1 ? gauss(r) * sd : 0), inn = n + (cnt > 1 || sd > 1 ? gauss(r) * sd : 0), pl = toLocal(ie, inn);
        if (!inPlay(pl.x, pl.z)) continue;
        const roof = CITY.ready ? CITY.roofAt(pl.x, pl.z, true) : null, t = simT + j * q.gap + (q.gap ? r() * q.gap * 0.5 : 0);
        impacts.push(roof !== null ? { t, e: ie, n: inn, y: roof, what: 'building', above: roof - heightAt(pl.x, pl.z), done: false } : { t, e: ie, n: inn, done: false });
      }
      const m = { tag: 'Q' + id, mun: k, t: { burst: q.burst }, impacts, endT: Math.max(simT, ...impacts.map(i => i.t)), logged: false };
      quicks.push(m);
      log(`Q${id} quick fire ${cnt} × ${q.label} → ${gridTxt(e, n)}, spread ${sd} m`);
      msg(qfMsg, `Q${id}: ${cnt} × ${q.label} on ${gridTxt(e, n)}.` + (painting ? ' Click again to fire more; Esc stops.' : ''));
    }
    $('qf-fire').addEventListener('click', () => { const g = parseGrid($('qf-grid').value); if (g.err) return msg(qfMsg, g.err, 'bad'); quickFire(g.e, g.n); });
    function setPaint(on) {
      painting = on; $('qf-paint').setAttribute('aria-pressed', String(on));
      document.body.classList.toggle('qf-armed', on); $('qf-armed').hidden = !on; armedText();
      if (on) { placing = moving = null; picking = false; msg(qfMsg, 'Click the map to fire there. Esc stops.', 'arm'); } else msg(qfMsg, 'Stopped.');
    }
    $('qf-paint').addEventListener('click', () => setPaint(!painting));
    $('qf-stop').addEventListener('click', () => setPaint(false));
    // another map-click task (place, move, pick a target) disarms quick fire, so the reticle never lies about what a click does
    document.addEventListener('click', () => { if (painting && (placing || moving || picking)) setPaint(false); });
    function armedText() { const q = QF[qfMun.value]; $('qf-armed-t').textContent = 'Fire on click: ' + (Number(qfN.value) || q.n) + ' × ' + q.label; }
    qfMun.addEventListener('change', armedText); qfN.addEventListener('change', armedText);
    function tickQuick() {
      for (const m of quicks) {
        if (m.logged) continue;
        m.impacts.forEach((i, k) => { if (!i.done && simT >= i.t) { i.done = true; burst(i, m); for (const f of impactFns) f(i, m, k); } });
        if (simT > m.endT + 1) { m.logged = true; log(`${m.tag} complete, ${m.impacts.length} burst${m.impacts.length === 1 ? '' : 's'}, ${m.struck || 0} struck` + (m.civ ? ` (${m.civ} civilian)` : '')); }
      }
    }

    // ---- arcs: the mission's computed trajectory (true heights × terrain exaggeration), gun to aim point
    function arcPoint(m, f, out) {
      const P = m.sol.pts, T = f * m.tof; let lo = 0, hi = P.length - 1;
      while (hi - lo > 1) { const c = (lo + hi) >> 1; if (P[c].t <= T) lo = c; else hi = c; }
      const a = P[lo], b = P[hi], k = Math.max(0, Math.min(1, (T - a.t) / ((b.t - a.t) || 1))), x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
      const tp = toLocal(m.g.e, m.g.n), L = Math.hypot(tp.x - m.G.x, tp.z - m.G.z) || 1, s = x / (m.sol.R || 1) * L;
      return out.set(m.G.x + (tp.x - m.G.x) / L * s, (m.gH + y) * ex + 3, m.G.z + (tp.z - m.G.z) / L * s);
    }
    function buildArc(m) {
      const pts = []; const tmp = new THREE.Vector3();
      for (let i = 0; i <= 128; i++) pts.push(arcPoint(m, i / 128, tmp).clone());
      m.arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0.7, depthTest: false }));
      m.arc.renderOrder = 9; m.arc.visible = arcsOn; arcGroup.add(m.arc);
      for (let k = 0; k < m.per; k++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe2a8, depthTest: false }));
        s.renderOrder = 11; s.visible = false; arcGroup.add(s); m.shells.push(s);
      }
    }

    // ---- bursts: flash then a smoke puff that grows, drifts up and thins; all on sim time
    const smokeTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    const scorchGeo = new THREE.PlaneGeometry(1, 1);
    function burst(i, m) {
      NET.emit('burst', { e: i.e, n: i.n, y: i.y, s: m.t.burst });          // a room's students see every burst too
      const p = toLocal(i.e, i.n), y = (i.y !== undefined ? i.y : heightAt(p.x, p.z)) * ex, s = m.t.burst;
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0xffd27a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      flash.position.set(p.x, y + 4, p.z); fxGroup.add(flash);
      const smoke = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x3e3a36, transparent: true, depthWrite: false }));
      smoke.position.set(p.x, y + 6, p.z); fxGroup.add(smoke);
      const scorch = new THREE.Mesh(scorchGeo, new THREE.MeshBasicMaterial({ map: smokeTex, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      scorch.rotation.x = -Math.PI / 2; scorch.position.set(p.x, y + 0.5, p.z); scorch.scale.setScalar(14 * s); fxGroup.add(scorch); scorch.userData.off = i.what === 'building';
      fx.push({ flash, smoke, scorch, t0: i.t, y, s });
      if (fx.length > 600) { const o = fx.shift(); fxGroup.remove(o.flash, o.smoke, o.scorch); }
    }
    function animateFx() {
      for (const f of fx) {
        const a = simT - f.t0;
        f.flash.visible = a >= 0 && a < 0.8; if (f.flash.visible) { const k = 25 + 70 * f.s * (a / 0.8); f.flash.scale.set(k, k, 1); f.flash.material.opacity = 1 - a / 0.8; }
        const life = 60; f.smoke.visible = a >= 0 && a < life;
        if (f.smoke.visible) { const k = (18 + 60 * Math.sqrt(a / life)) * f.s; f.smoke.scale.set(k, k * 1.25, 1); f.smoke.position.y = f.y + k * 0.45 + a * 0.8; f.smoke.material.opacity = 0.9 * Math.pow(1 - a / life, 1.5); }
        f.scorch.visible = a >= 0 && a < 600 && !f.scorch.userData.off; if (f.scorch.visible) f.scorch.material.opacity = 0.55 * (1 - a / 600);
      }
    }

    // ---- the clock step
    const tmpV = new THREE.Vector3();
    function tick(dt) {
      simT += dt * speed; $('clock').textContent = fmt(simT);
      tickHeld();
      for (const m of missions) {
        if (!m.splash && simT >= m.t0 + m.tof - 5) { m.splash = true; log(`M${m.id} SPLASH`); }
        m.impacts.forEach((i, k) => { if (!i.done && simT >= i.t) { i.done = true; burst(i, m); for (const f of impactFns) f(i, m, k); } });
        for (let k = 0; k < m.per; k++) {
          const f = (simT - (m.t0 + k * m.iv)) / m.tof, s = m.shells[k];
          s.visible = arcsOn && f > 0 && f < 1 && simT < m.volEnd[k];
          if (s.visible) { arcPoint(m, f, tmpV); s.position.copy(tmpV); const d = camera.position.distanceTo(tmpV) * 0.004; s.scale.setScalar(Math.max(2, d)); }
        }
        if (m.arc && simT > m.endT + 20) { arcGroup.remove(m.arc); m.arc.geometry.dispose(); m.arc = null; const nb = m.impacts.filter(i => i.what === 'building').length, nt = m.impacts.filter(i => i.what === 'terrain').length;
          log(`M${m.id} rounds complete, ${m.impacts.length} rds, ${m.struck || 0} struck` + (m.civ ? ` (${m.civ} civilian)` : '') + (nb ? `, ${nb} hit buildings` : '') + (nt ? `, ${nt} hit terrain` : '')); }
      }
      tickQuick();
      animateFx();
    }

    // ---- log
    const entries = [];
    function log(text) {
      entries.unshift({ t: simT, text }); const L = $('flog'); L.textContent = '';
      for (const e of entries.slice(0, 40)) { const d = document.createElement('div'); const a = document.createElement('span'); a.className = 't'; a.textContent = fmt(e.t); const b = document.createElement('span'); b.textContent = e.text; d.append(a, b); L.appendChild(d); }
    }

    // ---- clock and view controls
    // Play/Pause is separate from the rate, so pausing keeps the chosen 1x/5x/10x
    let rate = 1, playing = true;
    const ck = { 'ck-1': 1, 'ck-5': 5, 'ck-10': 10 };
    function applyClock() { speed = playing ? rate : 0; const p = $('ck-play');
      p.textContent = playing ? 'Pause' : 'Play'; p.setAttribute('aria-pressed', String(playing)); p.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
    $('ck-play').addEventListener('click', () => { playing = !playing; applyClock(); });
    for (const id of Object.keys(ck)) $(id).addEventListener('click', () => { rate = ck[id]; for (const o of Object.keys(ck)) $(o).setAttribute('aria-pressed', String(o === id)); applyClock(); });
    addEventListener('keydown', e => { if (e.code === 'Space' && !obs && !STUDENT && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); playing = !playing; applyClock(); } });
    function setMap(on) {
      mapMode = mapView = on; $('vw-map').setAttribute('aria-pressed', String(on)); $('vw-3d').setAttribute('aria-pressed', String(!on));
      if (on) {
        const t = controls.target.clone(), h = Math.max(1500, camera.position.distanceTo(t));
        controls.minPolarAngle = controls.maxPolarAngle = 0.0001; controls.minAzimuthAngle = controls.maxAzimuthAngle = 0;
        controls.enableRotate = false; setButtons(true); controls.screenSpacePanning = true;
        camera.position.set(t.x, h, t.z + 0.01);
      } else {
        controls.minPolarAngle = 0; controls.maxPolarAngle = Math.PI * 0.49; controls.minAzimuthAngle = -Infinity; controls.maxAzimuthAngle = Infinity;
        controls.enableRotate = true; setButtons(false); controls.screenSpacePanning = false;
        const t = controls.target; camera.position.set(t.x + 2500, 4200, t.z + 5200);
      }
      controls.update();
    }
    $('vw-map').addEventListener('click', () => setMap(true));
    $('vw-3d').addEventListener('click', () => setMap(false));
    $('tg-arcs').addEventListener('click', () => { arcsOn = !arcsOn; $('tg-arcs').setAttribute('aria-pressed', String(arcsOn)); for (const m of missions) if (m.arc) m.arc.visible = arcsOn; });

    // ---- clicks on the map: place, move or pick a target (a click, not the end of a drag)
    let down = null;
    canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', e => {
      if (!down || obs) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
      if (moved > 5 || !(placing || moving || picking || painting)) return;
      const p = pick(e.clientX, e.clientY); if (!p) return;
      const E = CE + p.x, N = CN - p.z;
      if (painting && !(placing || moving || picking)) { $('qf-grid').value = toGrid(E, N) || ''; quickFire(E, N); }
      else if (placing) { const err = placeAt(placing, E, N, 0); if (err) msg(placeMsg, err, 'bad'); placing = null; }
      else if (moving) moveUnit(moving, E, N, 0);
      else if (picking) { $('fm-grid').value = toGrid(E, N); picking = false; msg(fmMsg, 'Target set. Press Send.'); }
    });
    addEventListener('keydown', e => { if (e.key === 'Escape' && painting) setPaint(false); });
    addEventListener('keydown', e => { if (e.key === 'Escape' && (placing || moving || picking)) { placing = moving = null; picking = false; msg(placeMsg, 'Cancelled.'); msg(fmMsg, ''); } });
    let savedUnits = null; try { savedUnits = JSON.parse(localStorage.getItem(STORE.units)); } catch (e) {}
    if (Array.isArray(savedUnits) && !NET.client) for (const u of savedUnits) if (TYPES[u.type]) addUnit(u.type, u.e, u.n, u.alt, u.cs);
    drawUnits();
    return { tick, linkUAS(api) { UL = api; }, lpsChanged: drawUnits, onImpact: f => impactFns.push(f), onExaggeration() { for (const u of units) placeSprite(u); }, blast(e, n, size, y) { burst({ e, n, y, t: simT }, { t: { burst: size } }); }, log, setUnits, debug: { QF, quicks, quickFire, tick, unitList, units, get speed() { return speed; }, set speed(v) { speed = Math.max(0, +v || 0); }, missions, fx, parseGrid, toGrid, addUnit, TYPES, BAL, maskRound, syncAngle, unitGroup, arcGroup, fxGroup, get simT() { return simT; }, set simT(v) { simT = Math.max(0, +v || 0); } } };
  })();
  window.__fires = FIRES.debug; window.__view = { camera, controls, toLocal, heightAt, renderer, scene }; window.__firesHook = () => { FIRES.onExaggeration(); if (typeof OPFOR !== 'undefined') OPFOR.onExaggeration(); };


  // ---- OPFOR: enemy groups (convoys), drawn routes, ships that carry cargo groups.
  //      Everything a vehicle does is a pure function of the sim clock, so pause, 5x/10x and
  //      editing at T+0 all just work. Damage comes later. Vehicle figures are placeholders.
  const OPFOR = (function () {
    const $ = id => document.getElementById(id);
    // L x W x H metres, approximate public figures; speeds km/h; all placeholders to tune
    const VT = {
      zbd:  { name: 'ZBD',         L: 9.5, W: 3.4, H: 2.6, amph: true,  land: 40, water: 20, gap: 50, dismount: true },   // a squad gets out when it comes ashore
      ztd:  { name: 'ZTD',         L: 9.5, W: 3.4, H: 2.8, amph: true,  land: 40, water: 20, gap: 50 },
      eng:  { name: 'Engineering', L: 8.0, W: 3.2, H: 3.2, amph: false, land: 30, water: 0,  gap: 50 },
      fuel: { name: 'Fuel Truck',  L: 9.0, W: 2.5, H: 3.3, amph: false, land: 40, water: 0,  gap: 50 },
      plz:  { name: 'PLZ-05 SPH',  L: 10.6, W: 3.3, H: 3.3, amph: false, land: 40, water: 0,  gap: 50 },   // 155 mm SP howitzer; model has 'turret' and 'gun' nodes for aiming
      hq17: { name: 'HQ-17 SAM',   L: 8.0, W: 3.1, H: 5.1, amph: false, land: 40, water: 0,  gap: 50 },   // tracked air defence, Tor-M1 family; H with the search radar up
      inf:  { name: 'Infantry',    L: 0.9, W: 0.9, H: 1.8, amph: false, land: 5,  water: 0,  gap: 5, foot: true, squad: 12 },   // count = soldiers; all drawn by one instanced mesh
      lcu:{ name: 'LCU',         L: 41,  W: 9,   H: 5,   ship: true,  land: 0,  water: 18, gap: 150, draft: 1.5, unload: 120 },
      roro: { name: 'RoRo',        L: 150, W: 25,  H: 22,  ship: true,  land: 0,  water: 25, gap: 500, draft: 6,   unload: 600 }
    };
    const LAND = ['zbd', 'ztd', 'eng', 'fuel', 'plz', 'hq17', 'inf'], SHIPS = ['lcu', 'roro'];
    const KEY = STORE.opfor;                               // v1 (straight-line test routes) dropped 2026-11-02
    try { localStorage.removeItem('fist-trainer-opfor-v1'); } catch (e) {}
    let groups = [], sel = null, editing = false, nextId = 1, selPt = -1, showEnemy = true, showRoutes = true;
    const simT = () => FIRES.debug.simT;
    const fmt = s => { s = Math.max(0, Math.round(s)); return 'T+' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
    const parseT = v => { const m = String(v).trim().replace(/^T\+/i, '').match(/^(\d+)(?::(\d{1,2}))?$/); return m ? (+m[1]) * 60 + (m[2] !== undefined ? +m[2] : 0) : null; };
    function waterAt(x, z) {
      const c = Math.round((x + HW) / CELL - 0.5), r = Math.round((z + HH) / CELL - 0.5);
      if (c < 0 || r < 0 || c >= NX || r >= NY) return true;
      return dm[r * NX + c] < 0 || H[r * NX + c] < 0.3;
    }
    const isShip = g => g.units.length > 0 && !!VT[g.units[0].type].ship;
    const carrierOf = g => g.carrier ? groups.find(o => o.id === g.carrier) : null;

    // ---- persistence (this browser; the Scenario panel writes the same data to a file)
    const snapshot = () => ({ nextId, groups: groups.map(g => ({ id: g.id, name: g.name, units: g.units, route: g.route, start: g.start, land: g.land, water: g.water, gap: g.gap, carrier: g.carrier, offShip: g.offShip, unload: g.unload, offload: g.offload, q: g.q, parent: g.parent || null, splitAt: g.splitAt, join: g.join || null, roads: g.roads !== false, loose: g.loose })) });
    function save() { if (NOSAVE) return; try { localStorage.setItem(KEY, JSON.stringify(snapshot())); } catch (e) {} }
    function load() { if (NET.client) return; try { const o = JSON.parse(localStorage.getItem(KEY)); if (o && Array.isArray(o.groups)) { groups = o.groups; nextId = o.nextId || groups.length + 1; } } catch (e) {} }

    // ---- motion profile: arc length vs time along the route, speed by land or water
    function fullRoute(g, d = 0) {             // own points, then (if rejoined) the rest of the route it joins
      if (!g.join || d > 6) return g.route;
      const tg = groups.find(o => o.id === g.join.group); if (!tg) return g.route;
      return g.route.concat(fullRoute(tg, d + 1).slice(g.join.at + 1));
    }
    // ---- road snapping (Lee, 2026-11-02): land groups follow the roads between clicked points by default.
    //      A leg stays a straight line when the group is a ship, the group has Follow roads off, either end is in the
    //      water (beach landings, swims), or no road lies within ROAD_REACH of an end. Land legs off the roads steer around
    //      buildings (below); whatever still crosses one, and the short links from a clicked point to its road, is warned.
    //
    // ---- building detours (Lee, 2026-11-04): off-road land paths go around building footprints, so a line can spread
    //      across a built-up area. Worked out once on edit and stored as ordinary path points: no cost per frame.
    //      A grid search over passable ground, then the path is pulled tight so it reads as straight runs with a jog.
    //      lanes: ground a sibling in the line already took, made dearer so the line stays spread out instead of funnelling.
    const D_CELL = 6, D_NX = Math.ceil(2 * HW / D_CELL), D_NY = Math.ceil(2 * HH / D_CELL), D_MAX = 100000, D_ROOM = 2.5, D_POCKET = 3000;
    let dOcc = null;                           // per cell: 0 not looked at yet, 1 passable, 2 building or too close to one
    const dIdx = (x, z) => { const c = Math.floor((x + HW) / D_CELL), r = Math.floor((z + HH) / D_CELL); return c < 0 || r < 0 || c >= D_NX || r >= D_NY ? -1 : r * D_NX + c; };
    const dMid = i => ({ x: (i % D_NX + 0.5) * D_CELL - HW, z: (Math.floor(i / D_NX) + 0.5) * D_CELL - HH });
    function dSolid(i) {
      if (i < 0) return true;
      if (!dOcc) dOcc = new Uint8Array(D_NX * D_NY);
      if (!dOcc[i]) { const m = dMid(i), s = CITY.solidAt, R = D_ROOM;
        dOcc[i] = s(m.x, m.z) || s(m.x - R, m.z - R) || s(m.x + R, m.z - R) || s(m.x - R, m.z + R) || s(m.x + R, m.z + R) ||
          s(m.x - R, m.z) || s(m.x + R, m.z) || s(m.x, m.z - R) || s(m.x, m.z + R) ? 2 : 1; }
      return dOcc[i] === 2;
    }
    function dOpen(i0) {                       // false for a courtyard or block sealed off by buildings, which is then treated as solid for good
      if (dOcc[i0] === 3) return true;         // 3: passable and known to connect to the wider ground
      const seen = new Set([i0]), todo = [i0];
      while (todo.length && seen.size < D_POCKET) {
        const i = todo.pop(), c = i % D_NX;
        for (const n of [c > 0 ? i - 1 : -1, c < D_NX - 1 ? i + 1 : -1, i - D_NX, i + D_NX]) if (n >= 0 && n < D_NX * D_NY && !seen.has(n) && !dSolid(n)) { seen.add(n); todo.push(n); }
      }
      const open = seen.size >= D_POCKET;
      for (const i of seen) dOcc[i] = open ? 3 : 2;
      return open;
    }
    function dClear(a, b) {
      const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 3);
      for (let s = 0; s <= n; s++) if (dSolid(dIdx(a.x + (b.x - a.x) * s / (n || 1), a.z + (b.z - a.z) * s / (n || 1)))) return false;
      return true;
    }
    function dFree(p) {                        // p itself if passable, else the nearest passable ground within about 70 m
      const i0 = dIdx(p.x, p.z); if (i0 < 0) return null;
      if (!dSolid(i0) && dOpen(i0)) return p;
      const c0 = i0 % D_NX, r0 = (i0 - c0) / D_NX;
      for (let R = 1; R <= 12; R++) {
        let best = null, bd = Infinity;
        for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== R) continue;
          const c = c0 + dc, r = r0 + dr; if (c < 0 || r < 0 || c >= D_NX || r >= D_NY) continue;
          const i = r * D_NX + c; if (dSolid(i) || !dOpen(i)) continue;
          const m = dMid(i), d = Math.hypot(m.x - p.x, m.z - p.z); if (d < bd) { bd = d; best = m; }
        }
        if (best) return best;
      }
      return null;
    }
    let dG = new Float32Array(0), dPrev = new Int32Array(0);
    function dSearch(a, b, lanes) {            // cells from a to b around buildings, staying within about 900 m of the leg's box; null if none
      const s = dIdx(a.x, a.z), t = dIdx(b.x, b.z); if (s === t) return [];
      const tc = t % D_NX, tr = (t - tc) / D_NX, sc = s % D_NX, sr = (s - sc) / D_NX, PAD = 150;
      const c0 = Math.max(0, Math.min(sc, tc) - PAD), c1 = Math.min(D_NX - 1, Math.max(sc, tc) + PAD), r0 = Math.max(0, Math.min(sr, tr) - PAD), r1 = Math.min(D_NY - 1, Math.max(sr, tr) + PAD);
      const w = c1 - c0 + 1, size = w * (r1 - r0 + 1);
      if (dG.length < size) { dG = new Float32Array(size); dPrev = new Int32Array(size); }
      dG.fill(Infinity, 0, size);
      const loc = (c, r) => (r - r0) * w + c - c0;
      const h = i => { const c = i % D_NX, dc = Math.abs(c - tc), dr = Math.abs((i - c) / D_NX - tr); return 2 * (Math.max(dc, dr) + 0.414 * Math.min(dc, dr)); };   // 2: heads for the goal, far fewer cells searched; the pull below tidies the path
      dG[loc(sc, sr)] = 0; const F = [h(s)], I = [s];
      const push = (f, i) => { let k = F.length; F.push(f); I.push(i);
        while (k) { const q = (k - 1) >> 1; if (F[q] <= f) break; F[k] = F[q]; I[k] = I[q]; k = q; } F[k] = f; I[k] = i; };
      const pop = () => { const top = I[0], f = F.pop(), i = I.pop(), n = F.length;
        if (n) { let k = 0; for (;;) { let m = 2 * k + 1; if (m >= n) break; if (m + 1 < n && F[m + 1] < F[m]) m++; if (F[m] >= f) break; F[k] = F[m]; I[k] = I[m]; k = m; } F[k] = f; I[k] = i; }
        return top; };
      for (let seen = 0; I.length && seen < D_MAX; seen++) {
        const i = pop();
        if (i === t) { const out = []; for (let k = t; k !== s; k = dPrev[loc(k % D_NX, (k - k % D_NX) / D_NX)]) out.push(k); return out.reverse(); }
        const c = i % D_NX, r = (i - c) / D_NX, gi = dG[loc(c, r)];
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nc = c + dc, nr = r + dr; if (nc < c0 || nr < r0 || nc > c1 || nr > r1) continue;
          const n = nr * D_NX + nc; if (dSolid(n)) continue;
          if (dr && dc && (dSolid(r * D_NX + nc) || dSolid(nr * D_NX + c))) continue;   // no cutting a corner
          const g2 = gi + (dr && dc ? 1.414 : 1) * (lanes && lanes.has(n) ? 1.5 : 1), ln = loc(nc, nr);
          if (g2 < dG[ln]) { dG[ln] = g2; dPrev[ln] = i; push(g2 + h(n), n); }
        }
      }
      return null;
    }
    function detour(a, b, lanes) {             // [a ... b] around buildings, or null: city not loaded, off the map, or no way round
      if (!CITY.ready) return null;
      if (dClear(a, b)) return [a, b];
      const a1 = dFree(a), b1 = dFree(b); if (!a1 || !b1) return null;
      const cells = dSearch(a1, b1, lanes); if (!cells) return null;
      const core = [a1, ...cells.slice(0, -1).map(dMid), b1], out = [a1];
      for (let i = 0; i < core.length - 1;) {
        let j = i + 1; while (j < core.length - 1 && dClear(core[i], core[j + 1])) j++;
        while (j > i + 1 && crossings({ pts: [core[i], core[j]], road: false }).length) j--;   // no nicking a corner the grid missed
        out.push(core[j]); i = j;
      }
      if (a1 !== a) out.unshift(a);            // a point inside a building still has to be reached; crossings() flags it
      if (b1 !== b) out.push(b);
      return out;
    }
    function dLane(pts) {                      // the cells a path runs over, a cell either side: about 18 m wide
      const out = new Set();
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k], n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (D_CELL / 2));
        for (let s = 0; s <= n; s++) { const i = dIdx(a.x + (b.x - a.x) * s / (n || 1), a.z + (b.z - a.z) * s / (n || 1)); if (i < 0) continue;
          const c = i % D_NX; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (c + dc >= 0 && c + dc < D_NX) out.add(i + dr * D_NX + dc); }
      }
      return out;
    }
    const legCache = new Map();
    const snapOn = g => !isShip(g) && g.roads !== false;
    function leg(g, a, b, straight) {          // a, b local points -> { pts: [a ... b], road, why }; straight: this leg ignores roads
      const on = snapOn(g) && !straight, ship = isShip(g), k = (ship ? 's' : on ? 1 : 0) + '|' + Math.round(a.x) + ',' + Math.round(a.z) + '|' + Math.round(b.x) + ',' + Math.round(b.z);
      let r = legCache.get(k); if (r) return r;
      let why = !on ? '' : waterAt(a.x, a.z) || waterAt(b.x, b.z) ? 'water' : !ROADNET ? 'loading' : '';
      let pts = null;
      if (on && !why) { pts = ROADNET.path(a.x, a.z, b.x, b.z); if (!pts) why = 'noroad'; }
      const dragging = drag !== null;          // straight while a point is being dragged; the search runs when it is let go
      const off = !pts && !ship && !dragging && why !== 'loading' ? detour({ x: a.x, z: a.z }, { x: b.x, z: b.z }) : null;
      r = { pts: pts || off || [{ x: a.x, z: a.z }, { x: b.x, z: b.z }], road: !!pts, why };
      r.cross = crossings(r);
      if (!dragging && why !== 'loading' && (CITY.ready || !r.cross.length)) legCache.set(k, r);
      return r;
    }
    function crossings(r) {                    // straight pieces that pass through a building: [{x0,z0,x1,z1}]
      if (!CITY.ready) return [];
      const out = [], P = r.pts, pieces = r.road ? [[0, 1], [P.length - 2, P.length - 1]] : P.slice(1).map((_, i) => [i, i + 1]);
      for (const [i, j] of pieces) {
        const a = P[i], b = P[j], L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(L / 4);
        let hit = false; for (let s = 1; s < n && !hit; s++) hit = CITY.solidAt(a.x + (b.x - a.x) * s / n, a.z + (b.z - a.z) * s / n);
        if (hit) out.push({ x0: a.x, z0: a.z, x1: b.x, z1: b.z });
      }
      return out;
    }
    function routePath(g, R) {                 // the driven path for a list of route points, plus where each point falls in it
      const pts = R.map(p => toLocal(p.e, p.n)), out = pts.length ? [pts[0]] : [], at = [0], legs = [];
      for (let k = 1; k < pts.length; k++) { const l = leg(g, pts[k - 1], pts[k], R[k - 1].straight); legs.push(l); out.push(...l.pts.slice(1)); at.push(out.length - 1); }
      return { pts: out, at, legs };
    }
    onRoadNet = () => { legCache.clear(); refresh(); };
    onCityReady = () => { legCache.clear(); refresh(); };

    function profile(g, quick) {               // quick: while dragging, line paths go straight (no road search)
      const R = fullRoute(g), rp = routePath(g, R), pts = rp.pts;
      const S = [0], T = [0], X = [], Z = [];
      if (R.length < 2) { g.prof = null; return; }
      const ship = isShip(g), step = 5, stops = [];
      let s = 0, t = 0;
      X.push(pts[0].x); Z.push(pts[0].z);
      const hold = k => {                      // scripted wait at route point k: time passes, distance does not
        const w = +R[k].hold || 0; if (w <= 0 || k === R.length - 1) return;
        stops.push({ k, s, t0: t, t1: t + w }); t += w; S.push(s); T.push(t); X.push(X[X.length - 1]); Z.push(Z[Z.length - 1]);
      };
      const wpS = [0];
      hold(0);
      for (let k = 1, wp = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k], L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / step));
        for (let j = 1; j <= n; j++) {
          const x = a.x + (b.x - a.x) * j / n, z = a.z + (b.z - a.z) * j / n, ds = L / n;
          const wet = waterAt(x, z), ov = +R[Math.min(wp, R.length - 1) - 1].kmh || 0;   // a route point can set the speed to the next one
          const kmh = ov > 0 ? ov : ship ? g.water : (wet ? (g.water || g.land) : g.land);
          s += ds; t += ds / Math.max(0.5, kmh / 3.6);
          S.push(s); T.push(t); X.push(x); Z.push(z);
        }
        while (wp < rp.at.length && rp.at[wp] === k) { wpS[wp] = s; hold(wp); wp++; }   // a clicked route point: holds and split points key on these
      }
      g.prof = { S, T, X, Z, len: s, dur: t, stops, wpS, legs: rp.legs };
      const up = g._rides ? parentOf(g) : null;  // the loose drift carries on through a split without a jump
      g.prof.ph = up && up.prof && up.prof.wpS[g.splitAt] !== undefined ? up.prof.ph + up.prof.wpS[g.splitAt] : 0;
      g.prof.lags = colLags(g, famSize(g)); g.prof.line = lineFor(g, R, wpS, quick);
      g.prof.delay = offDelays(g);
    }
    // ---- offloading (Lee, 2026-11-11): one vehicle at a time down each ship's ramp, every `offload` seconds (30 by default).
    //      Cargo groups off the same ramp queue in the order dragged in the list (q); a group's Wait holds the queue behind it.
    //      _qoff (set in syncBranches): seconds after the ship arrives that the group's first vehicle is off. Vehicle i then
    //      runs on its group's clock delayed by prof.delay[i], so it rolls off i × offload after the first and follows the same path.
    const offloadOf = c => c.offload === undefined ? 30 : Math.max(0, +c.offload || 0);
    const rampOf = g => { const c = carrierOf(g), n = c ? shipsSpread(c) : 0; return n ? g.offShip % n : 0; };
    function offDelays(g) {
      const c = carrierOf(g); if (!c) return null;
      const P = g.prof, off = offloadOf(c), out = []; let any = false;
      for (let i = 0; i < ownCount(g); i++) { const e = timeAtS(P, P.lags[i]), d = Math.max(0, i * off - (e === null ? 0 : e)); out.push(d); if (d) any = true; }
      return any ? out : null;                 // less the time its column place takes anyway, so the gap is exactly one offload
    }
    function queueRamps() {
      const ramps = new Map(), rank = g => g.q === undefined ? 1e9 : g.q;
      for (const g of groups) if (g.carrier && carrierOf(g)) { const k = g.carrier + ':' + rampOf(g); (ramps.get(k) || ramps.set(k, []).get(k)).push(g); }
      for (const q of ramps.values()) {
        q.sort((a, b) => rank(a) - rank(b) || groups.indexOf(a) - groups.indexOf(b));
        const off = offloadOf(carrierOf(q[0])); let cur = 0;
        q.forEach((g, k) => { g.q = k; cur += g.start || 0; g._qoff = cur + off; cur += ownCount(g) * off; });
      }
    }
    const vehS = (g, i, t, s0) => { const d = g.prof && g.prof.delay && g.prof.delay[i]; return d ? sAt(g, t - d) : s0; };

    // ---- formations (Lee, 2026-11-03). A route point can switch the group to Line or back to Column.
    //      Line: from that point each vehicle drives its OWN path, to its slot on the front at each later point (the
    //      front is a bar square to the route, frontage set on the point, ends draggable). On land the paths take
    //      roads, with junctions a sibling already used made dearer, so a line flows down parallel streets; vehicles
    //      that still share a street drive one behind the other. A Column point regroups them: every path ends on that
    //      point and the rear falls back into column, centre first. Line, then Column at the next point = a swarm.
    //      All of it is worked out on edit (cached); a frame is still one lookup per vehicle.
    const FRONT_SPACING = 30;                  // metres between vehicles in a new line
    const SEP_MIN = 0.5;                       // metres clear between any two vehicles (placeAll)
    const hash01 = k => { let h = k | 0; h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
    const rnd = (g, i, k) => hash01(g.id * 7919 + i * 131 + k * 17);
    const loose = g => !isShip(g) && g.loose !== false;
    function colLags(g, n) {                   // how far behind the lead each vehicle drives in column; Loose: ±25 % of a gap, not cumulative
      // never closer than nose to tail plus SEP_MIN, allowing for the Loose breathing (vehAt) on both: a small Spacing can't stack a column
      const len = Math.max(1, ...g.units.map(u => VT[u.type].L)), need = len + SEP_MIN + (loose(g) ? 2 * Math.min(8, 0.15 * g.gap) : 0);
      const L = []; for (let i = 0; i < n; i++) L.push(Math.max(i ? L[i - 1] + need : 0, i * g.gap + (loose(g) && i > 0 ? (rnd(g, i, 1) - 0.5) * 0.5 * g.gap : 0))); return L;
    }
    function formAt(R, k) { for (let j = k; j >= 0; j--) if (R[j] && R[j].form) return R[j].form; return 'column'; }
    function frontDir(R, P, k) {               // unit vector along the front at point k: square to the route unless the bar was dragged
      const a = P[Math.max(0, k - 1)], c = P[Math.min(P.length - 1, k + 1)];
      let hx = c.x - a.x, hz = c.z - a.z; const L = Math.hypot(hx, hz) || 1; hx /= L; hz /= L;
      const d = { x: hz, z: -hx };
      if (R[k].ang === undefined) return d;
      const e = { x: Math.sin(R[k].ang), z: Math.cos(R[k].ang) };
      return e.x * d.x + e.z * d.z < 0 ? { x: -e.x, z: -e.z } : e;     // keep each vehicle on its own side of the route
    }
    function slotsFor(n) {                     // place across the front by place in the column: lead in the centre, then alternate sides
      const u = []; for (let j = 0; j < n; j++) u.push(n > 1 ? -1 + 2 * j / (n - 1) : 0);
      return u.sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);
    }
    function lineRuns(g, R) {                  // [a, b]: legs a .. b-1 are in line; b is the Column point or the route's end
      const out = [];
      for (let k = 0; k < R.length - 1; k++) {
        if (formAt(R, k) !== 'line') continue;
        let b = k + 1; while (b < R.length - 1 && formAt(R, b) === 'line') b++;
        out.push([k, b]); k = b - 1;
      }
      return out;
    }
    function poly(pts) { const S = [0]; for (let k = 1; k < pts.length; k++) S.push(S[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z)); return { pts, S, len: S[S.length - 1] }; }
    function along(pl, f) {                    // point and heading at fraction f of a polyline (f < 0 runs back off the start)
      const P = pl.pts, S = pl.S, s = f * pl.len;
      if (P.length < 2) return { x: P[0].x, z: P[0].z, hd: 0 };
      let lo = 0, hi = P.length - 1;
      if (s <= 0) hi = 1; else if (s >= pl.len) lo = hi - 1; else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
      const t = (s - S[lo]) / (S[hi] - S[lo] || 1), dx = P[hi].x - P[lo].x, dz = P[hi].z - P[lo].z;
      return { x: P[lo].x + dx * t, z: P[lo].z + dz * t, hd: Math.atan2(dx, dz) };
    }
    // ---- splitting a line (Lee, 2026-11-04): a branch split from a front stays in its parent's line until that front, then
    //      forms its own line from where its vehicles stand. Until then the parent's line holds the whole family: its own
    //      vehicles at places 0 .. own-1, then each rider's (g._fam, set in syncBranches). Riders take the side of the front
    //      their route heads for, so the two lines peel apart without crossing.
    const famSize = g => g._fam ? g._fam.length : ownCount(g);
    const leavesAt = (g, i) => g._fam && g._fam[i] ? g._fam[i].k : Infinity;
    function buildFam(g, d = 0) {
      const own = ownCount(g), fam = []; for (let i = 0; i < own; i++) fam.push({ g, i, k: Infinity });
      g._riders = d > 6 ? [] : branchesOf(g).filter(b => b._rides).sort((x, y) => y.splitAt - x.splitAt || x.id - y.id);
      for (const r of g._riders) { r._fi = fam.length; for (const f of buildFam(r, d + 1)) fam.push({ g: f.g, i: f.i, k: r.splitAt }); }
      return g._fam = fam;
    }
    const onFront = (g, k) => (g._fam || []).reduce((a, f) => a + (f.k >= k ? 1 : 0), 0) || ownCount(g);
    const lineGap = g => { if (!g._rides) return isShip(g) ? g.gap : FRONT_SPACING; const p = parentOf(g), n = onFront(p, g.splitAt); return n > 1 ? frontage(p, p.route, g.splitAt) / (n - 1) : FRONT_SPACING; };
    function frontage(g, R, k) {               // a frontage carried on from an earlier point narrows with the vehicles that have left
      const n = onFront(g, k);
      for (let j = k; j >= 0; j--) if (R[j] && +R[j].w > 0) { const m = onFront(g, j); return n > 1 && m > 1 ? +R[j].w * (n - 1) / (m - 1) : +R[j].w; }
      return lineGap(g) * Math.max(1, n - 1);
    }
    function famOrder(g, R, P, d = 0) {        // the family across the front, one side to the other, as places in g's line
      const own = ownCount(g), U = slotsFor(own), mine = U.map((_, i) => i).sort((x, y) => U[x] - U[y]), one = [], other = [];
      const unit = (a, b) => { const x = b.x - a.x, z = b.z - a.z, L = Math.hypot(x, z) || 1; return { x: x / L, z: z / L }; };
      for (const r of (d > 6 || !g._riders ? [] : g._riders)) {
        const k = r.splitAt, f = frontDir(R, P, k), me = k < P.length - 1 ? unit(P[k], P[k + 1]) : { x: 0, z: 0 };
        const to = r.route[1] ? unit(P[k], toLocal(r.route[1].e, r.route[1].n)) : null;
        const side = to ? (to.x - me.x) * f.x + (to.z - me.z) * f.z : 1e-3, Rr = fullRoute(r);
        (side < 0 ? one : other).push({ side, list: famOrder(r, Rr, Rr.map(p => toLocal(p.e, p.n)), d + 1).map(i => i + r._fi) });
      }
      const by = (x, y) => x.side - y.side;
      return [...one.sort(by).flatMap(o => o.list), ...mine, ...other.sort(by).flatMap(o => o.list)];
    }
    function leaveLine(g) {                    // where a rider's vehicles stand on the parent's front when they leave, and their lag there
      const p = g._rides ? parentOf(g) : null, run = p && p.prof && p.prof.line && p.prof.line.find(r => r.a < g.splitAt && g.splitAt <= r.b); if (!run) return null;
      const out = [];
      for (let i = 0; i < famSize(g); i++) { const vp = run.paths[g._fi + i], pl = vp && vp[vp.length - 1]; if (!pl) return null;
        const V = run.kv[g._fi + i]; out.push({ x: pl.pts[pl.pts.length - 1].x, z: pl.pts[pl.pts.length - 1].z, lag: V[V.length - 1] }); }
      return out;
    }
    const startsAbreast = g => !g.parent && !g.carrier;   // Line on the first point: already on a front at the start. Cargo and branches come out of one spot, so they fan out
    // cargo off its own ship (Lee, 2026-11-04): each cargo group leaves from one ship's place on the landing front. offShip counts across
    // the front from the left end, looking along the route. A landing in column, or by one ship, is one spot: the route's last point.
    const shipsSpread = c => { const R = fullRoute(c), k = R.length - 1; return k > 0 && isShip(c) && ownCount(c) > 1 && formAt(R, k - 1) === 'line' ? ownCount(c) : 0; };
    function offPoint(g, c) {
      const R = fullRoute(c), k = R.length - 1, n = shipsSpread(c); if (!n) return { e: R[k].e, n: R[k].n };
      const d = frontDir(R, R.map(p => toLocal(p.e, p.n)), k), h = frontage(c, R, k) / 2 * (1 - 2 * (g.offShip % n) / (n - 1));
      return { e: Math.round(R[k].e + d.x * h), n: Math.round(R[k].n - d.z * h) };
    }
    function lineFor(g, R, wpS, quick) {
      if (!R.some(p => p.form === 'line')) return [];
      const from = leaveLine(g);
      if (quick) return buildLine(g, R, wpS, true, from);
      const key = JSON.stringify([startsAbreast(g), famOrder(g, R, R.map(p => toLocal(p.e, p.n))),(g._fam || []).map(f => f.k === Infinity ? 0 : f.k), lineGap(g), from && from.map(f => [Math.round(f.x), Math.round(f.z), Math.round(f.lag)]), g.gap, loose(g), snapOn(g), !!ROADNET, !!CITY.ready, R.map(p => [p.e, p.n, p.form || 0, +p.w || 0, p.ang === undefined ? 0 : +p.ang.toFixed(3), p.straight ? 1 : 0])]);
      if (g._lk !== key || !g._line) { g._lk = key; g._line = buildLine(g, R, wpS, false, from); }
      return g._line;
    }
    function buildLine(g, R, wpS, quick, from) {
      const n = famSize(g), runs = lineRuns(g, R), out = [], ship = isShip(g); if (!n) return out;   // ships in line (Lee, 2026-11-04): straight, each to its place on the front; no roads or buildings
      const P = R.map(p => toLocal(p.e, p.n)), cl = colLags(g, n), order = famOrder(g, R, P), places = {};
      const placeAt = (k, i) => {              // -1 .. 1 across the front at point k, among the vehicles still on it
        if (!places[k]) { const on = order.filter(v => leavesAt(g, v) >= k), u = places[k] = []; on.forEach((v, r) => { u[v] = on.length > 1 ? -1 + 2 * r / (on.length - 1) : 0; }); }
        return places[k][i];
      };
      const giveUp = performance.now() + 2000; // a huge line in dense city must not stall the editor: the rest stay straight and amber
      for (const [a, b] of runs) {
        const last = b === R.length - 1, start = a === 0 ? from : null, abreast = a === 0 && startsAbreast(g);
        const slot = (k, i) => { if (k === a && !abreast) return start ? start[i] : P[k];
          if (k === b && !last) return P[k];
          const d = frontDir(R, P, k), h = frontage(g, R, k) / 2 * placeAt(k, i), q = { x: P[k].x + d.x * h, z: P[k].z + d.z * h };
          return !ship && !quick && CITY.ready && dFree(q) || q; };   // a place on the front that lands in a building moves to open ground beside it
        const paths = [], LL = [];             // paths[i][j - a]: vehicle i's own polyline for leg j; LL[j - a][i]: its lag on that leg
        for (let i = 0; i < n; i++) paths.push([]);
        for (let j = a; j < b; j++) {
          const pen = new Map(), nodes = [], lanes = new Set();
          for (let i = 0; i < n; i++) {
            if (leavesAt(g, i) <= j) { nodes.push(null); continue; }   // already gone down its own route
            const A = slot(j, i), B = slot(j + 1, i);
            const straight = quick || !snapOn(g) || R[j].straight || !ROADNET || waterAt(A.x, A.z) || waterAt(B.x, B.z);
            const road = !straight && ROADNET.path(A.x, A.z, B.x, B.z, pen);
            let pts = road, around = null;
            if (!road) {
              const off = ship || quick || performance.now() > giveUp ? null : detour(A, B, lanes);
              pts = off || [A, B];
              if (!ship && !quick && CITY.ready) { const lane = dLane(pts); for (const c of lane) lanes.add(c); if (pts.length > 2) around = lane; }
            }
            const pl = poly(pts); if (!ship && !road && !quick && crossings({ pts, road: false }).length) pl.blocked = true;
            paths[i].push(pl);
            // vehicles squeezed along the same way round a building file through, like those sharing a street
            nodes.push(pts.nodes ? new Set(pts.nodes) : around); if (pts.nodes) for (const v of pts.nodes) pen.set(v, 1);
          }
          // a vehicle sharing most of a leg's streets with one ahead drives a gap behind it, not on top of it. Each moves along
          // its own path by fraction, so the lag has to allow for path lengths: checked half way and at the leg's end.
          const L = wpS[j + 1] - wpS[j], lam = [], len = i => paths[i][j - a].len || 1;
          for (let i = 0; i < n; i++) {
            let v = 0; const si = nodes[i];
            if (si && si.size && L > 0) for (let k = 0; k < i; k++) { const sk = nodes[k]; if (!sk) continue; let c = 0; for (const x of si) if (sk.has(x)) c++;
              if (c > 0.4 * si.size) v = Math.max(v, lam[k] + g.gap, (g.gap * L + lam[k] * len(k)) / len(i), lam[k] + L * (0.5 * len(k) + g.gap) / len(i) - L / 2); }
            lam.push(v);
          }
          LL.push(lam);
        }
        // lag against the lead's arc length, piecewise linear: column lag -> leg a's over E after the line starts; at each later
        // point, a change of lag over the first stretch of the new leg (so a line is abreast AT each front, then files into a
        // shared street); back to column lag over X before a Column point. Falling back stays under 1 m per m, so nobody reverses.
        const S = wpS.slice(a, b + 1), legLen = j => S[j + 1] - S[j], ks = [], kv = [], nl = b - a;
        for (let i = 0; i < n; i++) {           // knots per vehicle, each ramp as short as its own change allows
          const ln = Math.min(nl, leavesAt(g, i) - a), stays = ln === nl;   // ln: the legs of this run it drives; a rider stops being on the line at its split
          if (ln <= 0) { ks.push(null); kv.push(null); continue; }
          const K = [], V = [], knot = (s, v) => { if (K.length && s < K[K.length - 1]) s = K[K.length - 1]; K.push(s); V.push(v); };
          const ramp = (from, to, room, catchUp) => Math.min(room, Math.max(catchUp ? room * 0.75 : 1, Math.abs(to - from) * (to > from ? 1.25 : 1.5)));   // catch-up: the wedge opens before they come level
          const v0 = start ? start[i].lag : abreast ? LL[0][i] : cl[i];
          knot(S[0], v0); knot(S[0] + ramp(v0, LL[0][i], legLen(0) * (ln > 1 || last || !stays ? 0.8 : 0.45), true), LL[0][i]);
          for (let j = 1; j < ln; j++) { knot(S[j], LL[j - 1][i]); knot(S[j] + ramp(LL[j - 1][i], LL[j][i], legLen(j) * (j === nl - 1 && !last && stays ? 0.45 : 0.8)), LL[j][i]); }
          if (!last && stays) { const v = LL[nl - 1][i]; knot(S[nl] - ramp(v, cl[i], legLen(nl - 1) * 0.5), v); knot(S[nl], cl[i]); }
          ks.push(K); kv.push(V);
        }
        const fronts = [];
        for (let k = abreast ? a : a + 1; k <= (last ? b : b - 1); k++) fronts.push({ k, c: P[k], d: frontDir(R, P, k), h: frontage(g, R, k) / 2 });
        out.push({ a, b, SA: S[0], SB: S[b - a], ks, kv, paths, S, fronts, abreast });
      }
      return out;
    }
    function linePt(run, i, q) {
      const S = run.S, vp = run.paths[i]; let j = 0; while (j < S.length - 2 && q >= S[j + 1]) j++;
      if (j >= vp.length) j = vp.length - 1;   // a rider, at the end of its time on the line
      const L = S[j + 1] - S[j];
      return along(vp[j], L > 0 ? Math.min(1, (q - S[j]) / L) : 1);
    }
    function spot(g, i, q) {                   // vehicle i's own line path where one covers q, else the group's route
      const W = g._rides && q < 0 ? splitArc(g) : undefined;
      if (W !== undefined) return spot(parentOf(g), g._fi + i, q + W);   // not yet at the split: still in the parent's line
      const P = g.prof, end = g._fam && g._fam[i] && g._fam[i].k !== Infinity && P ? P.wpS[g._fam[i].k] : undefined;
      if (end !== undefined && q > end) q = end;
      if (P && q > P.len) q = P.len;           // the drift can carry a vehicle just past the end of its route: it stays on its own path
      const run = !P || !P.line || !P.line.length ? null : q >= 0 ? P.line.find(r => q >= r.SA && q <= r.SB) : P.line[0].abreast ? P.line[0] : null;   // behind an abreast start: back along its own path
      if (run && run.paths[i] && run.paths[i].length) { const p = linePt(run, i, q); p.own = true; return p; }
      const r = resolve(g, q); if (!r || !r.g.prof) return null;
      return posAt(r.g, r.s);
    }
    const splitArc = b => { const p = parentOf(b); return p && p.prof ? p.prof.wpS[b.splitAt] : undefined; };
    // where vehicle i of g stands when its lead is at arc length s0: column spacing, its line path if a line is active,
    // and (Loose) a little breathing in spacing and drift in lane. null if it has no route to stand on.
    function vehAt(g, i, s0) {
      if (g._rides && (s0 < 0 || !g.prof)) {   // not yet at the split (or no route of its own yet): a place in the parent's line
        const W = splitArc(g); return W === undefined ? null : vehAt(parentOf(g), g._fi + i, Math.min(s0, 0) + W);
      }
      const P = g.prof, lz = loose(g), base = P && P.lags[i] !== undefined ? P.lags[i] : i * g.gap;
      const who = g._fam && g._fam[i] || { g, i }, ph = s0 + (P ? P.ph : 0);   // who: a rider keeps its own drift, in the parent's line and after
      const lr = P && P.line && P.line.length ? P.line.find(r => s0 >= r.SA && s0 <= r.SB) : null;
      let lag = base;
      if (lr && lr.ks[i]) { const K = lr.ks[i], V = lr.kv[i]; let k = 0; while (k < K.length - 1 && s0 > K[k + 1]) k++;
        if (k >= K.length - 1) lag = V[K.length - 1];
        else { const f = K[k + 1] > K[k] ? Math.min(1, Math.max(0, (s0 - K[k]) / (K[k + 1] - K[k]))) : 1; lag = V[k] + (V[k + 1] - V[k]) * f; } }
      if (lz && (who.i > 0 || who.g._rides)) lag += Math.min(8, 0.15 * g.gap) * Math.sin(ph / 80 + rnd(who.g, who.i, 2) * 6.283);
      const q = s0 - lag, a = spot(g, i, q); if (!a) return null;
      const b = spot(g, i, q + 1.5), dx = b ? b.x - a.x : 0, dz = b ? b.z - a.z : 0, hd = dx * dx + dz * dz > 0.04 ? Math.atan2(dx, dz) : a.hd;
      if (!lz) return { x: a.x, z: a.z, hd };
      const wv = (a.own ? 2.5 : 1) * Math.sin(ph / 45 + rnd(who.g, who.i, 3) * 6.283);   // metres sideways
      return { x: a.x + Math.cos(hd) * wv, z: a.z - Math.sin(hd) * wv, hd };
    }
    // ---- branches: a group that rides at the rear of its parent's column and peels off at a split point
    const parentOf = g => g.parent ? groups.find(o => o.id === g.parent) : null;
    const branchesOf = g => groups.filter(o => o.parent === g.id);
    const ownCount = g => g.units.reduce((a, u) => a + u.n, 0);
    const total = (g, d = 0) => ownCount(g) + (d > 6 ? 0 : branchesOf(g).reduce((a, b) => a + total(b, d + 1), 0));
    function offsetOf(b) {                     // how many vehicles of the parent's column are ahead of this branch
      const p = parentOf(b); let o = ownCount(p);
      for (const s of branchesOf(p)) if (s !== b && (s.splitAt > b.splitAt || (s.splitAt === b.splitAt && s.id < b.id))) o += total(s);
      return o;
    }
    function timeAtS(P, A) {                   // movement time at which the lead first reaches arc length A
      if (A <= 0) return 0; if (A > P.len + 1e-6) return null;
      let lo = 0, hi = P.S.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.S[m] < A) lo = m; else hi = m; }
      const f = (A - P.S[lo]) / (P.S[hi] - P.S[lo] || 1);
      return P.T[lo] + (P.T[hi] - P.T[lo]) * f;
    }
    const trail = b => b._rides ? 0 : offsetOf(b) * parentOf(b).gap;   // how far the parent's lead is past the split when this branch's lead gets there
    const splitNeed = b => { const p = parentOf(b); return p && p.prof && p.prof.wpS[b.splitAt] !== undefined ? p.prof.wpS[b.splitAt] + trail(b) : null; };
    function resolve(g, s) {                   // a point behind a branch's start lies on its parent's route
      let d = 0;
      while (s < 0 && g.parent && d++ < 8) { const p = parentOf(g); if (!p || !p.prof || p.prof.wpS[g.splitAt] === undefined) return null; s = p.prof.wpS[g.splitAt] + s; g = p; }
      if (s < 0 && g.carrier) return null;     // still aboard a ship
      return { g, s };
    }
    // when the group's lead starts moving (cargo: after its carrier arrives and unloads; branch: when its lead reaches the split)
    function startOf(g, depth = 0) {
      if (g.parent && depth <= 6) {
        const p = parentOf(g), A = splitNeed(g); if (!p || A === null) return null;
        const e = timeAtS(p.prof, A); if (e === null) return null;
        return realTimeAt(p, e, depth + 1);
      }
      const c = carrierOf(g);
      if (!c || depth > 5) return g.start;
      if (!c.prof) return null;
      const arr = realTimeAt(c, c.prof.dur, depth + 1);
      return arr === null ? null : arr + (g._qoff !== undefined ? g._qoff : (c.unload || 0) + g.start);
    }
    // instructor Halt / Resume: live actions, not part of the saved plan
    const halts = g => g.halts || (g.halts = []);
    const isHalted = g => { const h = halts(g); return h.length > 0 && h[h.length - 1].to === null; };
    function halt(g) { if (!isHalted(g)) halts(g).push({ from: simT(), to: null }); }
    function resume(g) { if (isHalted(g)) { const h = halts(g); h[h.length - 1].to = Math.max(h[h.length - 1].from, simT()); } }
    function moveTime(g, t) {                  // seconds of movement the lead has had by time t (<= 0 before start)
      const st = startOf(g); if (st === null) return null;
      let e = t - st; if (e <= 0) return e;
      for (const h of halts(g)) { const a = Math.max(h.from, st), b = Math.min(h.to === null ? t : h.to, t); if (b > a) e -= b - a; }
      return e;
    }
    function realTimeAt(g, E, depth = 0) {     // the clock time at which the lead has had E seconds of movement
      const st = startOf(g, depth); if (st === null) return null;
      let t = st, rem = E;
      const hs = halts(g).map(h => ({ a: Math.max(h.from, st), b: h.to === null ? Infinity : h.to })).filter(h => h.b > h.a).sort((x, y) => x.a - y.a);
      for (const h of hs) {
        if (h.a >= t + rem) break;
        if (h.a > t) { rem -= h.a - t; t = h.a; }
        if (h.b === Infinity) return Infinity;
        t = Math.max(t, h.b);
      }
      return t + rem;
    }
    function sAt(g, t) {                       // lead's arc length at time t (may be < 0 before start)
      if (g.parent) {
        const st = startOf(g);
        if (st === null || t < st) { const p = parentOf(g); if (!p || !p.prof || p.prof.wpS[g.splitAt] === undefined) return null;
          const sp = sAt(p, t); return sp === null ? null : Math.min(0, sp - trail(g) - p.prof.wpS[g.splitAt]); }
      }
      if (!g.prof) return g._rides ? 0 : null; // split from a line with no route drawn yet: waits on the front
      const dt = moveTime(g, t), P = g.prof; if (dt === null) return null;
      if (dt <= 0) return dt * 0;              // waiting at the start point
      if (dt >= P.dur) return P.len;
      let lo = 0, hi = P.T.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.T[m] <= dt) lo = m; else hi = m; }
      const f = (dt - P.T[lo]) / (P.T[hi] - P.T[lo] || 1);
      return P.S[lo] + (P.S[hi] - P.S[lo]) * f;
    }
    function posAt(g, s) {                     // point and heading at arc length s; behind the start, extend backwards
      const P = g.prof;
      if (s <= 0) {
        const dx = P.X[1] - P.X[0], dz = P.Z[1] - P.Z[0], L = Math.hypot(dx, dz) || 1;
        return { x: P.X[0] + dx / L * s, z: P.Z[0] + dz / L * s, hd: Math.atan2(dx, dz) };
      }
      let lo = 0, hi = P.S.length - 1;
      if (s >= P.len) lo = hi - 1;
      else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.S[m] <= s) lo = m; else hi = m; }
      const f = Math.min(1, (s - P.S[lo]) / (P.S[hi] - P.S[lo] || 1));
      const dx = P.X[hi] - P.X[lo], dz = P.Z[hi] - P.Z[lo];
      return { x: P.X[lo] + dx * f, z: P.Z[lo] + dz * f, hd: Math.atan2(dx, dz) };
    }
    function vehicles(g) { const out = []; for (const u of g.units) for (let i = 0; i < u.n; i++) out.push(u.type); return out; }

    // ---- 3D: one model (or placeholder box) per vehicle, a hostile diamond and label per group, draped route lines
    const root = new THREE.Group(); scene.add(root);
    // ---- wakes: each moving ship leaves a foam trail (widening, fading over a minute) and two Kelvin arms (~19 deg).
    //      Worked out from where the ship was over the last minute, so pause, 10x, halts and scrubbing just work.
    //      A swimming vehicle gets only a V (Lee, 2026-11-04): two fading wedges fixed to it, 6 vertices and no history, so
    //      every swimmer has one and a big wave costs almost nothing. Ships go first, up to WAKE_SHIPS; the rest is for the Vs.
    const WAKE_SHIPS = 9000, WAKE_MAX = 12000, WAKE_AGE = 60, WAKE_STEP = 3;
    const wakeGeo = new THREE.BufferGeometry(), wakePos = new Float32Array(WAKE_MAX * 3), wakeA = new Float32Array(WAKE_MAX);
    wakeGeo.setAttribute('position', new THREE.BufferAttribute(wakePos, 3).setUsage(THREE.DynamicDrawUsage));
    wakeGeo.setAttribute('a', new THREE.BufferAttribute(wakeA, 1).setUsage(THREE.DynamicDrawUsage));
    const wakeMesh = new THREE.Mesh(wakeGeo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'attribute float a; varying float va; void main(){ va = a; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying float va; void main(){ gl_FragColor = vec4(0.9, 0.94, 0.95, va); }'
    }));
    wakeMesh.frustumCulled = false; wakeMesh.renderOrder = 2; root.add(wakeMesh);
    function updateWakes(t) {
      let n = 0;
      const quad = (ax, az, bx, bz, cx, cz, dx, dz, a0, a1) => {      // a-b at one age, d-c at the next
        if (n + 6 > WAKE_SHIPS) return;
        for (const [x, z, a] of [[ax, az, a0], [bx, bz, a0], [cx, cz, a1], [ax, az, a0], [cx, cz, a1], [dx, dz, a1]]) {
          wakePos[n * 3] = x; wakePos[n * 3 + 1] = 0.3; wakePos[n * 3 + 2] = z; wakeA[n] = a; n++;
        }
      };
      for (const g of groups) {
        if (!g.prof || !isShip(g)) continue;
        const v = view.g.get(g.id); if (!v) continue;
        v.meshes.forEach((m, i) => {
          if (!m.visible || struckAt(g, i, t)) return;                     // a struck vehicle has stopped: no wake
          const T = VT[m.userData.t], pts = [];
          for (let k = 0; k * WAKE_STEP <= WAKE_AGE; k++) {
            const tk = t - k * WAKE_STEP, sk = sAt(g, tk - yldDelay(skey(g, i), tk)); if (sk === null) break;   // running late if it gave way
            const p = vehAt(g, i, sk); if (!p) break;
            const fx = Math.sin(p.hd), fz = Math.cos(p.hd);
            pts.push({ x: p.x - fx * T.L / 2, z: p.z - fz * T.L / 2, px: fz, pz: -fx });   // stern, and the sideways direction
          }
          if (pts.length < 3 || Math.hypot(pts[0].x - pts[2].x, pts[0].z - pts[2].z) < 4) return;   // not moving
          let d = 0;
          for (let k = 0; k < pts.length - 1; k++) {
            const A = pts[k], B = pts[k + 1], age0 = k * WAKE_STEP, age1 = age0 + WAKE_STEP;
            const d1 = d + Math.hypot(B.x - A.x, B.z - A.z);
            const f0 = 1 - age0 / WAKE_AGE, f1 = 1 - age1 / WAKE_AGE;
            const h0 = T.W * 0.5 + age0 * 0.22, h1 = T.W * 0.5 + age1 * 0.22;          // turbulent centre trail
            quad(A.x + A.px * h0, A.z + A.pz * h0, A.x - A.px * h0, A.z - A.pz * h0, B.x - B.px * h1, B.z - B.pz * h1, B.x + B.px * h1, B.z + B.pz * h1, 0.85 * f0, 0.85 * f1);
            for (const side of [1, -1]) {                                              // Kelvin arms
              const l0 = T.W * 0.5 + d * 0.34, l1 = T.W * 0.5 + d1 * 0.34, w0 = T.W * 0.2 + age0 * 0.08, w1 = T.W * 0.2 + age1 * 0.08;
              const ax = A.x + A.px * l0 * side, az = A.z + A.pz * l0 * side, bx = B.x + B.px * l1 * side, bz = B.z + B.pz * l1 * side;
              quad(ax + A.px * w0, az + A.pz * w0, ax - A.px * w0, az - A.pz * w0, bx - B.px * w1, bz - B.pz * w1, bx + B.px * w1, bz + B.pz * w1, 0.6 * f0, 0.6 * f1);
            }
            d = d1;
          }
        });
      }
      const vert = (x, z, a) => { wakePos[n * 3] = x; wakePos[n * 3 + 1] = 0.3; wakePos[n * 3 + 2] = z; wakeA[n] = a; n++; };
      for (const g of groups) {                // swimming vehicles: a V from the bow
        if (isShip(g)) continue;
        const v = view.g.get(g.id); if (!v) continue;
        let moving = null;                     // the same for the whole group; only asked once one of them is in the water
        v.meshes.forEach((m, i) => {
          const T = VT[m.userData.t];
          if (!T.amph || !m.visible || n + 6 > WAKE_MAX || !m.userData.wet) return;
          if (moving === null) { const a = sAt(g, t), b = sAt(g, t - 2); moving = a !== null && b !== null && Math.abs(a - b) > 1; }
          if (!moving || struckAt(g, i, t)) return;
          const fx = Math.sin(m.rotation.y), fz = Math.cos(m.rotation.y), len = T.L * 4, ax = m.position.x + fx * T.L / 2, az = m.position.z + fz * T.L / 2;
          for (const side of [1, -1]) {        // each arm a wedge: a point at the bow, opening and fading to nothing behind it
            const h = len * 0.34 * side, w = len * 0.05, tx = ax - fx * len + fz * h, tz = az - fz * len - fx * h;
            vert(ax, az, 0.65); vert(tx + fz * w, tz - fx * w, 0); vert(tx - fz * w, tz + fx * w, 0);
          }
        });
      }
      wakeGeo.setDrawRange(0, n); wakeGeo.attributes.position.needsUpdate = true; wakeGeo.attributes.a.needsUpdate = true;
    }
    const lines = new THREE.Group(); scene.add(lines);
    const handles = new THREE.Group(); scene.add(handles);
    const boxGeo = {}, boxMat = {};
    for (const k of Object.keys(VT)) {
      boxGeo[k] = new THREE.BoxGeometry(VT[k].W, VT[k].H, VT[k].L);
      boxMat[k] = new THREE.MeshLambertMaterial({ color: VT[k].ship ? 0x7a2a22 : 0xc8402c });
    }
    // Real models replace a type's boxes once loaded; until then (or if loading fails) the box stays.
    // Files are glTF binaries (pivot at bottom centre, metres, nose toward +Z) under neutral names:
    // purchased models are licensed for use inside the trainer only and must not be offered as downloads.
    const MODELS = { zbd: { url: 'data/m01.bin', yaw: -Math.PI / 2 }, fuel: { url: 'data/m02.bin', yaw: 0 }, lcu: { url: 'data/m03.bin', yaw: Math.PI }, roro: { url: 'data/m04.bin', yaw: 0 }, eng: { url: 'data/m05.bin', yaw: -Math.PI / 2 }, plz: { url: 'data/m06.bin', yaw: 0 }, ztd: { url: 'data/m07.bin', yaw: 0 }, hq17: { url: 'data/m12.bin', yaw: 0 }, inf: { url: 'data/m13.bin', yaw: 0 } }, tmpl = {};   // yaw turns the model's nose onto +Z
    function makeBody(t) {
      if (VT[t].foot) return new THREE.Object3D();     // soldiers are drawn by footMesh; this is only their place in the column
      if (!tmpl[t]) return new THREE.Mesh(boxGeo[t], boxMat[t]);
      const o = tmpl[t].clone(); o.position.y = -VT[t].H / 2; o.rotation.y = MODELS[t].yaw || 0; return o;   // container sits at H/2; model pivot on the ground
    }
    function makeVeh(t) { const c = new THREE.Group(); c.userData.t = t; c.add(makeBody(t)); return c; }
    // ---- far vehicles (2026-11-04, perf): a model costs 21-26k triangles and a draw per part even when it is under a pixel.
    //      Once a vehicle is under FAR_IN pixels long in every camera it becomes one box of its model's average colour, all in
    //      one instanced mesh. Its group stays visible and placed as usual, so strikes, UAS and wakes see no difference.
    const FAR_IN = 3, FAR_OUT = 3.6, farCol = {}, farC = new THREE.Color(), farD = new THREE.Object3D();
    let farCap = 256, farMesh = null;
    function farMake() {
      const old = farMesh;
      farMesh = new THREE.InstancedMesh(old ? old.geometry : new THREE.BoxGeometry(1, 1, 1), old ? old.material : new THREE.MeshLambertMaterial({ color: 0xffffff }), farCap);
      farMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(farCap * 3).fill(1), 3);
      if (old) { farMesh.instanceMatrix.array.set(old.instanceMatrix.array); farMesh.instanceColor.array.set(old.instanceColor.array); root.remove(old); old.dispose(); }
      farMesh.frustumCulled = false; farMesh.count = 0; root.add(farMesh);
    }
    function averageColour(o) {                // triangle-weighted average of a model's colours and textures, linear
      const out = new THREE.Color(0, 0, 0), c2 = document.createElement('canvas'); c2.width = c2.height = 8;
      const g = c2.getContext('2d', { willReadFrequently: true }), one = new THREE.Color(); let W = 0;
      o.traverse(m => { if (!m.isMesh) return;
        const mats = [].concat(m.material), n = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
        for (const x of mats) {
          one.setRGB(1, 1, 1); if (x.color) one.copy(x.color);
          if (x.map && x.map.image) { try { g.drawImage(x.map.image, 0, 0, 8, 8); const d = g.getImageData(0, 0, 8, 8).data; let r = 0, gr = 0, b = 0; for (let i = 0; i < 256; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
            const tx = new THREE.Color(r / 64 / 255, gr / 64 / 255, b / 64 / 255).convertSRGBToLinear(); one.multiply(tx); } catch (e) { /* unreadable texture: the material colour alone is fine */ } }
          out.r += one.r * n / mats.length; out.g += one.g * n / mats.length; out.b += one.b * n / mats.length; W += n / mats.length;
        } });
      return W ? out.multiplyScalar(1 / W) : null;
    }
    function farColour(t) {
      if (tmpl[t] && !farCol[t]) farCol[t] = averageColour(tmpl[t]) || boxMat[t].color;
      return farCol[t] || boxMat[t].color;
    }
    function farTick(cams) {
      if (!farMesh) farMake();
      const hpx = renderer.domElement.height, ks = cams.map(c => hpx / (2 * Math.tan(c.fov * Math.PI / 360)));
      let n = 0;
      for (const [, v] of view.g) for (const m of v.meshes) {
        const body = m.children[0], T = VT[m.userData.t]; if (!m.visible || !body || T.foot) continue;
        let px = 0; const L = Math.max(T.L, T.W);
        cams.forEach((c, i) => { px = Math.max(px, L * ks[i] / Math.max(1, c.position.distanceTo(m.position))); });
        const far = px < (m.userData.far ? FAR_OUT : FAR_IN); m.userData.far = far; body.visible = !far;
        if (!far) continue;
        if (n === farCap) { farCap *= 2; farMake(); }
        farD.position.copy(m.position); farD.rotation.set(0, m.rotation.y, 0); farD.scale.set(T.W, T.H, T.L); farD.updateMatrix(); farMesh.setMatrixAt(n, farD.matrix);
        farC.copy(farColour(m.userData.t)); if (m.userData.charred) farC.multiplyScalar(0.18); farMesh.setColorAt(n, farC); n++;
      }
      farMesh.count = n; farMesh.instanceMatrix.needsUpdate = true; farMesh.instanceColor.needsUpdate = true;
    }
    // models load on first use (perf/memory, 2026-11-03): a type's file is fetched when a group first contains it
    const asked = new Set();
    function needModel(t) {
      if (asked.has(t) || !MODELS[t] || !THREE.GLTFLoader) return; asked.add(t);
      new THREE.GLTFLoader().load(MODELS[t].url, gl => {
        if (VT[t].foot) { gl.scene.traverse(o => { if (o.isMesh) foot.setModel(o.geometry); }); return; }
        tmpl[t] = gl.scene;
        for (const [, v] of view.g) for (const c of v.meshes) if (c.userData.t === t) { c.clear(); c.add(makeBody(t)); }
      }, undefined, e => console.warn('Vehicle model failed to load; keeping boxes:', t, e));
    }
    // ---- soldiers (Lee, 2026-11-04): one instanced mesh for all of them, so hundreds cost one draw call. Rebuilt each tick.
    const foot = (() => {
      const box = boxGeo.inf.clone().translate(0, VT.inf.H / 2, 0), dummy = new THREE.Object3D();
      let geo = box, mat = boxMat.inf, cap = 256, n = 0, mesh = null;
      function make() {
        const old = mesh; mesh = new THREE.InstancedMesh(geo, mat, cap); mesh.frustumCulled = false; mesh.count = n;
        if (old) { mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, n * 16)); root.remove(old); old.dispose(); }
        root.add(mesh);
      }
      make();
      return {
        setModel(g) { geo = g; mat = new THREE.MeshLambertMaterial({ vertexColors: true }); make(); },
        begin() { n = 0; },
        add(x, y, z, hd, down) {               // down: struck, lying where he fell
          if (n === cap) { cap *= 2; make(); }
          dummy.position.set(x, y, z); dummy.rotation.set(down ? -Math.PI / 2 : 0, hd, 0, 'YXZ'); dummy.updateMatrix(); mesh.setMatrixAt(n++, dummy.matrix);
        },
        end() { mesh.count = n; if (n) mesh.instanceMatrix.needsUpdate = true; }
      };
    })();
    // ---- pips (Lee, 2026-11-04): a small screen-sized diamond on every enemy vehicle and soldier, so the instructor sees the
    //      whole spread, not just one symbol per group. One Points object, one draw call, no texture; the positions are the
    //      ones tick works out anyway. Size in CSS pixels: negative means struck (grey). They fade out close up, where the
    //      model itself is plain to see. Same colours as the group diamond, which draws on top.
    const PIP_VEH = 9, PIP_FOOT = 5;
    const pips = (() => {
      let cap = 1024, n = 0, pos, size;
      const geo = new THREE.BufferGeometry();
      const obj = new THREE.Points(geo, new THREE.ShaderMaterial({
        depthTest: false, depthWrite: false, transparent: true,
        uniforms: { uPR: { value: renderer.getPixelRatio() } },
        vertexShader: `attribute float aS; uniform float uPR; varying float vDead, vFade, vPx;
          void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
            vDead = aS < 0.0 ? 1.0 : 0.0; vFade = clamp((-mv.z - 250.0) / 250.0, 0.0, 1.0); vPx = abs(aS) * uPR; gl_PointSize = vPx; }`,
        fragmentShader: `varying float vDead, vFade, vPx;
          void main() { vec2 q = abs(gl_PointCoord - 0.5); float d = (q.x + q.y) * vPx, r = vPx * 0.5;   // d, r: pixels from the centre
            float a = clamp(r - d, 0.0, 1.0) * vFade; if (a <= 0.0) discard;
            vec3 fill = mix(vec3(1.0, 0.416, 0.333), vec3(0.62, 0.62, 0.60), vDead);
            gl_FragColor = vec4(mix(vec3(0.165, 0.043, 0.027), fill, clamp(r - 1.2 - d, 0.0, 1.0)), a);
            #include <encodings_fragment>
          }`
      }));
      function alloc() {
        pos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
        size = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
        geo.dispose(); geo.setAttribute('position', pos); geo.setAttribute('aS', size);
      }
      alloc(); obj.frustumCulled = false; obj.renderOrder = 19; root.add(obj);
      return { obj,
        begin() { n = 0; },
        add(x, y, z, px) {
          if (n === cap) { const p = pos.array, s = size.array; cap *= 2; alloc(); pos.array.set(p); size.array.set(s); }
          const a = pos.array, i = n * 3; a[i] = x; a[i + 1] = y; a[i + 2] = z; size.array[n++] = px;
        },
        end(show) {
          obj.visible = show && n > 0; if (!obj.visible) return;
          geo.setDrawRange(0, n); pos.updateRange.count = n * 3; size.updateRange.count = n; pos.needsUpdate = size.needsUpdate = true;
        }
      };
    })();
    const diamondTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
      x.translate(32, 32); x.rotate(Math.PI / 4); x.fillStyle = 'rgba(255,106,85,.9)'; x.strokeStyle = '#2a0b07'; x.lineWidth = 4;
      x.fillRect(-17, -17, 34, 34); x.strokeRect(-17, -17, 34, 34); return new THREE.CanvasTexture(c); })();
    const handleTex = (fill) => { const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d');
      x.fillStyle = fill; x.strokeStyle = '#11140f'; x.lineWidth = 4; x.fillRect(5, 5, 22, 22); x.strokeRect(5, 5, 22, 22); return new THREE.CanvasTexture(c); };
    const hTexPt = handleTex('#d6b25a'), hTexSel = handleTex('#ffffff'), hTexMid = handleTex('rgba(214,178,90,.35)');
    const hTexFam = handleTex('rgba(255,106,85,.6)'), hTexJoin = handleTex('#6fb4ff');
    const labelLayer = document.createElement('div'); labelLayer.id = 'oplabels'; document.body.insertBefore(labelLayer, document.getElementById('labels'));
    const view = { g: new Map() };            // group id -> { meshes, sym, label }

    // ---- struck vehicles (Lee, 2026-11-02): one outcome — struck or not struck. A struck vehicle stops where it was
    //      hit, for good, and burns: model charred, fire on it, a smoke column drifting downwind. The rest of its column
    //      drives on past it (the Fire Mission Sim's rule: wrecks block nobody) until bypass logic arrives with
    //      buildings-as-solid. State is keyed group id : slot in the column, and lives outside the meshes, so route
    //      edits and model loads don't lose it. Everything animates on sim time (pause freezes the fire too).
    const struck = new Map();                  // 'gid:i' -> { t, x, z, hd, cause, fx }
    const skey = (g, i) => g.id + ':' + i;
    const struckAt = (g, i, t) => { const w = struck.get(skey(g, i)); return w && t >= w.t ? w : null; };
    // ---- dismounts (Lee, 2026-11-04): each ZBD lets out a squad as it comes ashore, without stopping. They walk its route
    //      and stay on the beach side of any later water. Like vehicles, a soldier is a pure function of the clock. Each has
    //      his own slot number after the group's vehicles, so struck soldiers use the same state as struck vehicles.
    const SQUAD = VT.inf.squad, EXIT_STEP = 3, SPREAD = 9;     // metres between exits along the route; metres out to each side
    const dmSlot = (g, i) => { const V = vehicles(g), k = i - V.length, v = Math.floor(k / SQUAD); return k >= 0 && VT[V[v]] && VT[V[v]].dismount ? { v, j: k % SQUAD } : null; };
    const slotType = (g, i) => { const V = vehicles(g); return i < V.length ? V[i] : dmSlot(g, i) ? 'inf' : undefined; };
    const vName = (g, i) => { const d = i >= vehicles(g).length && dmSlot(g, i); return d ? 'Soldier ' + (d.j + 1) + ' of ' + VT[vehicles(g)[d.v]].name + ' ' + (d.v + 1) + ', ' + g.name : VT[vehicles(g)[i]].name + ' ' + (i + 1) + ' of ' + g.name; };
    function ashore(g) {                       // per vehicle: { S, end } lead arc length where it comes ashore and where the dry ground ends; worked out once per route edit
      const P = g.prof; if (!P) return []; if (P.ashore) return P.ashore;
      const out = P.ashore = [], V = vehicles(g), p = parentOf(g);
      if (!V.some(t => VT[t].dismount)) return out;
      const from = p && p.prof && p.prof.wpS[g.splitAt] !== undefined ? -(p.prof.wpS[g.splitAt] + trail(g)) : 0;
      V.forEach((t, i) => {
        if (!VT[t].dismount) return;
        const wetAt = s => { const q = vehAt(g, i, s); return !q || waterAt(q.x, q.z); };
        let wet = !!g.carrier, S = null;       // off a ship counts as coming ashore
        for (let s = from; s <= P.len && S === null; s += 10) {
          if (wet && !wetAt(s) && !wetAt(s + 15) && !wetAt(s + 30)) S = s; else if (vehAt(g, i, s)) wet = wetAt(s);   // 30 m of land: a sandbar is not the beach
        }
        if (S === null) return;
        let end = P.len; for (let s = S; s <= P.len; s += 10) if (wetAt(s) && wetAt(s + 30) && wetAt(s + 60)) { end = s; break; }   // 60 m of it: a low patch is not the next water
        out[i] = { S: Math.min(S + 30, end), end };
      });
      return out;
    }
    function clockAtS(g, s, d = 0) {           // the clock time when the lead reaches arc length s (behind a branch's start: on its parent)
      if (s < 0 && g.parent && d < 8) { const p = parentOf(g); return p && p.prof && p.prof.wpS[g.splitAt] !== undefined ? clockAtS(p, s + p.prof.wpS[g.splitAt] + trail(g), d + 1) : null; }
      const e = g.prof ? timeAtS(g.prof, s) : null; return e === null ? null : realTimeAt(g, e);
    }
    function holdsFor(g) {                     // every scripted hold on the way, in this group's arc lengths: its own, and its parent's before the split
      const P = g.prof; if (P.dHolds) return P.dHolds;
      const out = P.stops.map(o => ({ s: o.s, g, t1: o.t1 })), p = parentOf(g);
      if (p && p.prof && p.prof.wpS[g.splitAt] !== undefined) { const back = p.prof.wpS[g.splitAt] + trail(g);
        for (const o of holdsFor(p)) if (o.s < back) out.push({ s: o.s - back, g: o.g, t1: o.t1 }); }
      return P.dHolds = out.sort((x, y) => x.s - y.s);
    }
    // a soldier walks on at his own pace. He stops at a hold only if his vehicle is still there when he arrives, and walks on
    // when it leaves; if it has already gone, he walks straight through. Still a pure function of the clock.
    function soldierS(s0, w, t, tj, holds, rel, j) {
      let at = s0, clock = tj;
      for (let k = 0; k < holds.length; k++) {
        if (holds[k].s < s0 - j * EXIT_STEP || rel[k] === null) continue;      // behind where this vehicle landed
        const tgt = Math.max(at, holds[k].s - (SQUAD - 1 - j) * EXIT_STEP), arrive = clock + (tgt - at) / w;
        if (arrive >= rel[k]) continue;
        if (t <= arrive) break;
        if (t < rel[k]) return tgt;
        at = tgt; clock = rel[k];
      }
      return at + w * (t - clock);
    }
    function eachDismount(g, t, fn) {          // fn(slot, x, z, hd, struck) for every soldier out of his vehicle at time t
      const A = ashore(g), first = vehicles(g).length, ride = Math.max(1, g.land) / 3.6, walk = VT.inf.land / 3.6;
      if (!A.length) return;
      const holds = holdsFor(g), rel = holds.map(o => realTimeAt(o.g, o.t1));
      const dl = g.prof.delay;
      A.forEach((a, i) => {
        const d = dl && dl[i] || 0, tc0 = clockAtS(g, a.S), tc = tc0 === null ? null : tc0 + d; if (tc === null || t < tc) return;
        const relI = d ? rel.map(x => x === null ? null : x + d) : rel;             // this vehicle runs on a delayed clock
        const hit = struckAt(g, i, t); if (hit && hit.t < tc) return;          // burnt out before it landed: nobody gets out
        for (let j = 0; j < SQUAD; j++) {
          const slot = first + i * SQUAD + j, w = struckAt(g, slot, t);
          if (w) { fn(slot, w.x, w.z, w.hd, true); continue; }
          const tj = tc + j * EXIT_STEP / ride; if (t < tj) break;             // he gets out where the vehicle is, as it passes
          const id = i * SQUAD + j, s = Math.min(soldierS(a.S + j * EXIT_STEP, walk * (0.9 + 0.2 * rnd(g, id, 4)), t, tj, holds, relI, j), Math.max(a.end, a.S + SQUAD * EXIT_STEP) - (SQUAD - 1 - j) * EXIT_STEP);
          const q = vehAt(g, i, s); if (!q) continue;
          const side = (rnd(g, id, 5) - 0.5) * 2 * SPREAD * Math.min(1, (t - tj) / 5), x = q.x + Math.cos(q.hd) * side, z = q.z - Math.sin(q.hd) * side;
          if (waterAt(x, z)) fn(slot, q.x, q.z, q.hd, false); else fn(slot, x, z, q.hd, false);
        }
      });
    }
    // ---- spacing (Lee, 2026-11-11): no vehicle drives into or through another. Paths are worked out per group, so a line's
    //      vehicles converging on a point, or two groups crossing, used to overlap by up to 4 m. Each frame, after every
    //      vehicle is placed, overlapping pairs are pushed apart to SEP_MIN clear of each other. A light touch pushes along the
    //      line between them (the one behind holds back); the deeper they are into each other, the more the push turns to each
    //      one's own right, so a vehicle whose path runs through another's slides round it instead of popping through.
    //      Everything in the push varies smoothly with the clock, so nothing jumps. Stateless: same time, same places.
    //      Wrecks don't move; a push into a building goes to the other vehicle.
    //      Soldiers are left out (cheap to overlap, many of them); ships only space against ships, so cargo can leave its ship.
    const SEP_PASSES = 4, SEP_CELL = 24, SEP_TURN = 3;   // SEP_MIN sits with FRONT_SPACING; SEP_TURN: how hard a deep overlap turns the push sideways
    let placedT = null, placedN = -1, placedList = null, placedMap = null;
    function sepAxes(A, B) {                   // A's and B's axes: per axis the centre offset c and the room D it needs; null if already clear
      const ax = [];
      for (const P of [A, B]) for (let k = 0; k < 2; k++) {
        const nx = k ? Math.cos(P.hd) : Math.sin(P.hd), nz = k ? -Math.sin(P.hd) : Math.cos(P.hd);
        const r = Q => Q.L / 2 * Math.abs(Math.sin(Q.hd) * nx + Math.cos(Q.hd) * nz) + Q.W / 2 * Math.abs(Math.cos(Q.hd) * nx - Math.sin(Q.hd) * nz);
        const c = (B.x - A.x) * nx + (B.z - A.z) * nz, D = r(A) + r(B) + SEP_MIN;
        if (Math.abs(c) >= D) return null;     // a separating axis with room to spare
        ax.push({ nx, nz, c, D });
      }
      return ax;
    }
    function sepPush(ax, u) {                  // how far B must move along u to clear A on some axis
      let best = Infinity;
      for (const n of ax) { const k = u.x * n.nx + u.z * n.nz; if (Math.abs(k) < 1e-3) continue;
        best = Math.min(best, k > 0 ? (n.D - n.c) / k : (n.D + n.c) / -k); }
      return best;
    }
    function separate(V) {
      const live = V.filter(v => !v.foot), C = live.reduce((m, v) => Math.max(m, 2 * v.R + SEP_MIN), SEP_CELL);   // cells at least one pair wide (a RoRo is 150 m)
      for (let pass = 0; pass < SEP_PASSES; pass++) {
        const cells = new Map(), key = (c, r) => c * 100003 + r;
        for (const v of live) { const k = key(Math.floor(v.x / C), Math.floor(v.z / C)); const a = cells.get(k); if (a) a.push(v); else cells.set(k, [v]); }
        let moved = false;
        for (const [k, A0] of cells) {
          const c = Math.round(k / 100003), r = k - c * 100003;
          for (let dc = 0; dc <= 1; dc++) for (let dr = dc ? -1 : 0; dr <= 1; dr++) {   // each neighbouring pair of cells once
            const B0 = dc || dr ? cells.get(key(c + dc, r + dr)) : A0; if (!B0) continue;
            for (let a = 0; a < A0.length; a++) for (let b = B0 === A0 ? a + 1 : 0; b < B0.length; b++) {
              let A = A0[a], B = B0[b];
              if (A.ship !== B.ship || (A.struck && B.struck)) continue;
              const reach = A.R + B.R + SEP_MIN; if (Math.abs(B.x - A.x) > reach || Math.abs(B.z - A.z) > reach) continue;
              if (A.key > B.key) { const q = A; A = B; B = q; }   // fixed roles, whatever cells they fall in
              const ax = sepAxes(A, B); if (!ax) continue;
              // direction for B (A takes the opposite): A to B, plus a turn to B's own right that grows with the depth
              let deep = Infinity; for (const n of ax) deep = Math.min(deep, n.D - Math.abs(n.c));
              // (B's right by its own heading, so an overtake or a head-on pass goes round on a fixed side, never flipping as their centres pass)
              // (the A-to-B part fades as their centres meet, so it can't flip there either)
              const dx = B.x - A.x, dz = B.z - A.z, dL = Math.max(Math.hypot(dx, dz), (A.L + B.L) / 4), w = SEP_TURN * Math.min(1, deep / ((A.W + B.W) / 2));
              let mx = dx / dL + Math.cos(B.hd) * w, mz = dz / dL - Math.sin(B.hd) * w, mL = Math.hypot(mx, mz);
              if (mL < 1e-3) { mx = Math.cos(B.hd); mz = -Math.sin(B.hd); mL = 1; }
              const m = { x: mx / mL, z: mz / mL }, d = sepPush(ax, m);
              const s = { d: (isFinite(d) ? d : deep) + 0.05, nx: m.x, nz: m.z };   // a hair over, so a later push in the same pass rarely leaves it short
              let wa = A.fix > B.fix ? 0 : B.fix > A.fix ? 1 : 0.5;   // the one moving goes round the one standing
              if (wa > 0 && wa < 1 && !A.ship && CITY.ready) {   // don't shove one into a building: the other takes the push
                const inA = CITY.solidAt(A.x - s.nx * s.d / 2, A.z - s.nz * s.d / 2), inB = CITY.solidAt(B.x + s.nx * s.d / 2, B.z + s.nz * s.d / 2);
                if (inA && !inB) wa = 0; else if (inB && !inA) wa = 1;
              }
              A.x -= s.nx * s.d * wa; A.z -= s.nz * s.d * wa; B.x += s.nx * s.d * (1 - wa); B.z += s.nz * s.d * (1 - wa); moved = true;
            }
          }
        }
        if (!moved) break;
      }
    }
    // ---- yielding (Lee, 2026-11-11): a vehicle whose next step would run it into another waits instead, and its own plan
    //      runs late by that much. Worked out by stepping the whole scenario on a fixed YLD_DT grid from T+0, one step at a
    //      time, kept as a per-vehicle table of how late it is (yld.D). A frame reads the table: the clock still decides
    //      everything (pause, 10x, scrubbing back), and the steps are only computed as the clock first reaches them, so
    //      normally a fraction of a step per frame. Route edits start the table again; a halt, resume or strike only
    //      throws away the steps after it. The one moving in is the one that waits; two waiting on each other: the higher
    //      key goes and the push below (separate) lets it squeeze by. Nobody waits for a vehicle whose group has finished its
    //      route (parked for good): it squeezes by at once. After YLD_GIVEUP seconds behind something else that doesn't clear
    //      (a halted vehicle on its road), it squeezes by the same way. Wrecks block nobody.
    const YLD_DT = 0.25, YLD_MUTUAL = 2, YLD_GIVEUP = 30;
    const yld = { k: 0, list: null, D: new Map(), W: new Map(), B: new Map(), posK: -1, pos: null, profs: [], halts: [], struck: new Map() };
    function rawPos(g, i, t) {                 // where vehicle i of g stands at time t by its own plan; null off the ground
      const st0 = startOf(g); if (g.carrier && (st0 === null || t < st0)) return null;
      const s0 = sAt(g, t); if (s0 === null) return null;
      return vehAt(g, i, vehS(g, i, t, s0));
    }
    const parked = (g, t) => { const s = sAt(g, t); return !!g.prof && s !== null && s >= g.prof.len; };   // its group has finished its route
    const ovl = (A, B) => { const ax = sepAxes(A, B); if (!ax) return 0; let d = Infinity; for (const n of ax) d = Math.min(d, n.D - Math.abs(n.c)); return d; };
    function yldCheck() {                      // what changed since the table was worked out, and from when it is now wrong
      let reset = groups.length !== yld.profs.length;
      for (let k = 0; k < groups.length && !reset; k++) if (groups[k].prof !== yld.profs[k]) reset = true;
      for (const [k, w] of yld.struck) if (struck.get(k) !== w) reset = true;   // a wreck cleared
      if (reset) {
        yld.profs = groups.map(g => g.prof); yld.k = 0; yld.list = null; yld.D.clear(); yld.W.clear(); yld.B.clear(); yld.posK = -1;
        yld.halts = groups.map(g => JSON.stringify(halts(g))); yld.struck = new Map(struck); return;
      }
      let from = Infinity;
      groups.forEach((g, k) => { const h = JSON.stringify(halts(g)); if (h !== yld.halts[k]) { yld.halts[k] = h; from = Math.min(from, simT()); } });
      for (const [k, w] of struck) if (!yld.struck.has(k)) { yld.struck.set(k, w); from = Math.min(from, w.t); }
      if (from < Infinity) { yld.k = Math.min(yld.k, Math.max(0, Math.floor(from / YLD_DT) - 1)); yld.posK = -1; }
    }
    function yldStep() {                       // step k -> k + 1
      const k = yld.k, t0 = k * YLD_DT, t1 = t0 + YLD_DT;
      if (!yld.list) {
        yld.list = [];
        for (const g of groups) vehicles(g).forEach((type, i) => { const T = VT[type]; if (T.foot) return;
          const key = skey(g, i); yld.list.push({ g, i, key, L: T.L, W: T.W, R: Math.hypot(T.L, T.W) / 2, ship: !!T.ship });
          yld.D.set(key, [0]); yld.W.set(key, [0]); yld.B.set(key, ['']); });
      }
      const L = yld.list, C = L.reduce((m, v) => Math.max(m, 2 * v.R + SEP_MIN + 8), SEP_CELL), cell = (x, z) => Math.floor(x / C) * 100003 + Math.floor(z / C);
      if (yld.posK !== k) {                    // where everyone stands at step k
        yld.pos = new Map();
        for (const v of L) { if (struckAt(v.g, v.i, t0)) continue; const tv = t0 - yld.D.get(v.key)[k], p = rawPos(v.g, v.i, tv);
          if (p) yld.pos.set(v.key, { x: p.x, z: p.z, hd: p.hd, L: v.L, W: v.W, R: v.R, ship: v.ship, key: v.key, park: parked(v.g, tv) }); }
      }
      const cells = new Map();
      for (const b of yld.pos.values()) { const c = cell(b.x, b.z), a = cells.get(c); if (a) a.push(b); else cells.set(c, [b]); }
      const next = new Map(), blockerNow = new Map();
      for (const v of L) {
        const D = yld.D.get(v.key), W = yld.W.get(v.key), Bk = yld.B.get(v.key), d = D[k], w = W[k], p = yld.pos.get(v.key);
        if (struckAt(v.g, v.i, t1)) { D[k + 1] = d; W[k + 1] = 0; Bk[k + 1] = ''; if (p) p.gone = true; continue; }   // a wreck: blocks nobody
        const q = rawPos(v.g, v.i, t1 - d);
        if (!q) { D[k + 1] = d; W[k + 1] = 0; Bk[k + 1] = ''; if (p) p.gone = true; continue; }
        const cand = { x: q.x, z: q.z, hd: q.hd, L: v.L, W: v.W, R: v.R, ship: v.ship, key: v.key, park: parked(v.g, t1 - d) };
        let by = '';
        if (p) {
          const c0 = Math.floor(cand.x / C), r0 = Math.floor(cand.z / C);
          search: for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) for (const o of cells.get((c0 + dc) * 100003 + r0 + dr) || []) {
            if (o.key === v.key || o.gone || o.park || o.ship !== v.ship) continue;
            const reach = o.R + v.R + SEP_MIN; if (Math.abs(o.x - cand.x) > reach || Math.abs(o.z - cand.z) > reach) continue;
            const dn = ovl(cand, o); if (dn > 0 && dn > ovl(p, o) + 1e-3) { by = o.key; break search; }
          }
        }
        let go = !by;
        if (by) {
          const theirs = blockerNow.has(by) ? blockerNow.get(by) : yld.B.get(by)[k];
          go = theirs === v.key ? v.key > by && w >= YLD_MUTUAL : w >= YLD_GIVEUP;
        }
        D[k + 1] = go ? d : d + YLD_DT; W[k + 1] = by ? w + YLD_DT : 0; Bk[k + 1] = go ? '' : by; blockerNow.set(v.key, Bk[k + 1]);
        const b = go ? cand : p; next.set(v.key, b);
        if (p && b !== p) { p.x = b.x; p.z = b.z; p.hd = b.hd; p.park = b.park; }   // moved: others this step see where it went (same cell or the next)
        else if (!p) { const c = cell(b.x, b.z), a = cells.get(c); if (a) a.push(b); else cells.set(c, [b]); }
      }
      for (const b of next.values()) delete b.gone;
      yld.pos = next; yld.posK = k + 1; yld.k = k + 1;
    }
    // Catching up a long way (a route edited late in a run, the clock jumped forward) is spread over frames, YLD_BUDGET ms
    // each; until it is done, vehicles past the worked-out steps keep the lateness they had there.
    const YLD_BUDGET = 6;
    let yldFrame = -1, yldUntil = 0;
    function yldCatchUp(K, all) {
      const now = performance.now();
      if (yldFrame !== tickN) { yldFrame = tickN; yldCheck(); yldUntil = now + YLD_BUDGET; }
      while (yld.k < K && (all || yld.k === 0 || performance.now() < yldUntil)) yldStep();
    }
    function yldDelay(key, t) {                // how late vehicle `key` is running at time t
      if (t <= 0) return 0;
      const K = t / YLD_DT, k0 = Math.floor(K);
      yldCatchUp(k0 + 1);
      const a = yld.D.get(key); if (!a) return 0;
      if (k0 >= yld.k) return a[yld.k] || 0;
      const d0 = a[k0] || 0, d1 = a[k0 + 1] === undefined ? d0 : a[k0 + 1];
      return d0 + (d1 - d0) * (K - k0);
    }
    function placeAll(t) {                     // every vehicle on the ground at time t, spaced; cached for the frame
      if (placedT === t && placedN === tickN) return placedList;
      const out = [], map = new Map();
      for (const g of groups) {
        const st0 = startOf(g); if (g.carrier && (st0 === null || t < st0)) continue;
        if (sAt(g, t) === null) continue;
        vehicles(g).forEach((type, i) => {
          const w = struckAt(g, i, t), tv = VT[type].foot ? t : t - yldDelay(skey(g, i), t), p = w || rawPos(g, i, tv); if (!p) return;
          const T = VT[type], v = { g, i, type, key: skey(g, i), x: p.x, z: p.z, hd: p.hd, struck: !!w, L: T.L, W: T.W, R: Math.hypot(T.L, T.W) / 2, ship: !!T.ship, foot: !!T.foot,
            fix: w ? 1 : 0 };                  // a wreck never moves; a parked one makes room, which looks better than the other being thrown round it
          out.push(v); map.set(v.key, v);
        });
      }
      separate(out);
      placedT = t; placedN = tickN; placedList = out; placedMap = map;
      return out;
    }
    function vehiclesAt(t) {                   // every vehicle on the ground at time t (not aboard a ship), struck ones where they stopped
      const out = placeAll(t).map(v => ({ g: v.g, i: v.i, type: v.type, key: v.key, x: v.x, z: v.z, hd: v.hd, struck: v.struck }));
      for (const g of groups) {
        const st0 = startOf(g); if (g.carrier && (st0 === null || t < st0)) continue;
        const s0 = sAt(g, t); if (s0 === null) continue;
        eachDismount(g, t, (i, x, z, hd, down) => out.push({ g, i, type: 'inf', key: skey(g, i), x, z, hd, struck: down }));
      }
      return out;
    }
    const fxRoot = new THREE.Group(); scene.add(fxRoot);   // world effects: seen whatever the Enemy switch says
    const puffTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
      const gr = x.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    const flameTex = (() => { const c = document.createElement('canvas'); c.width = 64; c.height = 128; const x = c.getContext('2d');
      const gr = x.createRadialGradient(32, 92, 2, 32, 80, 60); gr.addColorStop(0, 'rgba(255,255,230,1)'); gr.addColorStop(0.25, 'rgba(255,200,90,.95)'); gr.addColorStop(0.6, 'rgba(255,110,20,.6)'); gr.addColorStop(1, 'rgba(255,60,0,0)');
      x.fillStyle = gr; x.beginPath(); x.moveTo(32, 2); x.bezierCurveTo(62, 60, 62, 124, 32, 124); x.bezierCurveTo(2, 124, 2, 60, 32, 2); x.fill(); return new THREE.CanvasTexture(c); })();
    // Smoke drifts WSW on the trade winds (from about 070); placeholder, one wind for every fire.
    const WIND_FROM = 70, WIND = { x: -Math.sin(WIND_FROM * Math.PI / 180), z: Math.cos(WIND_FROM * Math.PI / 180) };   // local x = east, z = south
    const PUFFS = 14, PUFF_LIFE = 50, BURN_FULL = 180;   // a puff rises ~50 s; the fire is full for 3 min, then settles to 60 %
    function makeFx(type, dims) {               // dims: { W, H } for a non-OPFOR vehicle (civilians)
      const T = dims || VT[type], big = type === 'fuel' ? 1.8 : 1, g = new THREE.Group();
      const flames = [0xff8a30, 0xffcf70].map((c, k) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, color: c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); s.renderOrder = 6; g.add(s); return s; });
      const puffs = []; for (let k = 0; k < PUFFS; k++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0x111010, transparent: true, depthWrite: false })); s.renderOrder = 5; g.add(s); puffs.push(s); }
      fxRoot.add(g); return { g, flames, puffs, big, T };
    }
    function dropFx(w) { if (!w.fx) return; fxRoot.remove(w.fx.g); for (const o of w.fx.g.children) o.material.dispose(); w.fx = null; }
    function strike(g, i, t, cause) {
      const k = skey(g, i); if (struck.has(k)) return false;
      const v = vehiclesAt(t).find(o => o.key === k); if (!v) return false;
      const w = { t, x: v.x, z: v.z, hd: v.hd, cause, type: v.type }; w.fx = VT[v.type].foot ? null : makeFx(v.type); struck.set(k, w); return true;   // soldiers fall; they don't burn
    }
    const otherWrecks = new Map();             // civilian wrecks: key -> { t, x, z, fx, hidden }
    const burn = {
      add(key, x, z, t, dims) { if (otherWrecks.has(key)) return; otherWrecks.set(key, { t, x, z, fx: makeFx('civ', dims) }); },
      hide(key, on) { const w = otherWrecks.get(key); if (w) w.hidden = on; },
      clear() { for (const [, w] of otherWrecks) dropFx(w); otherWrecks.clear(); }
    };
    function animFx(t) {
      for (const [, w] of [...struck, ...otherWrecks]) {
        const f = w.fx; if (!f) continue;
        if (w.hidden) { f.g.visible = false; continue; }
        const a = t - w.t; f.g.visible = a >= 0; if (a < 0) continue;
        const wet = waterAt(w.x, w.z), top = (wet ? 0 : heightAt(w.x, w.z) * ex) + f.T.H * (wet && f.T.amph ? 0.4 : 1);
        const ph = (w.x * 0.37 + w.z * 0.11) % 6.28, burn = (a < BURN_FULL ? 1 : 0.6) * Math.min(1, 0.4 + a / 3) * f.big;
        f.flames.forEach((s, k) => {
          const fl = 0.85 + 0.12 * Math.sin(t * 11 + ph + k * 2) + 0.08 * Math.sin(t * 27 + ph * 3 + k);
          const wdt = f.T.W * (k ? 1.2 : 2.0) * burn * fl, hgt = wdt * (k ? 1.7 : 1.5) * (0.9 + 0.1 * Math.sin(t * 7 + k + ph));
          s.scale.set(wdt, hgt, 1); s.position.set(w.x + (k ? 0.6 : -0.4), top + hgt * 0.4 - 0.8, w.z); s.material.opacity = k ? 0.9 : 0.85;
        });
        f.puffs.forEach((s, k) => {
          const age = ((a + k * PUFF_LIFE / PUFFS) % PUFF_LIFE);
          const born = a >= age; s.visible = born; if (!born) return;          // the column builds up after the hit, not all at once
          const u = age / PUFF_LIFE, rise = age * 2.8, drift = rise * 0.55 + age * 1.2;
          const sz = (f.T.W * 2 + 46 * Math.sqrt(u)) * f.big * (a < BURN_FULL ? 1 : 0.8);
          s.scale.set(sz, sz, 1); s.position.set(w.x + WIND.x * drift, top + 1 + rise + sz * 0.25, w.z + WIND.z * drift);
          s.material.opacity = Math.min(1, age / 1.5) * Math.pow(1 - u, 0.9);
          s.material.color.setRGB(0.07 + 0.30 * u, 0.065 + 0.29 * u, 0.06 + 0.28 * u);   // black at the fire, greying as it thins
        });
      }
    }
    function charred(m, on) {                  // dark, burnt-out look on a struck vehicle's own copy of its materials
      if (!!m.userData.charred === on) return; m.userData.charred = on;
      m.traverse(o => { if (!o.isMesh) return;
        if (on) { o.userData.mat = o.material; o.material = (Array.isArray(o.material) ? o.material : [o.material]).map(x => { const c = x.clone(); if (c.color) c.color.multiplyScalar(0.18); return c; }); if (o.material.length === 1) o.material = o.material[0]; }
        else if (o.userData.mat) { for (const c of [].concat(o.material)) c.dispose(); o.material = o.userData.mat; delete o.userData.mat; } });
    }
    function pruneStruck() {                   // a deleted group or a shortened column drops its wrecks
      for (const [k, w] of struck) { const [gid, i] = k.split(':').map(Number), g = groups.find(o => o.id === gid);
        if (!g || slotType(g, i) !== w.type) { dropFx(w); struck.delete(k); } }
    }
    const struckCount = g => vehicles(g).filter((_, i) => struckAt(g, i, simT())).length;

    // ident (Lee, 2026-11-07): the group's diamond blinks inside a pulsing gold ring, like the UAS IDENT but the map stays put.
    //      Real clock, so it works while paused. Aboard cargo flashes its carrier.
    const identTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
      x.lineWidth = 14; x.strokeStyle = 'rgba(10,14,10,.7)'; x.beginPath(); x.arc(64, 64, 52, 0, 2 * Math.PI); x.stroke();
      x.lineWidth = 7; x.strokeStyle = '#ffd25a'; x.stroke(); const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t; })();
    const idents = new Map();                  // group id -> { t0, ring }
    function identGroup(g) {
      let o = idents.get(g.id);
      if (!o) { const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: identTex, depthTest: false, transparent: true, sizeAttenuation: false })); ring.renderOrder = 21; root.add(ring); idents.set(g.id, o = { ring }); }
      o.t0 = performance.now();
    }
    function identTick() {
      const now = performance.now();
      for (const [gid, o] of idents) {
        const g = groups.find(x => x.id === gid), u = (now - o.t0) / 1800;
        const syms = [g && view.g.get(gid), g && g.carrier && view.g.get(g.carrier)].filter(Boolean).map(v => v.sym);
        if (!g || u >= 1) { root.remove(o.ring); o.ring.material.dispose(); idents.delete(gid); for (const s of syms) s.material.opacity = 1; continue; }
        const at = syms.find(s => s.visible), k = (u * 3) % 1, sz = 0.025 + 0.09 * k;   // three pulses, each growing and fading
        o.ring.visible = !!at && !obs;
        if (!at) continue;
        o.ring.position.copy(at.position); o.ring.scale.set(sz, sz, 1); o.ring.material.opacity = 1 - k;
        at.material.opacity = k < 0.5 ? 1 : 0.25;  // the diamond blinks with each pulse
      }
    }
    function rebuildViews() {
      for (const g of groups) for (const u of g.units) { needModel(u.type); if (VT[u.type].dismount) needModel('inf'); }
      for (const [, v] of view.g) { for (const m of v.meshes) root.remove(m); root.remove(v.sym); v.label.remove(); }
      view.g.clear();
      for (const g of groups) {
        const meshes = vehicles(g).map(t => { const m = makeVeh(t); m.visible = false; root.add(m); return m; });
        const sym = new THREE.Sprite(new THREE.SpriteMaterial({ map: diamondTex, depthTest: false, transparent: true, sizeAttenuation: false }));
        sym.scale.set(0.028, 0.028, 1); sym.renderOrder = 20; sym.visible = false; root.add(sym);
        const label = document.createElement('div'); label.className = 'tag rt oplab'; label.textContent = g.name; labelLayer.appendChild(label);
        view.g.set(g.id, { meshes, sym, label });
      }
    }
    function drape(pts, lift) {
      const out = [];
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 25));
        for (let j = (k === 1 ? 0 : 1); j <= n; j++) { const x = a.x + (b.x - a.x) * j / n, z = a.z + (b.z - a.z) * j / n; out.push(new THREE.Vector3(x, heightAt(x, z) * ex + lift, z)); }
      }
      return out;
    }
    const ringTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d');
      x.strokeStyle = '#d6b25a'; x.lineWidth = 6; x.beginPath(); x.arc(24, 24, 17, 0, Math.PI * 2); x.stroke();
      x.fillStyle = '#d6b25a'; x.fillRect(19, 15, 4, 18); x.fillRect(26, 15, 4, 18); return new THREE.CanvasTexture(c); })();
    let holdTags = [];
    function rebuildLines() {
      for (const o of [...lines.children]) if (o.isLine2) dropFat(o); lines.clear(); handles.clear(); for (const h of holdTags) h.el.remove(); holdTags = [];
      for (const g of groups) {
        if (g.route.length < 2) continue;
        const on = sel && sel.id === g.id;
        g.route.forEach((p, k) => {
          if (!(+p.hold > 0) || k === g.route.length - 1) return;
          const l = toLocal(p.e, p.n), s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, depthTest: false, transparent: true, sizeAttenuation: false }));
          s.scale.set(0.022, 0.022, 1); s.position.set(l.x, heightAt(l.x, l.z) * ex + 8, l.z); s.renderOrder = 22; lines.add(s);
          const el = document.createElement('div'); el.className = 'tag holdtag'; el.textContent = 'Hold ' + fmt(p.hold).slice(2); labelLayer.appendChild(el);
          holdTags.push({ el, pos: s.position });
        });
        const rp = routePath(g, g.route), pts = drape(rp.pts, 4);
        for (const l of rp.legs) for (const c of l.cross) {           // a straight piece through a building: solid amber over the dashes
          const x = fatLine(drape([{ x: c.x0, z: c.z0 }, { x: c.x1, z: c.z1 }], 6), fatMat(0xffb020, on ? 6 : 5, { opacity: 1 })); x.renderOrder = 16; lines.add(x);
        }
        const l = fatLine(pts, fatMat(on ? 0xd6b25a : 0xff6a55, on ? 4 : 3, { dashed: true, dashSize: 60, gapSize: 40, opacity: on ? 1 : 0.9 }));
        l.renderOrder = 15; lines.add(l);
        if (g.prof && g.prof.line) for (const run of g.prof.line) {     // fronts as solid bars; the selected group's own vehicle paths faintly
          for (const f of run.fronts) { const b = fatLine(drape([{ x: f.c.x - f.d.x * f.h, z: f.c.z - f.d.z * f.h }, { x: f.c.x + f.d.x * f.h, z: f.c.z + f.d.z * f.h }], 5), fatMat(on ? 0xd6b25a : 0xff6a55, on ? 4 : 3, { opacity: 1 })); b.renderOrder = 15; lines.add(b); }
          if (on) for (const vp of run.paths) for (const pl of vp) { const o = fatLine(drape(pl.pts, 3), pl.blocked ? fatMat(0xffb020, 2.5, { opacity: 1 }) : fatMat(0xd6b25a, 1.5, { opacity: 0.45 })); o.renderOrder = 14; lines.add(o); }
        }
      }
      if (sel && editing) {
        if (joinPick) {
          for (const o of groups) if (canJoin(sel, o)) o.route.forEach((q, i) => { if (i > 0 || !o.parent) addHandle(toLocal(q.e, q.n), hTexJoin, { gid: o.id, i, join: true }); });
        } else {
          for (const o of groups) if (o !== sel && inFamily(o, sel)) o.route.forEach((q, i) => addHandle(toLocal(q.e, q.n), hTexFam, { gid: o.id, i, fam: true }));
          const pts = sel.route.map(p => toLocal(p.e, p.n));
          pts.forEach((p, i) => addHandle(p, i === selPt ? hTexSel : hTexPt, { gid: sel.id, i }));
          if (sel.prof && sel.prof.line) for (const run of sel.prof.line) for (const f of run.fronts) if (f.k < sel.route.length)
            for (const side of [1, -1]) addHandle({ x: f.c.x + f.d.x * f.h * side, z: f.c.z + f.d.z * f.h * side }, hTexPt, { gid: sel.id, i: f.k, bar: side });
          const rp = routePath(sel, sel.route);
          rp.legs.forEach((l, i) => addHandle(halfway(l.pts), hTexMid, { i, mid: true }));   // on the driven path, not the chord
        }
      }
    }
    function halfway(P) {                      // the point half way along a polyline
      let L = 0; for (let k = 1; k < P.length; k++) L += Math.hypot(P[k].x - P[k - 1].x, P[k].z - P[k - 1].z);
      let h = L / 2; for (let k = 1; k < P.length; k++) { const d = Math.hypot(P[k].x - P[k - 1].x, P[k].z - P[k - 1].z);
        if (d >= h) { const f = h / (d || 1); return { x: P[k - 1].x + (P[k].x - P[k - 1].x) * f, z: P[k - 1].z + (P[k].z - P[k - 1].z) * f }; } h -= d; }
      return P[P.length - 1];
    }
    function addHandle(p, tex, data) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
      const k = data.mid ? 0.011 : data.fam || data.bar ? 0.013 : 0.016; s.scale.set(k, k, 1);
      s.position.set(p.x, heightAt(p.x, p.z) * ex + 6, p.z); s.renderOrder = 25; s.userData = data; handles.add(s);
    }
    const refsAt = (g, i) => groups.filter(o => (o.parent === g.id && o.splitAt === i) || (o.join && o.join.group === g.id && o.join.at === i));
    function shiftRefs(g, from, delta) {
      for (const o of groups) { if (o.parent === g.id && o.splitAt >= from) o.splitAt += delta; if (o.join && o.join.group === g.id && o.join.at >= from) o.join.at += delta; }
    }
    const familyRoot = g => { let r = g, d = 0; while (r.parent && d++ < 8) { const p = parentOf(r); if (!p) break; r = p; } return r; };
    const inFamily = (a, b) => familyRoot(a) === familyRoot(b);
    function joinsThrough(o, g, d = 0) { if (o === g) return true; if (!o.join || d > 8) return false; const n = groups.find(x => x.id === o.join.group); return !!n && joinsThrough(n, g, d + 1); }
    const canJoin = (g, o) => o !== g && o.route.length >= 2 && isShip(o) === isShip(g) && !joinsThrough(o, g) && !(o.parent === g.id);
    let joinPick = false;
    function syncBranches() {
      for (const g of groups) if (g.join) {
        const tg = groups.find(o => o.id === g.join.group), q = tg && tg.route[g.join.at];
        if (!q || g.route.length < 1) { delete g.join; continue; }
        const last = g.route.length - 1;
        g.route[last] = Object.assign({}, g.route[last], { e: q.e, n: q.n });   // keeps the point's hold and formation
      }
      for (const g of groups) if (g.carrier) {   // cargo starts at its ship's landing place and follows it, unless its first point was dragged away
        const c = carrierOf(g); if (!c) continue;
        const R = fullRoute(c), last = R[R.length - 1], f = g.route[0];
        if (g.offShip === undefined) {           // saved before cargo had a ship: a start away from the landing point was placed by hand
          g.offShip = groups.filter(o => o.carrier === c.id).indexOf(g);
          if (f && (!last || Math.hypot(f.e - last.e, f.n - last.n) > 1)) f.moved = true;
        }
        if (!last || (f && f.moved) || (g.join && g.route.length === 1)) continue;
        buildFam(c); const at = offPoint(g, c);
        if (f) g.route[0] = Object.assign({}, f, at); else g.route.push(at);
      }
      queueRamps();
      for (const g of groups) if (g.parent) {
        const p = parentOf(g), q = p && p.route[g.splitAt];
        if (!q) { detach(g); continue; }
        const first = Object.assign({}, g.route[0], { e: q.e, n: q.n });
        if (g.route.length) g.route[0] = first; else g.route.push(first);
        g._rides = !isShip(p) && g.splitAt > 0 && formAt(p.route, g.splitAt - 1) === 'line' && formAt(p.route, g.splitAt) === 'line';
        if (g._rides) { first.form = 'line'; first.ridesLine = true; }      // split from a front: it leaves in line. Set here, so it follows the parent's formation
        else if (first.ridesLine) { delete first.form; delete first.ridesLine; }
      }
      for (const g of groups) if (!g.parent) g._rides = false;
      for (const g of groups) if (!g._rides) buildFam(g);
    }
    function detach(b) { const st = b.parent ? startOf(b) : b.start; b.parent = null; delete b.splitAt; b.start = st === null || !isFinite(st) ? 0 : Math.round(st); }
    let note = '';
    function refresh() { syncBranches(); for (const g of groups) profile(g); pruneStruck(); rebuildViews(); rebuildLines(); renderList(); renderEditor(); save(); }
    // room: the host sends its groups plus their halts (halts are not in a scenario file); a student replaces its own with them.
    //      Movement is then worked out here from the clock, exactly as on the host.
    const netState = () => ({ snap: snapshot(), halts: groups.map(g => [g.id, g.halts || []]) });
    function applyNet(o) {
      const s = JSON.parse(JSON.stringify(o.snap)), h = new Map(o.halts);
      sel = null; editing = false; groups = s.groups; nextId = s.nextId || groups.length + 1;
      for (const g of groups) if (h.get(g.id) && h.get(g.id).length) g.halts = h.get(g.id);
      refresh();
    }

    // ---- per-frame placement
    const pv = new THREE.Vector3();
    function status(g) {
      const n = struckCount(g), all = vehicles(g).length;
      if (n && n === all) return 'All ' + all + ' struck';
      return statusMove(g) + (n ? ' · ' + n + ' of ' + all + ' struck' : '');
    }
    function statusMove(g) {
      if (g.parent) {
        const p = parentOf(g), st0 = startOf(g);
        if (st0 === null) return p && p.prof ? 'Never reaches point ' + (g.splitAt + 1) : 'Waiting for main route';
        if (simT() < st0) return 'With ' + p.name + ' until point ' + (g.splitAt + 1);
      }
      if (!g.prof) return 'No route';
      const st = startOf(g), t = simT();
      if (st === null) return 'Waiting for carrier route';
      const c = carrierOf(g);
      if (c && t < st) return (t < st - (g._qoff || 0) ? 'Aboard ' + c.name : 'In queue') + ' · off ' + fmt(st);
      if (c && g.prof.delay) { const n = ownCount(g), off = offloadOf(c), k = off > 0 ? Math.min(n, Math.floor((t - st) / off) + 1) : n;
        if (k < n) return 'Unloading ' + k + ' of ' + n + ' off'; }
      if (isHalted(g)) return 'Halted by instructor';
      if (!g.parent && (t < st || (t === st && t === 0))) return 'Starts ' + fmt(st);
      const s = sAt(g, t), e = moveTime(g, t);
      if (s >= g.prof.len) return 'At end of route';
      const stop = g.prof.stops.find(o => e >= o.t0 && e < o.t1);
      if (stop) return 'Holding at point ' + (stop.k + 1) + ' until ' + fmt(realTimeAt(g, stop.t1));
      return 'Moving ' + (s / 1000).toFixed(1) + ' / ' + (g.prof.len / 1000).toFixed(1) + ' km';
    }
    function tick() {
      const t = simT(), w = canvas.clientWidth, h = canvas.clientHeight;
      foot.begin(); pips.begin(); placeAll(t);
      for (const g of groups) {
        const v = view.g.get(g.id); if (!v) continue;
        const cargo = !!g.carrier, st0 = startOf(g), aboard = cargo && (st0 === null || t < st0);
        const s0 = aboard ? null : sAt(g, t);
        let leadPos = null, anyPos = null;
        v.meshes.forEach((m, i) => {
          if (s0 === null) { m.visible = false; return; }
          const w = struckAt(g, i, t), p = placedMap.get(skey(g, i));       // placed and spaced by placeAll
          if (!p) { m.visible = false; return; }                             // aboard, or no route to stand on
          const T = VT[m.userData.t];
          charred(m, !!w);
          const wet = m.userData.wet = waterAt(p.x, p.z), ground = wet ? 0 : heightAt(p.x, p.z) * ex;
          const draft = T.draft || (wet && T.amph ? T.H * 0.6 : 0);          // swimming IFVs ride low, about 1 m showing
          m.position.set(p.x, ground + T.H / 2 - draft, p.z); m.rotation.y = p.hd; m.visible = true;
          if (T.foot) foot.add(p.x, ground, p.z, p.hd, !!w);
          const px = T.foot ? PIP_FOOT : PIP_VEH; pips.add(p.x, m.position.y, p.z, w ? -px : px);
          if (!leadPos && !w && (!g.parent || s0 >= 0)) leadPos = m.position;   // the symbol rides the first vehicle still running
          if (!anyPos && (!g.parent || s0 >= 0)) anyPos = m.position;
        });
        if (s0 !== null) eachDismount(g, t, (i, x, z, hd, down) => { const y = waterAt(x, z) ? 0 : heightAt(x, z) * ex; foot.add(x, y, z, hd, down); pips.add(x, y + 1, z, down ? -PIP_FOOT : PIP_FOOT); });
        if (!leadPos) leadPos = anyPos;          // all struck: the symbol stays on the wrecks
        const showSym = !!leadPos && !obs && showEnemy;
        v.sym.visible = showSym;
        if (showSym) v.sym.position.set(leadPos.x, leadPos.y + 30, leadPos.z);
        let showLab = showSym && !labelHidden();
        if (showLab) { pv.copy(v.sym.position).project(camera); showLab = pv.z < 1 && Math.abs(pv.x) < 1.1 && Math.abs(pv.y) < 1.1;
          if (showLab) { v.label.style.left = ((pv.x + 1) / 2 * w) + 'px'; v.label.style.top = ((1 - pv.y) / 2 * h - 14) + 'px'; } }
        v.label.style.display = showLab ? '' : 'none';
      }
      foot.end(); pips.end(!obs && showEnemy); identTick(); updateWakes(t); animFx(t);
      root.visible = showEnemy || (STUDENT && !!obs); lines.visible = !obs && showRoutes; handles.visible = !obs && showRoutes;
      const hideTags = obs || labelHidden() || !showRoutes;
      for (const h of holdTags) {
        let show = !hideTags; if (show) { pv.copy(h.pos).project(camera); show = pv.z < 1 && Math.abs(pv.x) < 1.1 && Math.abs(pv.y) < 1.1; }
        h.el.style.display = show ? '' : 'none';
        if (show) { h.el.style.left = ((pv.x + 1) / 2 * w + 16) + 'px'; h.el.style.top = ((1 - pv.y) / 2 * h) + 'px'; }
      }
      if (++tickN % 15 === 0) updateStatuses();
    }
    let tickN = 0;
    const labelHidden = () => document.getElementById('tg-labels').getAttribute('aria-pressed') !== 'true';

    // ---- route editing on the map: click to add, drag a square to move, drag a faint square to insert,
    //      Delete removes the selected point, Enter or Done finishes
    let drag = null, downAt = null, dragged = false;
    function hitHandle(e) {
      const r = canvas.getBoundingClientRect(); let best = null, bd = 11;
      for (const s of handles.children) {
        pv.copy(s.position).project(camera); if (pv.z > 1) continue;
        const x = (pv.x + 1) / 2 * r.width + r.left, y = (1 - pv.y) / 2 * r.height + r.top, d = Math.hypot(x - e.clientX, y - e.clientY);
        const own = s.userData.gid === (sel && sel.id) && !s.userData.mid;     // own points win over family points and midpoints
        if (d < bd || (best && (best.mid || best.fam) && own && d < 11)) { bd = d; best = s.userData; }
      }
      return best;
    }
    const toEN = p => ({ e: Math.round(CE + p.x), n: Math.round(CN - p.z) });
    addEventListener('pointerdown', e => {
      if (!editing || !sel || !showRoutes || e.target !== canvas || e.button !== 0) return;   // routes hidden: no moving or adding points you can't see
      downAt = { x: e.clientX, y: e.clientY }; dragged = false;
      const h = hitHandle(e);
      if (joinPick) { if (h && h.join) { e.stopPropagation(); e.preventDefault(); doJoin(sel, groups.find(o => o.id === h.gid), h.i); downAt = null; } return; }
      if (!h) return;
      e.stopPropagation(); e.preventDefault(); controls.enabled = false;
      if (h.mid) { drag = { mid: h.i }; return; }
      if (h.bar) { drag = { bar: h.bar, i: h.i }; selPt = h.i; rebuildLines(); renderEditor(); return; }
      if (h.gid !== sel.id) { sel = groups.find(o => o.id === h.gid); renderList(); }
      drag = { i: h.i }; selPt = h.i; rebuildLines(); renderEditor();
    }, true);
    addEventListener('pointermove', e => {
      if (drag === null) return;
      const p = pick(e.clientX, e.clientY); if (!p) return;
      if (drag.bar) {                          // a front's end: sets its frontage and angle, the point stays put
        const q = sel.route[drag.i], c = toLocal(q.e, q.n), dx = (p.x - c.x) * drag.bar, dz = (p.z - c.z) * drag.bar;
        q.w = Math.max(10, Math.round(2 * Math.hypot(dx, dz))); q.ang = Math.atan2(dx, dz); dragged = true; profile(sel, true); rebuildLines(); return;
      }
      if (drag.mid !== undefined) { sel.route.splice(drag.mid + 1, 0, toEN(p)); shiftRefs(sel, drag.mid + 1, 1); drag = { i: drag.mid + 1 }; selPt = drag.i; }
      if (sel.parent && drag.i === 0) return;              // a branch starts where its parent splits
      if (sel.join && drag.i === sel.route.length - 1) return;   // and ends where it rejoins
      const handMoved = sel.carrier && drag.i === 0;   // cargo's start stays with its ship until it is really dragged, not on a click's jitter
      if (handMoved && !sel.route[0].moved && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) <= 5) return;
      sel.route[drag.i] = Object.assign({}, sel.route[drag.i], toEN(p), handMoved ? { moved: true } : null); dragged = true; profile(sel, true); rebuildLines();
    }, true);
    addEventListener('pointerup', e => {
      if (drag !== null) { drag = null; controls.enabled = !obs; refresh(); downAt = null; return; }
      if (!editing || !sel || e.target !== canvas || !downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y); downAt = null;
      if (moved > 5) return;
      const p = pick(e.clientX, e.clientY); if (!p) return;
      if (joinPick) return;
      if (sel.join) { sel.route.splice(sel.route.length - 1, 0, toEN(p)); selPt = sel.route.length - 2; }   // new points go before the rejoin
      else {
        const pt = toEN(p); if (!sel.route.length && !isShip(sel) && startsAbreast(sel)) pt.form = 'line';   // a new land group starts in line
        sel.route.push(pt); selPt = sel.route.length - 1;
      }
      refresh();
    }, true);
    canvas.addEventListener('dblclick', () => { if (editing) setEditing(false); });
    addEventListener('keydown', e => {
      if (!editing || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (joinPick && e.key === 'Escape') { joinPick = false; rebuildLines(); renderEditor(); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Escape') { setEditing(false); e.preventDefault(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && sel.route.length) { e.preventDefault(); deletePoint(); }
    });
    function deletePoint() {                   // the selected (white) point, or the last one if none is selected
      const i = selPt >= 0 && selPt < sel.route.length ? selPt : sel.route.length - 1;
      if (sel.parent && i === 0) {             // nothing drawn on this branch yet: Delete simply backs out of the split
        if (sel.route.length === 1) return undoSplit(sel);
        note = 'That point is the split from ' + parentOf(sel).name + '. Press Undo split to take the branch back.'; renderEditor(); return;
      }
      if (sel.join && i === sel.route.length - 1) { note = 'That point is where it rejoins; press Unjoin first.'; renderEditor(); return; }
      const used = refsAt(sel, i), isUndrawn = o => o.parent === sel.id && o.splitAt === i && o.route.length === 1;
      if (used.length && !used.every(isUndrawn)) {
        const splits = used.filter(o => o.parent === sel.id && o.splitAt === i), joins = used.filter(o => !splits.includes(o)), say = [];
        if (splits.length) say.push(splits.map(o => o.name).join(', ') + ' split off here: press Undo split below first.');
        if (joins.length) say.push(joins.map(o => o.name).join(', ') + ' rejoin here: press Unjoin on ' + (joins.length > 1 ? 'them' : 'it') + ' first.');
        note = say.join(' '); renderEditor(); return;
      }
      for (const b of used) mergeBack(b);
      editing = true;                          // mergeBack ends editing; we are still on this route
      sel.route.splice(i, 1); shiftRefs(sel, i + 1, -1);
      selPt = Math.min(i, sel.route.length - 1); refresh();
    }
    function mergeBack(b) {                    // the branch's vehicles rejoin the rear of the parent's column, as they left it
      const p = parentOf(b);
      for (const u of b.units) { const last = p.units[p.units.length - 1]; if (last && last.type === u.type) last.n += u.n; else p.units.push({ type: u.type, n: u.n }); }
      removeGroup(b);
    }
    function undoSplit(b) {
      const p = parentOf(b), k = b.splitAt; if (!p) return;
      mergeBack(b); sel = p; editing = true; selPt = Math.min(k, p.route.length - 1); refresh();
    }
    function undoSplitBtn(btn, b) {            // a drawn branch route is lost, so that takes a second press
      if (b.route.length > 1 && !btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Confirm: discard its route'; return; }
      undoSplit(b);
    }
    function setEditing(on) { editing = on && !!sel; joinPick = false; selPt = editing && sel ? sel.route.length - 1 : -1; rebuildLines(); renderEditor(); }
    function doJoin(g, o, i) {
      if (!o || !canJoin(g, o)) return;
      if (!g.join) g.route.push({ e: o.route[i].e, n: o.route[i].n });
      g.join = { group: o.id, at: i }; joinPick = false; selPt = g.route.length - 1; refresh();
    }
    function unjoin(g) { if (g.join) { delete g.join; refresh(); } }

    // ---- groups
    function newGroup(opts) {
      const type = (opts && opts.type) || 'zbd', T = VT[type];
      const g = { id: nextId++, name: (opts && opts.name) || (T.name + ' ' + (groups.filter(o => o.units[0] && o.units[0].type === type).length + 1)),
        units: [{ type, n: T.ship ? 1 : T.squad || 6 }], route: [], roads: true, start: 0, land: T.land, water: T.water, gap: T.gap, carrier: null };
      if (T.ship) g.offload = 30;
      if (opts && opts.carrier) { g.carrier = opts.carrier; g.offShip = opts.offShip !== undefined ? opts.offShip : groups.filter(o => o.carrier === opts.carrier).length; }
      groups.push(g);
      if (opts && opts.stay) { refresh(); return g; }   // cargo (Lee, 2026-11-07): added as a subgroup in the list; the carrier's panel stays open
      sel = g; refresh(); setEditing(true); return g;
    }
    function splitHere(g, k) {
      const own = ownCount(g), take = Math.floor(own / 2), type = g.units.length ? g.units[g.units.length - 1].type : 'zbd';
      const units = [];
      let need = take;
      for (let r = g.units.length - 1; r >= 0 && need > 0; r--) {      // the rear of the column peels off
        const u = g.units[r], m = Math.min(need, u.n - (r === 0 ? 1 : 0)); if (m <= 0) continue;
        u.n -= m; need -= m; units.unshift({ type: u.type, n: m });
      }
      g.units = g.units.filter(u => u.n > 0);
      const b = { id: nextId++, name: g.name + ' B' + (branchesOf(g).length + 1), units: units.length ? units : [{ type, n: 1 }],
        route: [{ e: g.route[k].e, n: g.route[k].n }], start: 0, land: g.land, water: g.water, gap: g.gap, carrier: null, unload: 0, parent: g.id, splitAt: k, roads: g.roads !== false, loose: g.loose };
      groups.push(b); sel = b; refresh(); setEditing(true); return b;
    }
    function removeGroup(g) {
      for (const o of groups) if (o.carrier === g.id) { const st = startOf(o); o.carrier = null; o.start = st === null || !isFinite(st) ? 0 : Math.round(st); }
      for (const o of groups) if (o.parent === g.id) detach(o);
      for (const o of groups) if (o.join && o.join.group === g.id) delete o.join;
      groups = groups.filter(o => o !== g); if (sel === g) sel = null; editing = false; refresh();
    }

    // ---- panel
    const list = $('op-list'), ed = $('op-ed');
    function vtOptions(ship, cur) { return (ship ? SHIPS : LAND).map(k => `<option value="${k}"${k === cur ? ' selected' : ''}>${VT[k].name}</option>`).join(''); }
    function summary(g) {
      const s = g.units.map(u => u.n + '× ' + VT[u.type].name).join(', ') || 'no vehicles', b = branchesOf(g).reduce((a, o) => a + total(o), 0);
      return (g.parent ? 'branch at point ' + (g.splitAt + 1) + ' · ' : '') + s + (b ? ' (+' + b + ' on branches)' : '');
    }
    function renderList() {
      list.textContent = '';
      if (!groups.length) { list.innerHTML = '<p class="hint">No enemy yet. Add a group, then click its route on the map.</p>'; return; }
      const top = groups.filter(g => !g.carrier && !g.parent);
      const row = (g, depth) => {
        const wrap = document.createElement('div'); wrap.className = 'gwrap'; wrap.style.marginLeft = depth * 14 + 'px';
        const b = document.createElement('button'); b.className = 'grow' + (sel === g ? ' on' : '');
        b.innerHTML = `<span class="gn"></span><span class="gs"></span><span class="gt" data-st="${g.id}"></span>`;
        b.querySelector('.gn').textContent = (depth ? '↳ ' : '') + g.name; b.querySelector('.gs').textContent = summary(g);
        b.addEventListener('click', () => { sel = g; editing = false; selPt = -1; rebuildLines(); renderList(); renderEditor(); });
        const hb = document.createElement('button'); hb.className = 'ghalt'; hb.dataset.halt = g.id;
        hb.addEventListener('click', () => { isHalted(g) ? resume(g) : halt(g); updateStatuses(); });
        const ib = document.createElement('button'); ib.className = 'ghalt'; ib.textContent = 'IDENT'; ib.title = 'Flash this group\'s symbol on the map'; ib.setAttribute('aria-label', 'Ident ' + g.name);
        ib.addEventListener('click', () => identGroup(g));
        const col = document.createElement('div'); col.className = 'gbtns'; col.append(hb, ib);   // Halt over IDENT, same size
        wrap.append(b, col); list.appendChild(wrap);
        if (g.carrier) dragQueue(g, b, wrap);
        const cargo = groups.filter(o => o.carrier === g.id).sort((x, y) => rampOf(x) - rampOf(y) || x.q - y.q);
        for (const c of [...cargo, ...groups.filter(o => o.parent === g.id)]) row(c, depth + 1);
      };
      for (const g of top) row(g, 0);
      updateStatuses();
    }
    // drag a cargo row onto another off the same ramp to change the offload order (Lee, 2026-11-11). Pointer events, not
    // HTML drag and drop, so it works with a mouse, a pen or a finger. A press that never moves is still a click.
    let qDrag = null;                          // { g, y0, on, over, after }
    const sameRamp = (a, b) => a && b && a !== b && a.carrier === b.carrier && rampOf(a) === rampOf(b);
    function dragQueue(g, b, wrap) {
      b.style.touchAction = 'none'; b.title = 'Drag to change the offload order';
      wrap.dataset.gid = g.id;
      b.addEventListener('pointerdown', e => { if (e.button !== 0) return; qDrag = { g, y0: e.clientY, on: false, over: null, after: false }; });
      b.addEventListener('click', e => { if (b.dataset.dragged) { delete b.dataset.dragged; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    }
    const clearMarks = () => { for (const w of list.querySelectorAll('.gwrap')) w.style.boxShadow = ''; };
    addEventListener('pointermove', e => {
      if (!qDrag) return;
      if (!qDrag.on && Math.abs(e.clientY - qDrag.y0) < 6) return;
      qDrag.on = true; document.body.style.cursor = 'grabbing'; clearMarks();
      const el = document.elementFromPoint(e.clientX, e.clientY), w = el && el.closest && el.closest('#op-list .gwrap'), o = w && groups.find(x => x.id === +w.dataset.gid);
      qDrag.over = sameRamp(qDrag.g, o) ? o : null;
      if (qDrag.over) { const r = w.getBoundingClientRect(); qDrag.after = e.clientY > r.top + r.height / 2; w.style.boxShadow = qDrag.after ? '0 3px 0 #d6b25a' : '0 -3px 0 #d6b25a'; }
    });
    addEventListener('pointerup', () => {
      const d = qDrag; qDrag = null; if (!d) return;
      document.body.style.cursor = ''; clearMarks(); if (!d.on) return;
      const w = list.querySelector(`.gwrap[data-gid="${d.g.id}"] .grow`); if (w) w.dataset.dragged = '1';   // swallow the click that ends the drag
      if (!d.over) return;
      const q = groups.filter(o => sameRamp(o, d.over) || o === d.over).sort((x, y) => x.q - y.q).filter(o => o !== d.g);
      q.splice(q.indexOf(d.over) + (d.after ? 1 : 0), 0, d.g); q.forEach((o, k) => { o.q = k; });
      refresh();
    });
    addEventListener('pointercancel', () => { qDrag = null; document.body.style.cursor = ''; clearMarks(); });
    function updateStatuses() {
      for (const el of list.querySelectorAll('[data-st]')) { const g = groups.find(o => o.id === +el.dataset.st); if (g) el.textContent = status(g); }
      for (const el of list.querySelectorAll('[data-halt]')) { const g = groups.find(o => o.id === +el.dataset.halt); if (!g) continue;
        const on = isHalted(g); el.textContent = on ? 'Resume' : 'Halt'; el.setAttribute('aria-pressed', String(on));
        el.setAttribute('aria-label', (on ? 'Resume ' : 'Halt ') + g.name); el.disabled = !g.prof; }
    }
    function warnings(g) {
      const out = [];
      for (const b of [g, ...branchesOf(g)]) if (b.parent && b.prof !== undefined && startOf(b) === null && parentOf(b) && parentOf(b).prof) {
        const p = parentOf(b), short = Math.ceil(splitNeed(b) - p.prof.len);
        out.push(`${b.name}: the column's rear never reaches point ${b.splitAt + 1}. Extend ${p.name}'s route about ${short} m past it, or split earlier.`);
      }
      if (!g.units.length) out.push('Add at least one vehicle.');
      if (g.route.length < 2) out.push(editing ? 'Click on the map to add route points.' : 'No route yet: press Edit route and click on the map.');
      else {
        const P = g.prof, ship = isShip(g); let wet = 0, dry = 0;
        for (let i = 0; i < P.X.length; i++) { if (P.S[i] < 40 || P.S[i] > P.len - 60) continue; if (waterAt(P.X[i], P.Z[i])) wet++; else dry++; }
        if (ship && dry > 3) out.push('Route crosses land: ships stay on water.');
        const beached = ship ? (P.line || []).reduce((a, run) => a + run.paths.filter(vp => { const end = vp.length - 1; return vp.some((pl, j) => { for (let d = 40; d < pl.len - (j === end ? 60 : 0); d += 20) { const q = along(pl, d / pl.len); if (!waterAt(q.x, q.z)) return true; } return false; }); }).length, 0) : 0;
        if (beached) out.push(`${beached} ${beached > 1 ? 'ships' : 'ship'} in the line ${beached > 1 ? 'cross' : 'crosses'} land: narrow or move the front.`);
        const swimmers = g.units.every(u => VT[u.type].amph);
        if (!ship && wet > 3 && !swimmers) out.push('Route crosses water: ' + g.units.filter(u => !VT[u.type].amph).map(u => VT[u.type].name).join(', ') + ' cannot swim.');
        const legs = routePath(g, g.route).legs, pr = ks => ks.map(k => (k + 1) + '–' + (k + 2)).join(', ');
        const far = legs.map((l, k) => l.why === 'noroad' ? k : -1).filter(k => k >= 0), thru = legs.map((l, k) => l.cross.length ? k : -1).filter(k => k >= 0);
        if (far.length) out.push(`No road within ${ROAD_REACH} m (points ${pr(far)}): straight line.`);
        if (thru.length) out.push(`Points ${pr(thru)} cross a building (amber): move a point or add one.`);
        const stuck = (P.line || []).reduce((a, run) => a + run.paths.filter(vp => vp.some(pl => pl.blocked)).length, 0);
        if (stuck) out.push(`${stuck} ${stuck > 1 ? 'vehicles' : 'vehicle'} in the line still ${stuck > 1 ? 'cross' : 'crosses'} a building (amber): no way round, or a route point inside one. Move the point or front.`);
      }
      return out;
    }
    function renderEditor() {
      const g = sel;
      if (!g) { ed.hidden = true; return; }
      ed.hidden = false;
      const ship = isShip(g), c = carrierOf(g), kids = groups.filter(o => o.carrier === g.id);
      ed.innerHTML = `
        <div class="row"><span class="lbl">Name</span><input id="op-name" class="grid-in" aria-label="Group name"></div>
        <div class="units" id="op-units"></div>
        <div class="row"><button id="op-addunit">+ ${ship ? 'Ship' : 'Vehicle type'}</button></div>
        ${g.parent ? `<p class="hint">${g._rides ? `Stays in <b>${esc(parentOf(g).name)}</b>'s line until its point ${g.splitAt + 1}, then forms its own line.` : `Rides at the rear of <b>${esc(parentOf(g).name)}</b> and turns off at its point ${g.splitAt + 1}.`}</p>
               <div class="row"><button id="op-unsplit">Undo split</button><span class="hint">vehicles go back to ${esc(parentOf(g).name)}</span></div>`
          : c ? `<p class="hint">Carried by <b>${esc(c.name)}</b>. Comes off ${ordinal(g.q + 1)} in its ramp's queue: drag the cargo rows in the list to change the order.</p>
               <div class="row"><span class="lbl">Wait first</span><input id="op-start" style="width:70px" aria-label="Wait before offloading, mm:ss"><span class="hint">holds the queue</span></div>${shipPick(g, c)}`
            : `<div class="row"><span class="lbl">Start</span><input id="op-start" style="width:70px" aria-label="Start time, mm:ss"><span class="hint">mm:ss</span></div>`}
        <div class="row"><span class="lbl">Speed km/h</span>
          ${ship ? '' : '<label class="mini">land <input id="op-land" style="width:50px"></label>'}
          <label class="mini">water <input id="op-water" style="width:50px"></label></div>
        <div class="row"><span class="lbl">Spacing m</span><input id="op-gap" style="width:60px" aria-label="Spacing in metres"></div>
        ${ship ? '' : `<div class="row"><span class="lbl">Movement</span><button id="op-loose" aria-pressed="${loose(g)}">Loose</button><span class="hint">${loose(g) ? 'uneven spacing, slight drift' : 'exact spacing'}</span></div>`}
        ${ship ? '' : `<div class="row"><span class="lbl">Roads</span><button id="op-roads" aria-pressed="${g.roads !== false}">Follow roads</button><span class="hint">${g.roads !== false ? 'between your points' : 'straight lines'}</span></div>`}
        ${ship ? `<div class="row"><span class="lbl">Offload s</span><input id="op-offload" style="width:60px" aria-label="Seconds to offload each vehicle"><span class="hint">per vehicle, one at a time</span></div>${offloadPlan(g, kids)}` : ''}
        <div class="row"><span class="lbl">Route</span><button id="op-edit" aria-pressed="${editing}">${editing ? 'Done' : 'Edit route'}</button><button id="op-clear">Clear route</button></div>
        <p class="msg ${editing ? 'arm' : ''}" id="op-msg"></p>
        ${g.join ? `<div class="row"><span class="hint">Rejoins <b>${esc((groups.find(o => o.id === g.join.group) || {}).name || '?')}</b> at its point ${g.join.at + 1}, then follows its route.</span><button id="op-unjoin">Unjoin</button></div>`
          : editing && g.route.length >= 1 && groups.some(o => canJoin(g, o)) ? `<div class="row"><button id="op-join" aria-pressed="${joinPick}">${joinPick ? 'Cancel rejoin' : 'Rejoin a route'}</button><span class="hint">${joinPick ? 'Click a blue point on the route to rejoin.' : 'snap the end onto another route'}</span></div>` : ''}
        ${editing && selPt >= 0 && selPt < g.route.length ? `<div class="ptrow">
            ${selPt < g.route.length - 1 || g.join ? `<div class="row"><span class="lbl">Point ${selPt + 1} hold</span><input id="op-hold" style="width:70px" aria-label="Hold at this point, mm:ss"><span class="hint">mm:ss, 0 for none</span></div>` : `<div class="row"><span class="lbl">Point ${selPt + 1}</span><span class="hint">end of route</span></div>`}
            ${pointRows(g)}
            <div class="row"><button id="op-delpt">Delete point ${selPt + 1}</button></div>
            <div class="row"><button id="op-split">Split here</button><span class="hint">${branchesOf(g).filter(b => b.splitAt === selPt).map(b => esc(b.name)).join(', ') || (!ship && formAt(g.route, selPt) === 'line' && selPt > 0 && formAt(g.route, selPt - 1) === 'line' ? 'half the line forms its own line here' : 'rear vehicles take a new road')}</span></div>
            ${branchesOf(g).filter(b => b.splitAt === selPt).map(b => `<div class="row"><button class="op-unsplit-b" data-id="${b.id}">Undo split</button><span class="hint">${esc(b.name)}</span></div>`).join('')}</div>` : ''}
        ${!editing && g.route.some((p, k) => +p.hold > 0 && k < g.route.length - 1) ? `<p class="hint">Holds: ${g.route.map((p, k) => +p.hold > 0 && k < g.route.length - 1 ? 'point ' + (k + 1) + ' for ' + fmt(p.hold).slice(2) : '').filter(Boolean).join(', ')}.</p>` : ''}
        ${!ship ? '' : shipsSpread(g) ? cargoByShip(g, kids) : `<div class="row"><span class="lbl">Cargo</span><button id="op-cargo">+ Cargo group</button></div>
                  <p class="hint">${kids.length ? 'Carrying ' + kids.map(k => esc(k.name)).join(', ') + '. Select one in the list above to edit it.' : 'Nothing aboard yet.'}</p>`}
        <div class="row"><button id="op-del" class="fire-btn">Delete group</button></div>`;
      $('op-name').value = g.name;
      $('op-name').addEventListener('change', e => { g.name = e.target.value.trim() || g.name; refresh(); });      const ub = $('op-units');
      g.units.forEach((u, i) => {
        const r = document.createElement('div'); r.className = 'row';
        r.innerHTML = `<select aria-label="Type">${vtOptions(ship, u.type)}</select><input type="number" min="1" max="60" value="${u.n}" style="width:56px" aria-label="Count"><button aria-label="Remove">×</button>`;
        r.querySelector('select').addEventListener('change', e => { u.type = e.target.value; refresh(); });
        r.querySelector('input').addEventListener('change', e => { u.n = Math.max(1, Math.min(60, Math.round(+e.target.value || 1))); refresh(); });
        r.querySelector('button').addEventListener('click', () => { g.units.splice(i, 1); refresh(); });
        ub.appendChild(r);
      });
      $('op-addunit').addEventListener('click', () => { g.units.push({ type: ship ? 'lcu' : (g.units[0] ? g.units[0].type : 'zbd'), n: ship ? 1 : 2 }); refresh(); });
      if ($('op-start')) $('op-start').value = fmt(g.start).slice(2);
      if ($('op-start')) $('op-start').addEventListener('change', e => { const v = parseT(e.target.value); if (v === null) { e.target.value = fmt(g.start).slice(2); return; } g.start = v; refresh(); });
      if ($('op-offship')) $('op-offship').addEventListener('change', e => { g.offShip = +e.target.value; delete g.route[0].moved; refresh(); });
      if ($('op-land')) { $('op-land').value = g.land; $('op-land').addEventListener('change', e => { g.land = Math.max(1, +e.target.value || g.land); refresh(); }); }
      $('op-water').value = g.water; $('op-water').addEventListener('change', e => { g.water = Math.max(0, +e.target.value || 0); refresh(); });
      if ($('op-roads')) $('op-roads').addEventListener('click', () => { g.roads = g.roads === false; refresh(); });
      $('op-gap').value = g.gap; $('op-gap').addEventListener('change', e => { g.gap = Math.max(5, +e.target.value || g.gap); refresh(); });
      if ($('op-offload')) { $('op-offload').value = offloadOf(g); $('op-offload').addEventListener('change', e => { g.offload = Math.max(0, Math.round(+e.target.value || 0)); refresh(); }); }
      if ($('op-hold')) { const p = g.route[selPt]; $('op-hold').value = fmt(+p.hold || 0).slice(2);
        $('op-hold').addEventListener('change', e => { const v = parseT(e.target.value); if (v === null) { e.target.value = fmt(+p.hold || 0).slice(2); return; }
          if (v > 0) p.hold = v; else delete p.hold; refresh(); }); }
      if ($('op-delpt')) $('op-delpt').addEventListener('click', deletePoint);
      const pt = g.route[selPt];
      if ($('op-form')) { $('op-form').value = pt.form || ''; $('op-form').addEventListener('change', e => {
        if (e.target.value) pt.form = e.target.value; else delete pt.form;
        if (pt.form === 'line' && !(+pt.w > 0)) pt.w = Math.round(frontage(g, g.route, selPt)); refresh(); }); }
      if ($('op-w')) { $('op-w').value = Math.round(frontage(g, g.route, selPt)); $('op-w').addEventListener('change', e => { const v = Math.round(+e.target.value); if (v >= 10) pt.w = v; refresh(); }); }
      if ($('op-ang')) $('op-ang').addEventListener('click', () => { delete pt.ang; refresh(); });
      if ($('op-kmh')) { $('op-kmh').value = +pt.kmh > 0 ? pt.kmh : ''; $('op-kmh').addEventListener('change', e => { const v = +e.target.value; if (v > 0) pt.kmh = v; else delete pt.kmh; refresh(); }); }
      if ($('op-straight')) $('op-straight').addEventListener('click', () => { if (pt.straight) delete pt.straight; else pt.straight = true; refresh(); });
      if ($('op-loose')) $('op-loose').addEventListener('click', () => { g.loose = !loose(g); refresh(); });
      if ($('op-split')) $('op-split').addEventListener('click', () => splitHere(g, selPt));
      if ($('op-unsplit')) $('op-unsplit').addEventListener('click', e => undoSplitBtn(e.target, g));
      for (const u of ed.querySelectorAll('.op-unsplit-b')) u.addEventListener('click', e => undoSplitBtn(e.target, groups.find(o => o.id === +u.dataset.id)));
      if ($('op-join')) $('op-join').addEventListener('click', () => { joinPick = !joinPick; rebuildLines(); renderEditor(); });
      if ($('op-unjoin')) $('op-unjoin').addEventListener('click', () => unjoin(g));
      $('op-edit').addEventListener('click', () => setEditing(!editing));
      $('op-clear').addEventListener('click', () => {
        for (const b of branchesOf(g)) detach(b);
        for (const o of groups) if (o.join && o.join.group === g.id) delete o.join;
        delete g.join;
        g.route = g.parent ? g.route.slice(0, 1) : []; refresh(); setEditing(true); });
      if ($('op-cargo')) $('op-cargo').addEventListener('click', () => newGroup({ type: 'fuel', carrier: g.id, stay: true, name: g.name + ' cargo ' + (kids.length + 1) }));
      for (const b of ed.querySelectorAll('.op-shipcargo')) b.addEventListener('click', () => { const r = +b.dataset.ship;
        newGroup({ type: 'fuel', carrier: g.id, offShip: r, stay: true, name: g.name + ' ship ' + (r + 1) + ' cargo ' + (kids.filter(k => k.offShip % shipsSpread(g) === r).length + 1) }); });
      $('op-del').addEventListener('click', e => { if (e.target.dataset.armed) removeGroup(g); else { e.target.dataset.armed = '1'; e.target.textContent = 'Confirm delete'; } });
      const w = warnings(g), m = $('op-msg');
      const n0 = note; note = '';
      m.textContent = (n0 ? n0 + ' ' : '') + (editing ? (joinPick ? 'Pick the point where this group rejoins: click a blue square. Esc cancels.' : '')   // no instructions or warnings while drawing (Lee, 2026-11-07); warnings show after Done
                              : w.join(' ') || (g.prof ? `Route ${(g.prof.len / 1000).toFixed(1)} km, about ${Math.round(g.prof.dur / 60)} min for the lead.` : ''));
      if (n0 || (!editing && w.length)) m.className = 'msg bad';
    }
    const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const ordinal = n => n + (n % 100 > 10 && n % 100 < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
    function offloadPlan(c, kids) {            // each ramp's queue with its off times, in order
      if (!kids.length) return '';
      const arr = c.prof ? realTimeAt(c, c.prof.dur) : null, n = shipsSpread(c), off = offloadOf(c), rows = [];
      for (let r = 0; r < Math.max(1, n); r++) {
        const q = kids.filter(k => rampOf(k) === r).sort((a, b) => a.q - b.q); if (!q.length) continue;
        const at = k => arr === null || !isFinite(arr) ? '' : ' ' + fmt(arr + k._qoff) + '–' + fmt(arr + k._qoff + (ownCount(k) - 1) * off);
        rows.push(`<p class="hint">${n ? 'Ship ' + (r + 1) + ': ' : ''}${q.map((k, i) => (i + 1) + '. ' + esc(k.name) + at(k)).join(' · ')}</p>`);
      }
      return `<div class="lbl">Offload order</div>${rows.join('')}<p class="hint">Drag cargo rows in the list above to reorder.${arr === null ? ' Times show once the ship has a route.' : ''}</p>`;
    }
    function cargoByShip(g, kids) {            // ship first: each ship's row adds cargo off that ship and lists what it carries
      const n = shipsSpread(g), mine = r => kids.filter(k => !(k.route[0] && k.route[0].moved) && k.offShip % n === r), placed = kids.filter(k => k.route[0] && k.route[0].moved);
      const names = list => list.length ? `<span class="hint">${list.map(k => esc(k.name)).join(', ')}</span>` : '';   // names only: a cargo group is edited from the list above
      return `<div class="lbl">Cargo, looking along the route</div>` + Array.from({ length: n }, (_, r) => `<div class="row"><span class="lbl">Ship ${r + 1}${r ? r === n - 1 ? ' (right)' : '' : ' (left)'}</span><button class="op-shipcargo" data-ship="${r}">+ Cargo group</button>${names(mine(r))}</div>`).join('')
        + (placed.length ? `<div class="row"><span class="lbl">Placed by hand</span>${names(placed)}</div>` : '')
        + (kids.length ? '<p class="hint">Select a cargo group in the list above to edit it.</p>' : '');
    }
    function shipPick(g, c) {                  // which ship in a Line landing this cargo rolls off
      const n = shipsSpread(c), moved = g.route[0] && g.route[0].moved; if (!n) return '';
      const opts = Array.from({ length: n }, (_, r) => `<option value="${r}"${!moved && g.offShip % n === r ? ' selected' : ''}>Ship ${r + 1}${r ? r === n - 1 ? ' (right end)' : '' : ' (left end)'}</option>`).join('');
      return `<div class="row"><span class="lbl">Off ship</span><select id="op-offship" aria-label="Ship this cargo rolls off">${moved ? '<option selected disabled>Start moved by hand</option>' : ''}${opts}</select><span class="hint">looking along its route</span></div>`;
    }
    function pointRows(g) {                    // the selected point's formation, frontage, speed and roads to the next point
      const k = selPt, p = g.route[k], end = k === g.route.length - 1 && !g.join, R = g.route;
      const inLine = formAt(R, k) === 'line' || (end && k > 0 && formAt(R, k - 1) === 'line' && p.form !== 'column');
      let h = '';                              // Formation shows on the last point too: it applies to the points clicked after it
      if (g._rides && k === 0) h += `<p class="hint">Leaves ${esc(parentOf(g).name)}'s front here in line. Set a Column point further on to regroup.</p>`;
      else h += `<div class="row"><span class="lbl">Formation</span><select id="op-form" aria-label="Formation from this point">
          <option value="">As before (${k ? (formAt(R, k - 1) === 'line' ? 'Line' : 'Column') : 'Column'})</option><option value="line">Line</option><option value="column">Column</option></select></div>`;
      if (inLine && !(g._rides && k === 0)) h += `<div class="row"><span class="lbl">Frontage m</span><input id="op-w" style="width:60px" aria-label="Frontage in metres">${p.ang !== undefined ? '<button id="op-ang">Square to route</button>' : '<span class="hint">or drag the bar ends</span>'}</div>`;
      if (k === 0 && formAt(R, 0) === 'line' && startsAbreast(g)) h += '<p class="hint">Starts abreast on this front. Choose Column to start in column instead.</p>';
      else if (formAt(R, k) === 'line' && (!k || formAt(R, k - 1) !== 'line') && !(g._rides && k === 0)) h += `<p class="hint">Spreads out from here, ${isShip(g) ? 'each ship on its own track' : 'each vehicle on its own street'}, abreast at later points. A Column point regroups them.</p>`;
      if (!end) h += `<div class="row"><span class="lbl">Speed to next</span><input id="op-kmh" style="width:50px" placeholder="group" aria-label="Speed to the next point, km/h"><span class="hint">km/h</span></div>`;
      if (!end && !isShip(g) && g.roads !== false) h += `<div class="row"><span class="lbl">To next point</span><button id="op-straight" aria-pressed="${!p.straight}">Follow roads</button><span class="hint">${p.straight ? 'straight line' : 'on the roads'}</span></div>`;
      return h;
    }
    $('op-new').addEventListener('click', () => newGroup({ type: $('op-newtype').value }));
    $('op-newtype').innerHTML = [...LAND, ...SHIPS].map(k => `<option value="${k}">${VT[k].name}${VT[k].ship ? ' (ship)' : ''}</option>`).join('');
    $('op-clearall').addEventListener('click', e => {
      if (!e.target.dataset.armed) { e.target.dataset.armed = '1'; e.target.textContent = 'Confirm: remove all'; return; }
      groups = []; sel = null; editing = false; delete e.target.dataset.armed; e.target.textContent = 'Remove all'; refresh();
    });

    load(); refresh();
    return { tick, farTick, onExaggeration: rebuildLines, debug: { snapshot, netState, applyNet, models: tmpl, view, lines, handles, pips: pips.obj, fxRoot, set showEnemy(v) { showEnemy = !!v; }, set showRoutes(v) { showRoutes = !!v; }, get groups() { return groups; }, VT, waterAt, toLocal, splitHere, resolve, offsetOf, doJoin, unjoin, fullRoute, get joinPick() { return joinPick; }, halt, resume, isHalted, moveTime, struck, strike, vehiclesAt, vName, struckAt, burn, fxRules: { PUFFS, PUFF_LIFE, BURN_FULL, WIND_FROM }, routePath, pathEN: g => routePath(g, fullRoute(g)).pts.map(p => ({ e: CE + p.x, n: CN - p.z })), roadRules: { ROAD_W, ROAD_REACH }, realTimeAt, newGroup, refresh, sAt, posAt, vehAt, placeAll, yld, yldDelay, yldCatchUp, root, startOf, status, select(g) { sel = g; renderList(); renderEditor(); }, setEditing } };
  })();
  window.__opfor = OPFOR.debug;

  // ---- DAMAGE: does a burst strike a vehicle. Ported from the Fire Mission Sim (js/sim-damage.js,
  //      claude/sim-damage-model.md): each burst rolls separately against each vehicle,
  //          P(struck) = Pdh * exp( -(d / R)^2 )
  //      d = ground distance from the burst to the vehicle at the moment it lands, R = radius for that
  //      munition against that class (Carleton damage function, circular form). Pdh = chance a burst right
  //      on the vehicle strikes it: 1 for artillery (as in the sim); below 1 for the smaller UAS warheads, so a
  //      tracked drone strike is not a sure thing. The dice are keyed (seed | burst id | vehicle), never drawn
  //      in order, so 1x and 10x give the same result and a replay is identical.
  //      EVERY NUMBER HERE IS A PLACEHOLDER. Artillery 155/105 rows are the sim's (accepted by Lee 2026-09-27);
  //      mortar and UAS rows are new guesses by Claude, unsourced. Tune them here.
  const DAMAGE = (() => {
    const CLASS = { zbd: 'armor', ztd: 'armor', plz: 'armor', hq17: 'armor', eng: 'eng', fuel: 'soft', civ: 'soft', inf: 'soft' };   // civilians: unarmoured, soft   // ships (LCU, RoRo) absent = immune
    const R = {
      m777:        { soft: 35, eng: 15, armor: 10 },             // = sim M109 155 mm
      m119:        { soft: 25, eng: 10, armor: 6 },              // = sim M101 105 mm
      m120:        { soft: 25, eng: 10, armor: 6 },              // guess: like 105
      m252:        { soft: 15, eng: 5,  armor: 3 },              // guess
      altius_600m: { soft: 10, eng: 3,  armor: 2 },              // guesses from here down
      altius_700m: { soft: 15, eng: 5,  armor: 4 },
      switchblade: { soft: 12, eng: 4,  armor: 3 },
      lucas:       { soft: 30, eng: 12, armor: 8 },
      // Quick fire only (Claude, 2026-11-11, unsourced guesses for Lee to tune). Scaled from the 155 row by roughly the
      // cube root of explosive weight, softened for frag: blast reach grows slower than the bomb.
      gmlrs:       { soft: 50, eng: 22, armor: 14 },             // M31 unitary, ~90 kg warhead
      rt_mk15:     { soft: 25, eng: 10, armor: 6 },              // RT-2000 Mk15 117 mm, ~105-class
      rt_mk30:     { soft: 35, eng: 15, armor: 9 },              // RT-2000 Mk30 180 mm, ~155-class
      rt_mk45:     { soft: 50, eng: 20, armor: 12 },             // RT-2000 Mk45 227 mm, HE treated as unitary
      atacms:      { soft: 75, eng: 35, armor: 18 },             // M57 unitary, ~225 kg warhead
      mk81:        { soft: 55, eng: 25, armor: 12 },             // 250 lb
      mk82:        { soft: 75, eng: 35, armor: 18 },             // 500 lb
      mk83:        { soft: 100, eng: 45, armor: 25 },            // 1,000 lb
      mk84:        { soft: 130, eng: 60, armor: 35 }             // 2,000 lb
    };
    const PDH = {                                                 // chance a burst ON the vehicle strikes it (missing = 1)
      altius_600m: { eng: 0.6, armor: 0.35 },
      altius_700m: { eng: 0.9, armor: 0.85 },
      switchblade: { eng: 0.9, armor: 0.8 },
      lucas:       { armor: 0.9 }
    };
    const TUBES = { m777: true, m119: true, m120: true, m252: true };   // tube rounds do nothing in the water (sim rule)
    const UAS_MISS = 1.0;                                         // guidance scatter, metres (1 sigma each axis), placeholder
    const SEED = 0xB1A57;
    function hash(str) {
      let h = 0x811c9dc5 ^ SEED;
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
      return h >>> 0;
    }
    function u01(key) {
      const a = (hash(key) + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function pStrike(mun, type, d) {
      const c = CLASS[type], r = R[mun] && R[mun][c]; if (!(r > 0)) return 0;
      const pdh = PDH[mun] && typeof PDH[mun][c] === 'number' ? PDH[mun][c] : 1;
      return pdh * Math.exp(-(d / r) * (d / r));
    }
    // one burst at local (x, z), time t. Returns { hits: [{v, d, p}], near: {v, d} | null }
    // y (m, absolute) given = the burst was on a building or crest above the ground: distance is then 3D to the vehicle's
    // centre. Ground bursts keep the sim's ground distance. Either way a building between burst and vehicle shields it.
    function shielded(x, z, yb, vx, vz, vy) {
      const L = Math.hypot(vx - x, vz - z), n = Math.floor(L / 3);
      for (let k = 1; k < n; k++) {
        const f = k / n, d0 = f * L; if (d0 < 3 || L - d0 < 4) continue;          // not the burst's own wall, not the vehicle's own spot
        const px = x + (vx - x) * f, pz = z + (vz - z) * f, roof = CITY.roofAt(px, pz, true);
        if (roof !== null && roof > yb + (vy - yb) * f) return true;
      }
      return false;
    }
    function burstAt(id, mun, x, z, t, y) {
      const O = OPFOR.debug, out = { hits: [], near: null, shielded: 0 }, wetB = O.waterAt(x, z), up = y !== undefined;
      const yb = up ? y : (wetB ? 0 : heightAt(x, z)) + 1;
      for (const v of [...O.vehiclesAt(t), ...CIV.vehiclesAt(t)]) {
        const vy = (O.waterAt(v.x, v.z) ? 0 : heightAt(v.x, v.z)) + 1.5;
        const d = up ? Math.hypot(v.x - x, v.z - z, vy - y) : Math.hypot(v.x - x, v.z - z);
        if (!out.near || d < out.near.d) out.near = { v, d };
        if (v.struck || d > 450) continue;
        let p = pStrike(mun, v.type, d);
        if (p > 0 && TUBES[mun] && (wetB || O.waterAt(v.x, v.z))) p = 0;
        if (p > 0 && CITY.ready && shielded(x, z, yb, v.x, v.z, vy)) { p = 0; out.shielded++; }
        if (p > 0 && u01(id + '|' + v.key) < p && (v.civ ? CIV.strike(v.i, t, !!v.civ.boat) : O.strike(v.g, v.i, t, id))) {
          out.hits.push({ v, d, p });
          NET.emit('strike', v.civ ? { civ: v.i, boat: !!v.civ.boat, t } : { g: v.g.id, i: v.i, t, cause: id });   // a room's students apply the same strike
        }
      }
      return out;
    }
    // artillery: every round that lands
    FIRES.onImpact((imp, m, k) => {
      const tag = m.tag || 'M' + m.id, p = toLocal(imp.e, imp.n), r = burstAt(tag + '|' + k, m.mun || m.u.type, p.x, p.z, imp.t, imp.what ? imp.y : undefined);
      for (const h of r.hits) { m.struck = (m.struck || 0) + 1; if (h.v.civ) m.civ = (m.civ || 0) + 1; FIRES.log(`${tag} STRUCK ${h.v.civ ? h.v.name.toUpperCase() : OPFOR.debug.vName(h.v.g, h.v.i)} (${Math.round(h.d)} m)`); }
    });
    // UAS: aim point plus a little keyed guidance scatter
    function uasImpact(id, type, x, z, t) {
      const g = k => { const u = Math.max(1e-9, u01(id + '|' + k)), w = u01(id + '|' + k + 'b'); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); };
      const px = x + g('mx') * UAS_MISS, pz = z + g('mz') * UAS_MISS;
      return Object.assign(burstAt(id, type, px, pz, t), { x: px, z: pz });
    }
    return { burstAt, uasImpact, pStrike, shielded, R, PDH, CLASS, UAS_MISS };
  })();
  window.__damage = DAMAGE;

  // ---- CIVILIANS (Lee, 2026-11-02): background traffic on the OSM roads — false targets and clutter.
  //      Display → Civilians picks the density. Cars are seeded (same streets every run, and in multiplayer later);
  //      a bigger setting adds cars, it never reshuffles the smaller one. About half are parked at the kerb, the rest
  //      drive a random walk over the road graph at a road-class speed, on the right-hand side. A moving car's place is a
  //      fixed function of the clock (pause, 10x and replays agree). No traffic rules, lights or collisions.
  //      Drawing is kept light: full models only near where someone is looking (the main view's centre and each open
  //      UAS feed's aim point), coloured boxes elsewhere out to FAR_R, nothing beyond. Civilians can be struck exactly like
    //      enemy vehicles (soft class): a struck car stops where it is and burns (Lee, 2026-11-02).
  const CIV = (() => {
    const LEVELS = [['off', 'Off', 0], ['sparse', 'Sparse', 700], ['normal', 'Normal', 1800], ['rush', 'Rush hour', 3600]];   // cars across the whole map — placeholders
    const PARKED = 0.5, KMH = [50, 40, 30];       // share parked; driving speed by road class (major / mid / minor) — placeholders
    const FAR_R = 3500, NEAR_CAP = 220;           // boxes out to FAR_R from a camera; at most NEAR_CAP full models
    const COLOURS = { white: 0xe8e8e4, silver: 0xa9adb0, black: 0x1d1e20, 'dark blue': 0x1f2c48, red: 0x9e2222, 'dark green': 0x24402c, brown: 0x5a3f2a,
      grey: 0x6f7274, navy: 0x1d2640, cream: 0xd9d2b8, 'dark grey': 0x46484a, maroon: 0x5c1d22, rust: 0x8a4a2a, olive: 0x5e5f33, taupe: 0x8a7f70, 'off-white': 0xdcd8cc, 'dark teal': 0x1f4a4c };
    let level = LITE ? 'sparse' : 'normal', specs = null, N = 0, built = false; const cars = [];
    const grp = new THREE.Group(); scene.add(grp);
    function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

    // ---- placement: weighted pick of a road edge, then a spot on it
    function build() {
      const R = ROADNET, E = R.E, X = R.X, Z = R.Z, nE = E.length / 3, max = LEVELS[LEVELS.length - 1][2];
      const wPark = [0, 0.6, 1], wDrive = [2, 1.5, 1], cumP = new Float64Array(nE), cumD = new Float64Array(nE);
      let sp = 0, sd = 0;
      for (let e = 0; e < nE; e++) {
        const a = E[e * 3], b = E[e * 3 + 1], c = E[e * 3 + 2], L = Math.hypot(X[b] - X[a], Z[b] - Z[a]);
        const on = Math.abs(X[a]) < HW && Math.abs(Z[a]) < HH && L > 4;
        sp += on && L > 24 ? L * wPark[c] : 0; sd += on ? L * wDrive[c] : 0; cumP[e] = sp; cumD[e] = sd;
      }
      const pickEdge = (cum, u) => { const v = u * cum[cum.length - 1]; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < v) lo = m + 1; else hi = m; } return lo; };
      const r = rng(0xC1F1A);
      cars.length = 0;
      for (let i = 0; i < max; i++) {
        const parked = r() < PARKED, e = pickEdge(parked ? cumP : cumD, r()), mi = Math.floor(r() * specs.length), dir = r() < 0.5 ? 1 : -1, t = parked ? 0.15 + 0.7 * r() : r();
        const c = { i, mi, parked, seed: (0xC1F1A + i * 7919) >>> 0 };
        const a = E[e * 3], b = E[e * 3 + 1], hw = R.WD[e] / 2;
        const [ax, az, bx, bz] = dir > 0 ? [X[a], Z[a], X[b], Z[b]] : [X[b], Z[b], X[a], Z[a]];
        const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
        if (parked) {                            // at the kerb on the right, nose along the road
          const off = Math.max(1.2, hw - 1.1);
          c.x = ax + ux * L * t - uz * off; c.z = az + uz * L * t + ux * off; c.hd = Math.atan2(ux, uz);
        } else {
          c.e0 = e; c.from = dir > 0 ? a : b; c.to = dir > 0 ? b : a; c.s0 = t * L;
          c.v = KMH[E[e * 3 + 2]] / 3.6 * (0.85 + 0.3 * r());
          resetPath(c);
        }
        cars.push(c);
      }
      buildBoats();
      built = true;
      if (!modelsStarted) setTimeout(loadModels, 1500);   // models load in the background once traffic exists; boxes until then
    }
    // ---- a driving car's path: edges chosen by its own dice, generated as far as needed; lane offset to the right
    function resetPath(c) { c.r = rng(c.seed); c.seg = []; c.base = 0; c.prevN = c.from; c.curN = c.to; addSeg(c, c.e0, c.from, c.to); }
    function addSeg(c, e, a, b) {
      const R = ROADNET, L = Math.hypot(R.X[b] - R.X[a], R.Z[b] - R.Z[a]) || 0.1, s = c.seg.length ? c.seg[c.seg.length - 1].s1 : 0;
      c.seg.push({ ax: R.X[a], az: R.Z[a], bx: R.X[b], bz: R.Z[b], s0: s, s1: s + L, off: Math.min(1.8, Math.max(1, R.WD[e] / 4)) });
    }
    function extend(c) {                         // next edge from the current node: never straight back unless it is a dead end
      const R = ROADNET, n = c.curN, opts = [];
      for (let k = R.deg[n]; k < R.deg[n + 1]; k++) if (R.to[k] !== c.prevN) opts.push(k);
      const k = opts.length ? opts[Math.floor(c.r() * opts.length)] : R.deg[n];
      const nb = R.to[k]; addSeg(c, R.eid[k], n, nb); c.prevN = n; c.curN = nb;
    }
    function drivePos(c, t) {
      let s = c.s0 + c.v * t;
      if (c.seg.length && s < c.seg[0].s0) resetPath(c);                    // the clock went back: replay from the start
      while (c.seg[c.seg.length - 1].s1 < s) extend(c);
      while (c.seg.length > 6 && c.seg[1].s1 < s) c.seg.shift();            // forget road far behind
      let g = c.seg[0]; for (const q of c.seg) if (q.s1 >= s) { g = q; break; }
      const L = g.s1 - g.s0, f = Math.min(1, Math.max(0, (s - g.s0) / L)), ux = (g.bx - g.ax) / L, uz = (g.bz - g.az) / L;
      return { x: g.ax + ux * L * f - uz * g.off, z: g.az + uz * L * f + ux * g.off, hd: Math.atan2(ux, uz) };
    }
    const posOf = (c, t) => c.st && t >= c.st.t ? c.st : c.parked ? c : drivePos(c, t);
    const TYPE = { hatch: 'hatchback', pickup: 'pickup', van: 'panel van', minivan: 'minivan', smallvan: 'small van', sedan: 'sedan' };
    const civName = c => 'civilian ' + specs[c.mi].colour + ' ' + (TYPE[specs[c.mi].type] || 'car');
    const hit = [];                              // struck cars, for the fire's visibility when the setting changes
    function vehiclesAt(t) {                     // for DAMAGE: the civilians on the map at time t
      const out = [];
      for (let i = 0; i < N; i++) { const c = cars[i], p = posOf(c, t); out.push({ civ: c, i, type: 'civ', key: 'civ:' + i, x: p.x, z: p.z, hd: p.hd, struck: !!(c.st && t >= c.st.t), name: civName(c) }); }
      for (let i = 0; i < NBt; i++) { const b = boats[i], p = boatPos(b, t); out.push({ civ: b, i, type: 'civ', key: 'boat:' + i, x: p.x, z: p.z, hd: p.hd, struck: !!(b.st && t >= b.st.t), name: 'civilian fishing boat' }); }
      return out;
    }
    function strike(i, t, boat) {
      if (boat) { const b = boats[i]; if (!b || b.st) return false; const p = boatPos(b, t); b.st = { t, x: p.x, z: p.z, hd: p.hd }; hit.push(b);
        OPFOR.debug.burn.add('boat:' + i, p.x, p.z, t, { W: 5, H: 2.5, amph: false }); return true; }
      const c = cars[i]; if (!c || c.st) return false;
      const p = posOf(c, t), sp = specs[c.mi]; c.st = { t, x: p.x, z: p.z, hd: p.hd }; hit.push(c);
      OPFOR.debug.burn.add('civ:' + i, p.x, p.z, t, { W: sp.W, H: sp.H, amph: false }); return true;
    }

    // ---- drawing: one InstancedMesh per model part (full models) + one instanced box set (far)
    let parts = [];                              // per model: [{ mesh: InstancedMesh, local: Matrix4 }]
    const boxGeo = new THREE.BoxGeometry(1, 1, 1); boxGeo.translate(0, 0.5, 0);
    let boxes = null;
    function initBoxes() {
      boxes = new THREE.InstancedMesh(boxGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), LEVELS[LEVELS.length - 1][2]);
      boxes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(boxes.instanceMatrix.count * 3).fill(1), 3);   // sized to capacity, not count
      boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage); boxes.count = 0; boxes.frustumCulled = false; grp.add(boxes);
      const col = new THREE.Color(); for (let i = 0; i < boxes.instanceMatrix.count; i++) boxes.setColorAt(i, col.setHex(0x888888));
      parts = specs.map(() => []);
    }
    let modelsStarted = false;
    async function loadModels() {
      modelsStarted = true;
      if (!THREE.GLTFLoader) return;
      await loadBoat();
      if (LITE) return;                          // lite: cars stay coloured boxes (30 textured models cost too much memory on a phone)
      // one at a time, in the background: 30 small files; cars show as boxes until their model arrives
      const loader = new THREE.GLTFLoader();
      for (let mi = 0; mi < specs.length; mi++) {
        try {
          const gl = await new Promise((res, rej) => loader.load('data/civ/' + specs[mi].file, res, undefined, rej));
          gl.scene.updateMatrixWorld(true);
          gl.scene.traverse(o => { if (!o.isMesh) return;
            const m = new THREE.InstancedMesh(o.geometry, o.material, NEAR_CAP); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            for (let k = 0; k < NEAR_CAP; k++) m.setColorAt(k, WHITE);   // before count = 0: three sizes the colour buffer from count
            m.count = 0; m.frustumCulled = false;
            grp.add(m); parts[mi].push({ mesh: m, local: o.matrixWorld.clone() }); });
        } catch (e) { console.warn('Civilian model failed to load:', specs[mi].file, e); }
      }
    }
    const WHITE = new THREE.Color(1, 1, 1), BURNT = new THREE.Color(0.17, 0.16, 0.15);
    const M = new THREE.Matrix4(), M2 = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), C = new THREE.Color();
    let focus = [], cams = [], frame = 0;
    function tick(t, extraFocus) {
      if (!built || !N) { grp.visible = false; if (frame++ % 30 === 0) for (const c of hit) OPFOR.debug.burn.hide((c.boat ? 'boat:' : 'civ:') + c.i, true); for (const q of boatParts) q.mesh.visible = false; wakes.visible = false; return; }
      grp.visible = true;
      if ((frame++ & 1) && !extraFocus.length) return;    // perf: traffic is updated at half the frame rate (every frame while a feed is open)
      if (frame % 10 < 2) {                  // where people are looking: main view centre (+ open feeds' aim points)
        const r = canvas.getBoundingClientRect(), p = pick(r.left + r.width / 2, r.top + r.height / 2);
        const dist = p ? Math.hypot(camera.position.x - p.x, camera.position.z - p.z, camera.position.y - heightAt(p.x, p.z) * ex) : 3000;
        focus = (p ? [{ x: p.x, z: p.z, r: Math.min(900, Math.max(250, dist * 0.6)) }] : []).concat(extraFocus || []);
        cams = [camera.position].concat((extraFocus || []).map(f => f.cam).filter(Boolean));
      }
      const near = [];
      let nb = 0;
      for (const m of parts) for (const q of m) q.mesh.count = 0;
      for (let i = 0; i < N; i++) {
        const c = cars[i], p = posOf(c, t);
        let best = Infinity; for (const f of focus) { const d = Math.hypot(p.x - f.x, p.z - f.z) / f.r; if (d < best) best = d; }
        c.cx = p.x; c.cz = p.z; c.chd = p.hd;
        if (best <= 1) { near.push([best, c]); continue; }
        let far = true; for (const k of cams) if (Math.hypot(p.x - k.x, p.z - k.z) < FAR_R) { far = false; break; }
        if (far) continue;
        drawBox(nb++, c, t);
      }
      near.sort((a, b) => a[0] - b[0]);
      near.forEach(([, c], j) => {
        const pp = parts[c.mi];
        if (j >= NEAR_CAP || !pp.length || pp[0].mesh.count >= NEAR_CAP) { drawBox(nb++, c, t); return; }
        place(c); const burnt = c.st && t >= c.st.t;
        for (const q of pp) { M2.multiplyMatrices(M, q.local); q.mesh.setColorAt(q.mesh.count, burnt ? BURNT : WHITE); q.mesh.setMatrixAt(q.mesh.count++, M2); }
      });
      for (const m of parts) for (const q of m) { q.mesh.visible = q.mesh.count > 0; if (q.mesh.count) { q.mesh.instanceMatrix.needsUpdate = true; if (q.mesh.instanceColor) q.mesh.instanceColor.needsUpdate = true; } }
      if (frame % 30 === 0) for (const c of hit) OPFOR.debug.burn.hide((c.boat ? 'boat:' : 'civ:') + c.i, c.i >= (c.boat ? NBt : N));   // a lower setting hides its wrecks' fires too
      drawBoats(t);
      boxes.count = nb; boxes.visible = nb > 0; boxes.instanceMatrix.needsUpdate = true; if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
    }
    function place(c) { P.set(c.cx, heightAt(c.cx, c.cz) * ex, c.cz); Q.setFromAxisAngle(Y, c.chd); S.set(1, 1, 1); M.compose(P, Q, S); }
    function drawBox(k, c, t) {
      const sp = specs[c.mi]; P.set(c.cx, heightAt(c.cx, c.cz) * ex, c.cz); Q.setFromAxisAngle(Y, c.chd); S.set(sp.W * 0.85, sp.H, sp.L);
      M.compose(P, Q, S); boxes.setMatrixAt(k, M); boxes.setColorAt(k, c.st && t >= c.st.t ? BURNT : C.setHex(COLOURS[sp.colour] || 0x888888));
    }
    // ---- boats (Lee, 2026-11-03): fishing boats offshore, under the same Civilians setting. About half lie at anchor
    //      (gently swinging), the rest motor between random offshore points. Kept 150 m+ off the shore; paths stay on water.
    //      Same rules as cars: seeded, a fixed function of the clock, trackable, and they can be struck (soft) and burn.
    const BOATS = { off: 0, sparse: 6, normal: 14, rush: 28 }, BOAT_KN = [4, 8], BOAT_DRAFT = 1.4, BOAT_YAW = Math.PI;   // bow is -Z in the file
    const boats = []; let NBt = 0, boatParts = [];
    const wet = (x, z) => Math.abs(x) < HW - 50 && Math.abs(z) < HH - 50 && OPFOR.debug.waterAt(x, z);
    const offshore = (x, z) => { if (!wet(x, z)) return false; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; if (!wet(x + Math.cos(a) * 150, z + Math.sin(a) * 150)) return false; } return true; };
    const clearRun = (ax, az, bx, bz) => { const L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / 40); for (let k = 1; k < n; k++) if (!offshore(ax + (bx - ax) * k / n, az + (bz - az) * k / n)) return false; return true; };
    function buildBoats() {
      const r = rng(0xB0A75); boats.length = 0;
      for (let i = 0, tries = 0; boats.length < BOATS.rush && tries < 20000; tries++) {
        const x = (r() * 2 - 1) * HW, z = (r() * 2 - 1) * HH; if (!offshore(x, z)) continue;
        const b = { i: boats.length, boat: true, x, z, hd: r() * Math.PI * 2, anchored: r() < 0.5, seed: (0xB0A75 + boats.length * 104729) >>> 0 };
        if (!b.anchored) { b.v = (BOAT_KN[0] + r() * (BOAT_KN[1] - BOAT_KN[0])) * 0.5144; boatPath(b); }
        boats.push(b);
      }
    }
    function boatPath(b) { b.r = rng(b.seed); b.wp = [{ x: b.x, z: b.z, s: 0 }]; }
    function boatNext(b) {                       // next waypoint: 0.8–3 km away, straight run over open water
      const p = b.wp[b.wp.length - 1];
      for (let k = 0; k < 40; k++) {
        const a = b.r() * Math.PI * 2, d = 800 + b.r() * 2200, x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
        if (offshore(x, z) && clearRun(p.x, p.z, x, z)) { b.wp.push({ x, z, s: p.s + d }); return; }
      }
      b.wp.push({ x: p.x + 1, z: p.z, s: p.s + 1 });                       // boxed in: idle in place
    }
    function boatPos(b, t) {
      if (b.st && t >= b.st.t) return b.st;
      if (b.anchored) return { x: b.x, z: b.z, hd: b.hd + 0.25 * Math.sin(t / 47 + b.i) };   // swinging at anchor
      const s = b.v * t;
      if (s < b.wp[0].s) boatPath(b);
      while (b.wp.length < 2 || b.wp[b.wp.length - 1].s < s) boatNext(b);
      while (b.wp.length > 3 && b.wp[1].s < s) b.wp.shift();
      let k = 1; while (k < b.wp.length - 1 && b.wp[k].s < s) k++;
      const A = b.wp[k - 1], B = b.wp[k], f = (s - A.s) / ((B.s - A.s) || 1);
      return { x: A.x + (B.x - A.x) * f, z: A.z + (B.z - A.z) * f, hd: Math.atan2(B.x - A.x, B.z - A.z) };
    }
    async function loadBoat() {
      try {
        const gl = await new Promise((res, rej) => new THREE.GLTFLoader().load('data/m11.bin', res, undefined, rej));
        gl.scene.updateMatrixWorld(true);
        gl.scene.traverse(o => { if (!o.isMesh) return;
          const m = new THREE.InstancedMesh(o.geometry, o.material, BOATS.rush); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          for (let k = 0; k < BOATS.rush; k++) m.setColorAt(k, WHITE);   // before count = 0 (see the cars)
          m.count = 0; m.frustumCulled = false;
          grp.add(m); boatParts.push({ mesh: m, local: o.matrixWorld.clone() }); });
      } catch (e) { console.warn('Boat model failed to load:', e); }
    }
    // V wake: one flat textured quad per moving boat (Kelvin arms ~19 deg + a foam centre line), all in one draw call
    const WAKE_L = 80, WAKE_W = 2 * WAKE_L * Math.tan(19.5 * Math.PI / 180);
    const wakeTex = (() => { const c = document.createElement('canvas'); c.width = 128; c.height = 256; const g = c.getContext('2d');
      const fade = g.createLinearGradient(0, 0, 0, 256); fade.addColorStop(0, 'rgba(240,246,248,0.95)'); fade.addColorStop(1, 'rgba(240,246,248,0)');
      g.strokeStyle = fade; g.lineCap = 'round';
      g.lineWidth = 7; g.beginPath(); g.moveTo(64, 4); g.lineTo(6, 252); g.moveTo(64, 4); g.lineTo(122, 252); g.stroke();   // arms
      g.lineWidth = 16; g.globalAlpha = 0.7; g.beginPath(); g.moveTo(64, 4); g.lineTo(64, 200); g.stroke();                // churned centre
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t; })();
    const wakeGeo = new THREE.PlaneGeometry(WAKE_W, WAKE_L); wakeGeo.rotateX(-Math.PI / 2); wakeGeo.translate(0, 0, WAKE_L / 2);   // apex at the origin, trailing +Z
    const wakes = new THREE.InstancedMesh(wakeGeo, new THREE.MeshBasicMaterial({ map: wakeTex, transparent: true, depthWrite: false }), BOATS.rush);
    wakes.count = 0; wakes.frustumCulled = false; wakes.renderOrder = 2; grp.add(wakes);
    function drawBoats(t) {
      for (const q of boatParts) q.mesh.count = 0;
      wakes.count = 0;
      for (let i = 0; i < NBt; i++) {
        const b = boats[i], p = boatPos(b, t);
        let far = true; for (const k of cams) if (Math.hypot(p.x - k.x, p.z - k.z) < FAR_R * 1.7) { far = false; break; }
        if (far) continue;
        P.set(p.x, -BOAT_DRAFT, p.z); Q.setFromAxisAngle(Y, p.hd + BOAT_YAW); S.set(1, 1, 1); M.compose(P, Q, S);
        const burnt = b.st && t >= b.st.t;
        for (const q of boatParts) { M2.multiplyMatrices(M, q.local); q.mesh.setColorAt(q.mesh.count, burnt ? BURNT : WHITE); q.mesh.setMatrixAt(q.mesh.count++, M2); }
        if (!b.anchored && !burnt) {               // wake from the stern, pointing back along the track
          const fx = Math.sin(p.hd), fz = Math.cos(p.hd);
          P.set(p.x - fx * 7.5, 0.3, p.z - fz * 7.5); Q.setFromAxisAngle(Y, p.hd + Math.PI); M.compose(P, Q, S); wakes.setMatrixAt(wakes.count++, M);
        }
      }
      wakes.visible = wakes.count > 0; wakes.instanceMatrix.needsUpdate = true;
      for (const q of boatParts) { q.mesh.visible = q.mesh.count > 0; if (q.mesh.count) { q.mesh.instanceMatrix.needsUpdate = true; if (q.mesh.instanceColor) q.mesh.instanceColor.needsUpdate = true; } }
    }

    // ---- for UAS tracking: civilians near a point, as stand-ins the camera can follow like an enemy vehicle
    const proxies = new Map();
    function proxy(c) {
      let o = proxies.get(c.i); if (o) return o;
      o = { parent: grp, visible: true, userData: { t: 'civ', civ: c.i }, getWorldPosition: v => { const p = posOf(c, FIRES.debug.simT); return v.set(p.x, heightAt(p.x, p.z) * ex + 0.7, p.z); } };
      proxies.set(c.i, o); return o;
    }
    function near(x, z, R) {
      const out = [], t = FIRES.debug.simT;
      for (let i = 0; i < N; i++) { const c = cars[i], p = posOf(c, t), dd = Math.hypot(p.x - x, p.z - z); if (dd <= R) out.push({ m: proxy(c), dd }); }
      for (let i = 0; i < NBt; i++) { const b = boats[i], p = boatPos(b, t), dd = Math.hypot(p.x - x, p.z - z); if (dd <= R) out.push({ m: boatProxy(b), dd }); }
      return out;
    }
    function boatProxy(b) {
      let o = proxies.get('b' + b.i); if (o) return o;
      o = { parent: grp, visible: true, userData: { t: 'civ', boat: b.i }, getWorldPosition: v => { const p = boatPos(b, FIRES.debug.simT); return v.set(p.x, 1.5, p.z); } };
      proxies.set('b' + b.i, o); return o;
    }

    // ---- Display → Civilians
    async function set(lv) {
      level = lv; N = (LEVELS.find(l => l[0] === lv) || LEVELS[0])[2]; NBt = BOATS[lv] || 0;
      for (const [k] of LEVELS) { const b = document.getElementById('cv-' + k); if (b) b.setAttribute('aria-pressed', String(k === lv)); }
      if (N && !specs) { specs = (await load('civ/civ.json', 'json')).vehicles; initBoxes(); }
      if (N && !built && ROADNET) build();
    }
    for (const [k] of LEVELS) { const b = document.getElementById('cv-' + k); if (b) b.addEventListener('click', () => set(k)); }
    const prevRN = onRoadNet; onRoadNet = () => { if (prevRN) prevRN(); if (N && specs && !built) build(); };
    set(level);
    // room: a tracked civilian travels as { civ: i } or { boat: i }; this finds the same car or boat here
    const proxyOf = (i, boat) => boat ? (boats[i] ? boatProxy(boats[i]) : null) : (cars[i] ? proxy(cars[i]) : null);
    const hits = () => [...cars.filter(c => c.st).map(c => ({ civ: c.i, boat: false, t: c.st.t })), ...boats.filter(b => b.st).map(b => ({ civ: b.i, boat: true, t: b.st.t }))];
    return { tick, near, set, vehiclesAt, strike, proxyOf, hits, debug: { cars, boats, BOATS, boatPos, get NBt() { return NBt; }, LEVELS, PARKED, KMH, FAR_R, NEAR_CAP, get N() { return N; }, get level() { return level; }, posOf, grp, get parts() { return parts; } } };
  })();
  window.__civ = CIV.debug;

  // ---- UAS: friendly loitering munitions / one-way-attack drones.
  //      Launch points come from the scenario file (data/uas.json); the instructor can add more.
  //      Drones fly themselves (orbit or waypoints); students run the camera in pop-out feed windows.
  //      Flight is stepped from the sim clock. No handoff. Impacts roll damage in the DAMAGE module.
  //      Rule (Lee): give students nothing they would not have outside the sim. The trainer never flags
  //      targets; marks are a grid, a time and the student's own note.
  const UAS = (function () {
    const $ = id => document.getElementById(id);
    // Camera tiers (Lee, 2026-11-01): ISR sharpest with the most zoom; attack Altius degraded; Switchblade worst.
    // These are training choices, not published figures (neither maker publishes camera specs).
    // res = render scale before upscaling, noise = static strength, blur px, fov range deg, drop = chance a frame freezes.
    const CAM = {
      isr:    { res: 1,    noise: 0,    blur: 0,   fovMin: 0.5, fovMax: 60, drop: 0 },
      attack: { res: 0.55, noise: 0.08, blur: 0.5, fovMin: 2,   fovMax: 50, drop: 0 },
      sb:     { res: 0.35, noise: 0.16, blur: 0.9, fovMin: 5,   fovMax: 45, drop: 0.03 }
    };
    // Variants. Published where noted (see project doc claude/trainer-owa-uas.md); the rest are estimates.
    //  speed = transit m/s, loiter = speed once on station (max-endurance), dive m/s, endur s, alt m above ground,
    //  r orbit radius m, turn deg/s, burst = blast size. No limit on how many launch (Lee, 2026-11-02: the instructor limits them).
    //  Altius: Anduril publishes no speeds; transit 33 / loiter 22 m/s are estimates (the older Altius-600 is quoted at
    //  60 km/h cruise, 90 km/h max). Altius height 610 m = Lee's ~2,000 ft AGL assumption. Switchblade 200 m = its
    //  published 650 ft AGL operating height; its published loiter speed is 113 km/h (31 m/s).
    const S600 = [1.24, 0.6, 0.53];      // the model is an Altius-700; the 600s are ~1.0 m long, ~2.54 m span
    const TYPES = {
      altius_isr:  { fam: 'altius', label: 'Altius ISR',  short: 'ISR',  model: 'data/m08.bin', scale: S600, speed: 33, loiter: 22, dive: 0,  endur: 3.5 * 3600, alt: 610, r: 1000, turn: 12, cam: 'isr',    burst: 0,    recover: true },
      altius_600m: { fam: 'altius', label: 'Altius 600M', short: '600M', model: 'data/m08.bin', scale: S600, speed: 33, loiter: 22, dive: 60, endur: 90 * 60,    alt: 610, r: 700,  turn: 12, cam: 'attack', burst: 0.45 },
      altius_700m: { fam: 'altius', label: 'Altius 700M', short: '700M', model: 'data/m08.bin', scale: null, speed: 33, loiter: 22, dive: 65, endur: 75 * 60,    alt: 610, r: 700,  turn: 10, cam: 'attack', burst: 0.85 },
      switchblade: { fam: 'switchblade', label: 'Switchblade', short: 'SB', model: 'data/m09.bin', scale: null, speed: 31, dive: 51, endur: 40 * 60, alt: 200, r: 350, turn: 18, cam: 'sb', burst: 0.6, waveoff: true },
      lucas:       { fam: 'lucas', label: 'LUCAS', short: 'LUCAS', model: 'data/m10.bin', scale: null, speed: 51, dive: 60, endur: 6 * 3600, alt: 1000, r: 0, turn: 8, cam: null, burst: 0.9, gps: true }
    };
    const FAMS = { altius: 'Altius', switchblade: 'Switchblade', lucas: 'LUCAS' };
    const famTypes = f => Object.keys(TYPES).filter(k => TYPES[k].fam === f);
    const TURNAROUND = 10 * 60;            // a recovered ISR leaves the In Flight list after this long
    const FEED_W = 800, FEED_H = 500, MAX_FEEDS_PER_FRAME = 4;
    const lps = [], drones = [], marks = [];
    let nextId = 1, armed = null, routeDraft = null, rr = 0;
    const simT = () => FIRES.debug.simT;
    const fmt = s => { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
    const gy = (x, z) => heightAt(x, z) * ex;
    // gs: the top surface a sensor sees — roof if there is a building, else ground (buildings count even when hidden in Display)
    const gs = (x, z) => { const g = heightAt(x, z), r = CITY.roofAt(x, z, true); return (r !== null && r > g ? r : g) * ex; };
    function los(o, p) {                       // clear line from o to p (world), blocked by buildings or terrain; last 3 m ignored
      const dx = p.x - o.x, dy = p.y - o.y, dz = p.z - o.z, L = Math.hypot(dx, dy, dz), n = Math.ceil(L / 5);
      for (let k = 1; k < n; k++) { const f = k / n; if (L * (1 - f) < 3) break; const x = o.x + dx * f, z = o.z + dz * f; if (o.y + dy * f < gs(x, z) - 0.5) return false; }
      return true;
    }
    const MASK_LOSE = 2;                       // seconds a tracked vehicle can be masked before the track drops
    const gridAt = (x, z) => FIRES.debug.toGrid(CE + x, CN - z) || '—';
    const onMap = (x, z) => Math.abs(x) <= HW && Math.abs(z) <= HH;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const wrapPi = a => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
    function msg(id, text, cls) { const el = $(id); el.textContent = text; el.className = 'msg' + (cls ? ' ' + cls : ''); }

    // ---- 3D: models (loaded once, cloned per drone), map overlays (hidden from feeds)
    const tmpl = {};
    const models = new THREE.Group(), ui = new THREE.Group(); scene.add(models, ui);
    function body(type) { const T = TYPES[type], m = tmpl[T.model]; if (!m) return null; const c = m.clone(); if (T.scale) c.scale.set(T.scale[0], T.scale[1], T.scale[2]); return c; }
    if (THREE.GLTFLoader) for (const url of new Set(Object.values(TYPES).map(t => t.model))) new THREE.GLTFLoader().load(url, gl => {
      tmpl[url] = gl.scene;
      for (const d of drones) if (TYPES[d.type].model === url && !d.obj.children.length) d.obj.add(body(d.type));
    }, undefined, e => console.warn('UAS model failed to load:', url, e));
    function symTex(label, lp) {           // friendly frame: a launcher square, or a small aircraft chevron
      const c = document.createElement('canvas'); c.width = 384; c.height = 128; const g = c.getContext('2d');
      g.fillStyle = SYM_FILL; g.strokeStyle = SYM_EDGE; g.lineWidth = 5;
      if (lp) { g.fillRect(162, 10, 60, 50); g.strokeRect(162, 10, 60, 50); g.beginPath(); g.moveTo(172, 50); g.lineTo(192, 22); g.lineTo(212, 50); g.stroke(); }
      else { g.beginPath(); g.moveTo(192, 10); g.lineTo(222, 58); g.lineTo(192, 46); g.lineTo(162, 58); g.closePath(); g.fill(); g.stroke(); }
      symLabel(g, label, 192, 104, 370);
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
    }
    function sprite(label, lp) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: symTex(label, lp), depthTest: false, transparent: true, sizeAttenuation: false }));
      const k = lp ? SYM_K : SYM_K * 0.88; s.scale.set(384 * k, 128 * k, 1); s.renderOrder = 12; ui.add(s); return s;
    }
    // IDENT (Lee, 2026-11-02): pans the map to a UAS and flashes three expanding gold rings on its symbol, like a
    // radar ident. Runs on the real clock, so it works while paused.
    const identTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
      g.lineWidth = 14; g.strokeStyle = 'rgba(10,14,10,.7)'; g.beginPath(); g.arc(64, 64, 52, 0, 2 * Math.PI); g.stroke();
      g.lineWidth = 7; g.strokeStyle = '#ffd25a'; g.stroke(); const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t; })();
    function ident(d) {
      const t = controls.target, nx = d.pos.x, nz = d.pos.z, ny = gy(nx, nz);
      camera.position.x += nx - t.x; camera.position.z += nz - t.z; t.set(nx, ny, nz);   // pan: keep the view's angle and height
      if (!d.identRing) { d.identRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: identTex, depthTest: false, transparent: true, sizeAttenuation: false })); d.identRing.renderOrder = 13; ui.add(d.identRing); }
      d.identT0 = performance.now();
    }
    function identTick() {
      const now = performance.now();
      for (const d of drones) {
        const r = d.identRing; if (!r) continue;
        const u = (now - d.identT0) / 1800;
        if (u >= 1 || d.state !== 'fly') { ui.remove(r); r.material.dispose(); d.identRing = null; continue; }
        const k = (u * 3) % 1, sz = 0.025 + 0.09 * k;                       // three pulses, each growing and fading
        r.scale.set(sz, sz, 1); r.material.opacity = 1 - k; r.visible = !obs;
        r.position.copy(d.sym.position);
      }
    }
    // overlays: thick lines (friendly blue for flight paths, gold for the camera), all hidden from the feeds
    function polyline(pts, color, loop, width, o) { const l = fatLine(pts, fatMat(color, width || 3, o), loop); l.renderOrder = 11; ui.add(l); return l; }
    function setLine(l, pts, loop) { const a = []; for (const p of loop ? [...pts, pts[0]] : pts) a.push(p.x, p.y, p.z); l.geometry.dispose(); l.geometry = new THREE.LineGeometry(); l.geometry.setPositions(a); l.computeLineDistances(); }
    function dropObj(o) { if (!o) return; if (o.isLine2) return dropFat(o); ui.remove(o); models.remove(o); o.geometry && o.geometry.dispose(); o.material && o.material.dispose && o.material.dispose(); }
    function footFill() {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xd6b25a, transparent: true, opacity: 0.18, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      m.renderOrder = 10; m.frustumCulled = false; ui.add(m); return m;
    }
    const FT = 0.3048, ft = m => Math.round(m / FT / 100) * 100, ftStr = m => ft(m).toLocaleString('en-US') + ' ft';

    // ---- ground hits: march a ray to the terrain (same idea as the map pick)
    function rayGround(o, d, maxT, step) {
      maxT = maxT || 25000; step = step || 6;
      let prev = 0;
      for (let t = step; t < maxT; t += step) {
        const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
        if (y <= gs(x, z)) {                     // roofs and walls stop the ray, not just the ground
          let lo = prev, hi = t;
          for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (o.y + d.y * mid <= gs(o.x + d.x * mid, o.z + d.z * mid)) hi = mid; else lo = mid; }
          return new THREE.Vector3(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi);
        }
        prev = t;
        if (y < -50) break;
      }
      return null;
    }

    // ---- launch points: one per family; any number of each variant can launch from it
    function addLP(fam, x, z, name) {
      const n = lps.filter(l => l.fam === fam).length + 1;
      const lp = { id: nextId++, fam, name: uniqueName(name || (FAMS[fam] + (n > 1 ? ' ' + n : ''))), x, z };
      lp.sprite = sprite(lp.name, true); lp.sprite.position.set(x, gy(x, z) + 40, z);
      lps.push(lp); FIRES.log('Placed ' + lp.name + ' launch point at ' + gridAt(x, z) + (onMap(x, z) ? '' : ' (off the map)')); lpsChanged(); return lp;
    }
    // Move and remove (Lee, 2026-11-11). A drone keeps a link to its launch point (d.lp), read live, so a move just
    // redirects anything recovering. A removal re-homes its drones to the nearest launch point of the same family;
    // with none left d.lp is null: Recover is greyed and the drone flies on until tasked or out of endurance.
    function uniqueName(name, skip) { let s = name, i = 2; while (lps.some(l => l !== skip && l.name === s)) s = name + ' ' + i++; return s; }
    function lpsChanged() { draw(); saveLPs(); FIRES.lpsChanged(); }
    const LP_ON_MAP = 'Altius and Switchblade launch points must be on the map.';
    function moveLP(lp, x, z) {
      if (!onMap(x, z) && lp.fam !== 'lucas') return LP_ON_MAP;
      lp.x = x; lp.z = z; lp.sprite.position.set(x, gy(x, z) + 40, z);
      for (const d of drones) if (d.lp === lp && d.state === 'fly' && d.task.kind === 'recover') drawTask(d);
      FIRES.log('Moved ' + lp.name + ' launch point to ' + gridAt(x, z) + (onMap(x, z) ? '' : ' (off the map)')); lpsChanged(); return '';
    }
    function heir(lp) {           // nearest other launch point of the same family
      let best = null, bd = Infinity;
      for (const l of lps) if (l !== lp && l.fam === lp.fam) { const dd = Math.hypot(l.x - lp.x, l.z - lp.z); if (dd < bd) { bd = dd; best = l; } }
      return best;
    }
    function removeNote(lp) {     // '' when nothing in the air depends on it
      const a = drones.filter(d => d.lp === lp && d.state === 'fly' && TYPES[d.type].recover); if (!a.length) return '';
      const h = heir(lp), who = a.length === 1 ? a[0].name + ' is' : a.length + ' recoverable drones are';
      return who + ' airborne from ' + lp.name + (h ? ' and will re-home to ' + h.name : '. With no other ' + FAMS[lp.fam] + ' launch point, ' + (a.length === 1 ? 'it' : 'they') + ' cannot be recovered') + '.';
    }
    function removeLP(lp) {
      if (!lps.includes(lp)) return;
      const h = heir(lp);
      for (const d of drones) {
        if (d.lp !== lp) continue;
        d.lp = h;
        if (d.state !== 'fly') continue;
        if (TYPES[d.type].recover) FIRES.log(d.name + (h ? ' re-homed to ' + h.name : ' has no launch point to recover to'));
        if (d.task.kind === 'recover') { if (h) drawTask(d); else setTask(d, { kind: 'orbit', cx: d.pos.x, cz: d.pos.z, r: TYPES[d.type].r }); }
      }
      dropObj(lp.sprite); lps.splice(lps.indexOf(lp), 1); FIRES.log('Removed ' + lp.name + ' launch point'); lpsChanged();
    }
    // a Remove button that asks once when drones depend on the launch point; say(text, cls) shows the warning.
    // The ask lives on the launch point for 6 s (real clock), so the UAS panel's periodic redraw keeps it.
    function lpRemoveBtn(lp, say) {
      const b = document.createElement('button'), asked = () => lp.rmAsk && performance.now() - lp.rmAsk < 6000;
      b.textContent = asked() ? 'Confirm' : 'Remove';
      b.addEventListener('click', () => {
        const n = removeNote(lp);
        if (n && !asked()) { lp.rmAsk = performance.now(); b.textContent = 'Confirm'; say(n + ' Press Confirm to remove.', 'arm'); setTimeout(() => { if (lps.includes(lp)) { draw(); FIRES.lpsChanged(); } }, 6100); return; }
        removeLP(lp); say('Removed ' + lp.name + '.');
      });
      return b;
    }
    FIRES.linkUAS({ lps, moveLP, removeLP, lpRemoveBtn, LP_ON_MAP });
    const lpList = () => lps.map(l => ({ fam: l.fam, name: l.name, e: Math.round(CE + l.x), n: Math.round(CN - l.z) }));
    // Saved only once the start-up set is in, so a browser that never edits them keeps following data/uas.json
    let lpsReady = false;
    function saveLPs() { if (lpsReady && !NOSAVE) try { localStorage.setItem(STORE.lps, JSON.stringify(lpList())); } catch (e) {} }
    // Default set (Lee's KML v1.2 converted): { lps: [{ fam, name, e, n }] } (an old rounds field is ignored)
    let savedLPs = null; try { savedLPs = JSON.parse(localStorage.getItem(STORE.lps)); } catch (e) {}
    // a room's student starts with none: it gets the host's
    (NET.client ? Promise.resolve(null) : Array.isArray(savedLPs) ? Promise.resolve({ lps: savedLPs }) : fetch('data/uas.json').then(r => r.ok ? r.json() : null)).then(j => {
      if (!j || !Array.isArray(j.lps)) return;
      for (const l of j.lps) if (FAMS[l.fam]) { const p = toLocal(l.e, l.n); addLP(l.fam, p.x, p.z, l.name); }
    }).catch(() => {}).then(() => { lpsReady = true; });

    // ---- drones
    function launch(lp, type, target) {
      const T = TYPES[type];
      if (T.gps && !target) return msg('uas-lmsg', 'Enter a target grid for ' + T.label + '.', 'bad');
      const n = drones.filter(d => d.type === type).length + 1;
      const d = { id: nextId++, type, name: T.label + ' ' + n, lp, t0: simT(), state: 'fly', why: '',
        pos: new THREE.Vector3(lp.x, gy(lp.x, lp.z) + 3, lp.z), hdg: 0, pitch: 0, alt: T.alt,
        task: T.gps ? { kind: 'gps', tx: target.x, tz: target.z } : { kind: 'orbit', cx: lp.x, cz: lp.z, r: T.r },
        cam: { mode: 'scan', az: 0, el: -0.6, fov: 30, sx: lp.x, sz: lp.z, trk: null, last: null },
        cam3: new THREE.PerspectiveCamera(30, FEED_W / FEED_H, 1, 30000), feed: null, armedStrike: 0 };
      if (T.gps) d.hdg = Math.atan2(target.x - lp.x, target.z - lp.z);
      d.obj = new THREE.Group(); const b = body(type); if (b) d.obj.add(b); models.add(d.obj);
      d.sym = sprite(d.name, false); d.foot = null; d.spiLine = null; d.taskLine = null;
      drones.push(d);
      FIRES.log(d.name + ' launched from ' + lp.name + (T.gps ? ' on ' + gridAt(target.x, target.z) + ', time of flight about ' + fmt(eta(d)) : ''));
      drawTask(d); draw(); return d;
    }
    function eta(d) {          // seconds to impact for a GPS drone: cruise to the dive point, then the dive
      const T = TYPES[d.type], k = d.task;
      const tx = k.kind === 'gps' ? k.tx : k.lx, tz = k.kind === 'gps' ? k.tz : k.lz;
      const h = Math.hypot(tx - d.pos.x, tz - d.pos.z), agl = d.pos.y - gy(tx, tz);
      if (k.kind === 'strike') return Math.hypot(h, agl) / T.dive;
      const div = diveStart(d), cruise = Math.max(0, h - div);
      return cruise / T.speed + Math.hypot(Math.min(h, div), agl) / T.dive;
    }
    const diveStart = d => Math.max(250, (d.pos.y - gy(d.pos.x, d.pos.z)) * 0.45);   // ~65 deg dive from cruise height
    function setTask(d, task) { if (d.state !== 'fly') return; d.task = task; drawTask(d); draw(); }
    // flight paths are drawn at flight height, with a thin drop line to the ground where it helps
    // Display panel → UAS rows (Lee, 2026-11-02): what the god's-eye view draws for friendly UAS. Not saved between visits.
    const show = { sym: true, marks: true, orbits: true, routes: true, fov: true, spi: true, scan: true };
    for (const [id, key] of [['tg-u-sym', 'sym'], ['tg-u-marks', 'marks'], ['tg-u-orbit', 'orbits'], ['tg-u-route', 'routes'],
      ['tg-u-fov', 'fov'], ['tg-u-spi', 'spi'], ['tg-u-scan', 'scan']]) if (document.getElementById(id)) toggle(id, on => { show[key] = on; });
    function applyShow() {
      for (const d of drones) {
        if (d.taskLine) d.taskLine.visible = d.task.kind === 'orbit' ? show.orbits : show.routes;
        if (d.dropLine) d.dropLine.visible = show.orbits;
        if (d.foot) d.foot.visible = show.fov; if (d.footFill) d.footFill.visible = show.fov;
        if (d.spiLine) d.spiLine.visible = show.spi;
        if (d.state === 'fly' || d.state === 'falling') d.sym.visible = !obs && show.sym;
      }
      for (const lp of lps) if (lp.sprite) lp.sprite.visible = friendlyOn;     // launch points are friendly positions
      for (const mk of marks) if (mk.sprite) mk.sprite.visible = show.marks;
    }
    function scanArea(d) {                  // dashed gold circle: the disc Scan mode sweeps (same centre and radius as aim())
      if (!(show.scan && d.cam.mode === 'scan' && d.state === 'fly')) { if (d.scanLine) { dropObj(d.scanLine); d.scanLine = null; d.scanKey = null; } return; }
      const k = d.task; let cx, cz, R;
      if (k.kind === 'orbit') { cx = k.cx; cz = k.cz; R = k.r * 1.1; } else { cx = d.pos.x + Math.sin(d.hdg) * 700; cz = d.pos.z + Math.cos(d.hdg) * 700; R = 450; }
      const key = k.kind === 'orbit' ? cx + ',' + cz + ',' + R : null;
      if (d.scanLine && (key ? key === d.scanKey : uiTick % 10)) return;   // fixed area: once; area ahead of a transiting UAS: a few times a second
      const pts = [];
      for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2, x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R; pts.push(new THREE.Vector3(x, gy(x, z) + 5, z)); }
      if (d.scanLine) setLine(d.scanLine, pts, true); else d.scanLine = polyline(pts, 0xd6b25a, true, 1.5, { dashed: true, dashSize: 40, gapSize: 30, opacity: 0.85 });
      d.scanKey = key;
    }
    function drawTask(d) {
      dropObj(d.taskLine); dropObj(d.dropLine); d.taskLine = d.dropLine = null; const k = d.task;
      if (d.state !== 'fly') return;
      const BLUE = 0x6fb4ff;
      if (k.kind === 'orbit') {
        const y = gy(k.cx, k.cz) + d.alt, pts = [];
        for (let i = 0; i < 72; i++) { const a = i / 72 * Math.PI * 2; pts.push(new THREE.Vector3(k.cx + Math.cos(a) * k.r, y, k.cz + Math.sin(a) * k.r)); }
        d.taskLine = polyline(pts, BLUE, true, 3);
        d.dropLine = polyline([new THREE.Vector3(k.cx, y, k.cz), new THREE.Vector3(k.cx, gy(k.cx, k.cz), k.cz)], BLUE, false, 1.5, { dashed: true, dashSize: 25, gapSize: 25, opacity: 0.8 });
      } else if (k.kind === 'route') d.taskLine = polyline([d.pos.clone(), ...k.pts.slice(k.i).map(p => new THREE.Vector3(p.x, gy(p.x, p.z) + d.alt, p.z))], BLUE, false, 3);
      else if (k.kind === 'gps') {
        const dx = k.tx - d.pos.x, dz = k.tz - d.pos.z, h = Math.hypot(dx, dz), ds = Math.min(h, diveStart(d));
        const turn = new THREE.Vector3(k.tx - dx / h * ds, d.pos.y, k.tz - dz / h * ds);
        d.taskLine = polyline([d.pos.clone(), turn, new THREE.Vector3(k.tx, gy(k.tx, k.tz), k.tz)], 0xd6b25a, false, 3);
      } else if (k.kind === 'recover') d.taskLine = polyline([d.pos.clone(), new THREE.Vector3(d.lp.x, gy(d.lp.x, d.lp.z) + 20, d.lp.z)], BLUE, false, 3, { dashed: true, dashSize: 60, gapSize: 40 });
    }
    function clearOverlays(d) { dropObj(d.taskLine); dropObj(d.dropLine); dropObj(d.foot); dropObj(d.footFill); dropObj(d.spiLine); dropObj(d.scanLine); d.taskLine = d.dropLine = d.foot = d.footFill = d.spiLine = d.scanLine = null; d.obj.visible = false; d.sym.visible = false; }
    function kill(d, why) { d.state = 'dead'; d.why = why; clearOverlays(d); FIRES.log(d.name + ' ' + why); draw(); }
    // out of endurance (Lee, 2026-11-02): power is lost and the airframe falls — gliding on briefly, then tumbling
    // nose-down to the ground while its feed breaks up; at the ground the feed shows static and SIGNAL LOST.
    // The warhead (600M/700M, Switchblade, LUCAS) is assumed safe — no detonation on the crash.
    function startFall(d) {
      const T = TYPES[d.type];
      clearOverlays(d); d.obj.visible = true; d.sym.visible = !obs;
      d.state = 'falling'; d.why = 'out of endurance, going down';
      d.fall = { t0: simT(), vh: T.loiter || T.speed, vy: 0, spin: (d.id % 2 ? 1 : -1) * (0.5 + (d.id * 0.37) % 0.6), roll: 0 };
      d.cam.mode = 'free'; d.cam.trk = null; d.cam.slew = null;    // the gimbal is dead: the view rides the airframe
      FIRES.log(d.name + ' out of endurance at ' + gridAt(d.pos.x, d.pos.z) + ': power lost, going down.'); draw();
    }
    function fallStep(d, dt) {
      const f = d.fall, c = d.cam;
      f.vh *= Math.exp(-0.35 * dt); f.vy = Math.max(f.vy - 9.8 * dt, -55);        // drag-limited fall (~55 m/s)
      const dh = f.spin * Math.min(1, (simT() - f.t0) / 4) * dt;                   // the spin builds over a few seconds
      d.hdg = wrapPi(d.hdg + dh); f.roll += dh * 2.5;
      d.pos.x += Math.sin(d.hdg) * f.vh * dt; d.pos.z += Math.cos(d.hdg) * f.vh * dt; d.pos.y += f.vy * dt;
      d.pitch = Math.atan2(-f.vy, Math.max(1, f.vh));
      c.az += dh; c.el += (-1.35 - c.el) * Math.min(1, 0.6 * dt);
      const g = gy(d.pos.x, d.pos.z);
      if (d.pos.y <= g) { d.pos.y = g; kill(d, 'out of endurance; crashed at ' + gridAt(d.pos.x, d.pos.z) + '.'); }
    }
    function land(d) {
      d.state = 'landed'; d.why = 'recovered at ' + d.lp.name; d.landedAt = simT(); clearOverlays(d);
      FIRES.log(d.name + ' recovered at ' + d.lp.name + '.'); draw();
    }
    function vehiclesNear(x, z, R) {          // OPFOR vehicles within R metres (ground distance), nearest first
      const out = [], v = new THREE.Vector3();
      for (const [, g] of OPFOR.debug.view.g) for (const m of g.meshes) if (m.visible && m.parent) { m.getWorldPosition(v); const dd = Math.hypot(v.x - x, v.z - z); if (dd <= R) out.push({ m, dd }); }
      out.push(...CIV.near(x, z, R));            // civilians can be tracked too: the camera cannot tell friend from foe
      return out.sort((a, b) => a.dd - b.dd);
    }
    function impact(d, p) {
      const r = DAMAGE.uasImpact('U' + d.id, d.type, p.x, p.z, simT());
      FIRES.blast(CE + r.x, CN - r.z, TYPES[d.type].burst);
      const O = OPFOR.debug, nm = v => v.civ ? v.name.toUpperCase() : O.vName(v.g, v.i);
      const res = r.hits.length ? 'STRUCK ' + r.hits.map(h => nm(h.v) + ' (' + Math.round(h.d) + ' m)').join(', ')
        : r.near && r.near.d <= 30 ? Math.round(r.near.d) + ' m from ' + nm(r.near.v) + (r.near.v.struck ? ' (already struck)' : '') + ', not struck'
        : 'no vehicle within 30 m';
      kill(d, 'impact at ' + gridAt(r.x, r.z) + ': ' + res + '.');
    }
    function strikePoint(d) {
      const k = d.task;
      if (k.trk && k.trk.parent && k.trk.visible) { const v = new THREE.Vector3(); k.trk.getWorldPosition(v); k.lx = v.x; k.lz = v.z; return v; }
      return new THREE.Vector3(k.lx, gy(k.lx, k.lz) + 1, k.lz);
    }
    function commitStrike(d) {
      if (d.state !== 'fly' || !TYPES[d.type].burst) return;
      const c = d.cam;
      if (c.mode !== 'stare' && c.mode !== 'track') return note(d, 'Stare at a point or track a vehicle first.');
      const trk = c.mode === 'track' ? c.trk : null;
      d.prevTask = d.task;
      setTask(d, { kind: 'strike', trk, lx: c.mode === 'track' && c.last ? c.last.x : c.sx, lz: c.mode === 'track' && c.last ? c.last.z : c.sz });
      FIRES.log(d.name + ' committed: terminal dive on ' + gridAt(d.task.lx, d.task.lz) + (trk ? ' (tracked vehicle)' : ''));
    }
    function waveOff(d) {          // Switchblade: pull out of the dive and climb back to an orbit over the aim point
      const T = TYPES[d.type];
      if (!T.waveoff || d.state !== 'fly' || d.task.kind !== 'strike') return;
      const p = strikePoint(d);
      if (d.pos.distanceTo(p) < T.dive * 3) return note(d, 'Too late to wave off.');
      setTask(d, { kind: 'orbit', cx: p.x, cz: p.z, r: T.r }); d.pitch = 0;
      FIRES.log(d.name + ' waved off; climbing back to orbit over ' + gridAt(p.x, p.z)); note(d, 'Waved off.');
    }
    function recover(d) {
      if (!TYPES[d.type].recover || d.state !== 'fly' || !d.lp) return;
      setTask(d, { kind: 'recover' }); FIRES.log(d.name + ' returning to ' + d.lp.name + ' for recovery');
    }

    // ---- commands (multiplayer plan, Trainer/notes/trainer-multiplayer.md): every order that changes what a drone does,
    //      and every mark, goes through cmd(op, args). Args are plain data (ids and map x/z, never objects), so in a room a
    //      student's command can be sent to the host and run there. Solo: it runs here at once. The camera itself (slew,
    //      zoom, stare, track) stays with whoever is flying and will be shared as state, not as commands.
    const droneById = id => drones.find(d => d.id === id), lpById = id => lps.find(l => l.id === id);
    const OPS = {
      launch:  a => { const lp = lpById(a.lp); return lp ? launch(lp, a.type, a.target || null) : null; },
      orbit:   a => { const d = droneById(a.d); if (d && d.task.kind !== 'strike') setTask(d, { kind: 'orbit', cx: a.x, cz: a.z, r: a.r || d.task.r || TYPES[d.type].r }); },
      route:   a => { const d = droneById(a.d); if (d && a.pts && a.pts.length) setTask(d, { kind: 'route', pts: a.pts.map(p => ({ x: p.x, z: p.z })), i: 0 }); },
      alt:     a => { const d = droneById(a.d); if (d) { d.alt = a.alt; drawTask(d); draw(); } },
      radius:  a => { const d = droneById(a.d); if (d && d.task.kind === 'orbit') { d.task.r = a.r; drawTask(d); } },
      strike:  a => { const d = droneById(a.d); if (d) commitStrike(d); },
      waveoff: a => { const d = droneById(a.d); if (d) waveOff(d); },
      recover: a => { const d = droneById(a.d); if (d) recover(d); },
      mark:    a => addMark(a.d == null ? null : droneById(a.d), a.x, a.z, a.note || '', a.by),
      unmark:  a => { const mk = marks.find(m => m.id === a.id); if (mk) { dropObj(mk.sprite); marks.splice(marks.indexOf(mk), 1); draw(); } },
      take:    a => { if (droneById(a.d)) { ctl.set(a.d, a.by); draw(); } },
      release: a => { if (ctl.get(a.d) === a.by) { ctl.delete(a.d); draw(); } }
    };
    // ---- control (Lee, 2026-11-11): anyone in a room can watch any feed; one person flies each UAS. Whoever launches it
    //      flies it; Take control takes a free one (the instructor can take any); Release frees it. Solo: always yours.
    //      Map: drone id -> callsign. No entry = free (the instructor's to fly).
    const ctl = new Map();
    const flier = d => ctl.get(d.id) || null;
    const mine = d => !NET.room || flier(d) === NET.cs || (NET.host && !flier(d));
    const ORDERS = new Set(['orbit', 'route', 'alt', 'radius', 'strike', 'waveoff', 'recover']);
    // run a command for callsign `by` (the host's own, or one a student sent); orders need control of that drone
    function runCmd(op, a, by) {
      a = Object.assign({}, a, { by });
      if (ORDERS.has(op)) {
        const d = droneById(a.d); if (!d) return null;
        const f = ctl.get(d.id);
        if (by !== NET.cs ? f !== by : (f && f !== by)) return null;        // a student needs control; the instructor needs it free or theirs
        if (op === 'strike' && a.cam) applyCam(d, a.cam);                  // the flier's camera, exactly as it was when they pressed Strike
      }
      if (op === 'take' && by !== NET.cs && ctl.get(a.d) && ctl.get(a.d) !== by) return null;   // students take only a free UAS
      const r = OPS[op](a);
      if (op === 'launch' && r && NET.room) { ctl.set(r.id, by); draw(); }
      return r;
    }
    let sendCmd = null;          // set by the ROOM module: a student's commands go to the host instead of running here
    function cmd(op, a) {
      if (!OPS[op]) throw new Error('Unknown UAS command: ' + op);
      a = a || {};
      if (op === 'strike' && NET.room) { const d = droneById(a.d); if (d) a = Object.assign({}, a, { cam: serCam(d.cam) }); }
      return sendCmd ? sendCmd(op, a) : runCmd(op, a, NET.cs);
    }

    // ---- room: drone state as plain data. The host flies every drone and sends this; students mirror it and draw it.
    //      A tracked vehicle travels as { g, i } (enemy group id, vehicle index) or { civ, boat } (civilian).
    function trkRef(m) {
      if (!m) return null;
      if (m.userData && m.userData.t === 'civ') return m.userData.boat !== undefined ? { civ: m.userData.boat, boat: true } : { civ: m.userData.civ, boat: false };
      for (const [gid, v] of OPFOR.debug.view.g) { const i = v.meshes.indexOf(m); if (i >= 0) return { g: gid, i }; }
      return null;
    }
    function trkFind(r) {
      if (!r) return null;
      if (r.civ !== undefined) return CIV.proxyOf(r.civ, r.boat);
      const v = OPFOR.debug.view.g.get(r.g); return v ? v.meshes[r.i] || null : null;
    }
    const r1 = v => Math.round(v * 10) / 10;
    const serCam = c => ({ mode: c.mode, az: +c.az.toFixed(4), el: +c.el.toFixed(4), fov: +c.fov.toFixed(2), sx: r1(c.sx), sz: r1(c.sz), trk: trkRef(c.trk), last: c.last ? { x: r1(c.last.x), z: r1(c.last.z) } : null });
    function applyCam(d, s) {
      const c = d.cam; c.mode = s.mode; c.az = s.az; c.el = s.el; c.fov = s.fov; c.sx = s.sx; c.sz = s.sz; c.last = s.last;
      c.trk = s.mode === 'track' ? trkFind(s.trk) : null; if (s.mode === 'track' && !c.trk) c.mode = 'stare';
      c.slew = null;
    }
    function serTask(k) { const o = Object.assign({}, k); if ('trk' in o) o.trk = trkRef(k.trk); if (o.pts) o.pts = o.pts.map(p => ({ x: r1(p.x), z: r1(p.z) })); return o; }
    function readTask(o) { const k = Object.assign({}, o); if ('trk' in k) k.trk = trkFind(o.trk); return k; }
    function serDrone(d) {
      return { id: d.id, type: d.type, name: d.name, lp: d.lp ? d.lp.id : null, t0: d.t0, state: d.state, why: d.why, landedAt: d.landedAt,
        pos: [r1(d.pos.x), r1(d.pos.y), r1(d.pos.z)], hdg: +d.hdg.toFixed(4), pitch: +d.pitch.toFixed(4), alt: d.alt,
        task: serTask(d.task), cam: serCam(d.cam), fall: d.fall ? { t0: d.fall.t0, roll: +d.fall.roll.toFixed(3) } : null };
    }
    const netState = () => ({ t: simT(), drones: drones.map(serDrone), ctl: [...ctl],
      lps: lps.map(l => ({ id: l.id, fam: l.fam, name: l.name, x: r1(l.x), z: r1(l.z) })),
      marks: marks.map(m => ({ id: m.id, t: m.t, x: m.x, z: m.z, by: m.by, note: m.note })) });
    // a student: make a mirror of a drone the host launched (the same object launch() builds, without the log)
    function mirror(s) {
      const T = TYPES[s.type];
      const d = { id: s.id, type: s.type, name: s.name, lp: lpById(s.lp), t0: s.t0, state: 'fly', why: '',
        pos: new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]), hdg: s.hdg, pitch: s.pitch, alt: s.alt, task: readTask(s.task),
        cam: { mode: 'scan', az: 0, el: -0.6, fov: 30, sx: s.pos[0], sz: s.pos[2], trk: null, last: null },
        cam3: new THREE.PerspectiveCamera(30, FEED_W / FEED_H, 1, 30000), feed: null, armedStrike: 0 };
      d.obj = new THREE.Group(); const b = body(s.type); if (b) d.obj.add(b); models.add(d.obj);
      d.sym = sprite(d.name, false); d.foot = null; d.spiLine = null; d.taskLine = null;
      drones.push(d); drawTask(d); return d;
    }
    let lastLPs = '', lastMarks = '';
    function applyNet(o) {
      const lj = JSON.stringify(o.lps);
      if (lj !== lastLPs) {                       // the instructor's launch points, with the host's ids
        lastLPs = lj;
        for (const lp of lps) dropObj(lp.sprite); lps.length = 0;
        for (const l of o.lps) { const lp = Object.assign({}, l); lp.sprite = sprite(lp.name, true); lp.sprite.position.set(lp.x, gy(lp.x, lp.z) + 40, lp.z); lps.push(lp); }
        for (const d of drones) d.lp = d.lp ? lpById(d.lp.id) : null;
        FIRES.lpsChanged();
      }
      const now = performance.now();
      for (const s of o.drones) {
        let d = droneById(s.id); if (!d) d = mirror(s);
        d.net = { pos: new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]), t: o.t, prev: d.net, at: now };
        d.hdgNet = s.hdg; d.pitch = s.pitch; d.alt = s.alt; d.t0 = s.t0; d.landedAt = s.landedAt; d.why = s.why; d.lp = lpById(s.lp);
        if (s.fall) d.fall = Object.assign(d.fall || {}, s.fall);
        if (s.state !== d.state) {
          const was = d.state; d.state = s.state;
          if (s.state === 'fly') { d.obj.visible = true; drawTask(d); }
          else if (s.state === 'falling') { clearOverlays(d); d.obj.visible = true; }
          else if (was === 'fly' || was === 'falling') clearOverlays(d);
        }
        const tj = JSON.stringify(s.task);
        if (tj !== d.taskJ) { d.taskJ = tj; d.task = readTask(s.task); drawTask(d); }
        if (!mine(d) || !d.camSent) applyCam(d, s.cam);              // the flier's own camera stays theirs
        if (mine(d)) d.camSent = true;
      }
      const cj = JSON.stringify(o.ctl);
      if (cj !== JSON.stringify([...ctl])) { ctl.clear(); for (const [k, v] of o.ctl) ctl.set(k, v); draw(); }
      const mj = JSON.stringify(o.marks);
      if (mj !== lastMarks) {
        lastMarks = mj;
        for (const mk of marks) dropObj(mk.sprite); marks.length = 0;
        for (const m of [...o.marks].reverse()) addMark(null, m.x, m.z, m.note, m.by, m);
        draw();
      }
    }
    // a student: the camera of each drone they fly, when it has changed (sent to the host a few times a second)
    const camLast = new Map();
    function camOut() {
      const out = [];
      for (const d of drones) if (d.state === 'fly' && flier(d) === NET.cs) { const c = serCam(d.cam), j = JSON.stringify(c); if (camLast.get(d.id) !== j) { camLast.set(d.id, j); out.push({ d: d.id, cam: c }); } }
      return out;
    }
    // a student: move each mirror toward where the host says it is, projected on by its last known velocity
    function netMove() {
      const t = simT();
      for (const d of drones) {
        const n = d.net; if (!n) continue;
        let px = n.pos.x, py = n.pos.y, pz = n.pos.z;
        if (n.prev && n.t > n.prev.t && d.state === 'fly') {
          const k = Math.min(1, Math.max(0, t - n.t)) / (n.t - n.prev.t);      // project at most 1 s ahead
          px += (n.pos.x - n.prev.pos.x) * k; py += (n.pos.y - n.prev.pos.y) * k; pz += (n.pos.z - n.prev.pos.z) * k;
        }
        const far = Math.hypot(px - d.pos.x, pz - d.pos.z) > 300, a = far ? 1 : 0.25;
        d.pos.x += (px - d.pos.x) * a; d.pos.y += (py - d.pos.y) * a; d.pos.z += (pz - d.pos.z) * a;
        if (d.hdgNet !== undefined) d.hdg = wrapPi(d.hdg + wrapPi(d.hdgNet - d.hdg) * a);
      }
    }

    // ---- flight: steered toward a target point, limited turn rate, eased to the set height
    function steer(d, tx, tz, dt, spd) {
      const T = TYPES[d.type], want = Math.atan2(tx - d.pos.x, tz - d.pos.z), maxT = T.turn * Math.PI / 180 * dt;
      spd = spd || T.speed; d.spd = spd;
      d.hdg = wrapPi(d.hdg + clamp(wrapPi(want - d.hdg), -maxT, maxT));
      d.pos.x += Math.sin(d.hdg) * spd * dt; d.pos.z += Math.cos(d.hdg) * spd * dt;
    }
    function step(d, dt) {
      const T = TYPES[d.type];
      if (d.state === 'landed') { if (simT() - d.landedAt >= TURNAROUND) { d.state = 'ready'; draw(); } return; }
      if (d.state === 'falling') return fallStep(d, dt);
      if (d.state !== 'fly') return;
      if (simT() - d.t0 > T.endur) return startFall(d);
      if (!d.warned && T.endur - (simT() - d.t0) < 300) { d.warned = true; FIRES.log(d.name + ': 5 minutes of endurance left.'); }
      const k = d.task;
      if (k.kind === 'strike') {
        const p = strikePoint(d), dx = p.x - d.pos.x, dy = p.y - d.pos.y, dz = p.z - d.pos.z, L = Math.hypot(dx, dy, dz), s = T.dive * dt;
        if (L <= s + 3 || d.pos.y <= gy(d.pos.x, d.pos.z)) return impact(d, p);
        d.pos.x += dx / L * s; d.pos.y += dy / L * s; d.pos.z += dz / L * s;
        d.hdg = Math.atan2(dx, dz); d.pitch = Math.atan2(-dy, Math.hypot(dx, dz)); return;
      }
      d.pitch = 0;
      if (k.kind === 'gps') {
        if (Math.hypot(k.tx - d.pos.x, k.tz - d.pos.z) <= diveStart(d)) { d.task = { kind: 'strike', trk: null, lx: k.tx, lz: k.tz }; drawTask(d); return step(d, dt); }
        steer(d, k.tx, k.tz, dt);
      } else if (k.kind === 'recover') {
        const h = Math.hypot(d.lp.x - d.pos.x, d.lp.z - d.pos.z), agl = d.pos.y - gy(d.pos.x, d.pos.z);
        if (h < 120 && agl < 40) return land(d);
        if (h > 150) steer(d, d.lp.x, d.lp.z, dt);
        else { d.pos.x += (d.lp.x - d.pos.x) * Math.min(1, dt * 0.5); d.pos.z += (d.lp.z - d.pos.z) * Math.min(1, dt * 0.5); }
        const wantY = gy(d.pos.x, d.pos.z) + (h < 1500 ? Math.max(5, h * 0.25) : d.alt);
        d.pos.y += clamp(wantY - d.pos.y, -8 * dt, 8 * dt); return;
      } else {
        let tx, tz, spd = T.speed;
        if (k.kind === 'route') {
          const w = k.pts[k.i];
          if (Math.hypot(w.x - d.pos.x, w.z - d.pos.z) < 80) { k.i++; if (k.i >= k.pts.length) { d.task = { kind: 'orbit', cx: w.x, cz: w.z, r: T.r }; drawTask(d); draw(); return step(d, dt); } }
          tx = k.pts[k.i].x; tz = k.pts[k.i].z;
        } else {
          const ox = d.pos.x - k.cx, oz = d.pos.z - k.cz, D = Math.hypot(ox, oz);
          if (D > k.r * 1.5) { tx = k.cx; tz = k.cz; }
          else { const th = Math.atan2(oz, ox) + 0.45; tx = k.cx + Math.cos(th) * k.r; tz = k.cz + Math.sin(th) * k.r; }
          if (D <= k.r * 1.3) spd = T.loiter || T.speed;          // on station: slow to max-endurance speed
        }
        steer(d, tx, tz, dt, spd);
      }
      const wantY = gy(d.pos.x, d.pos.z) + d.alt; d.pos.y += clamp(wantY - d.pos.y, -8 * dt, 8 * dt);
    }

    // ---- camera: scan (hands-off sweep), stare (ground point; drags, arrows and prepoint slew it), track (a vehicle)
    const tv = new THREE.Vector3();
    function aim(d) {
      const c = d.cam;
      if (c.mode === 'track') {
        if (c.trk && c.trk.parent && c.trk.visible) {
          c.trk.getWorldPosition(tv);
          const seen = los(d.cam3.position, tv.clone().setY(tv.y + 1.5));          // a building or crest between camera and vehicle
          if (seen) c.maskT = null; else if (c.maskT == null) c.maskT = simT();
          if (seen || simT() - c.maskT < MASK_LOSE) { c.last = { x: tv.x, z: tv.z }; return tv.clone().setY(tv.y + 1); }
          c.maskT = null; c.mode = 'stare'; c.sx = c.last.x; c.sz = c.last.z; note(d, 'Track lost: target masked.');
        } else { c.mode = 'stare'; if (c.last) { c.sx = c.last.x; c.sz = c.last.z; } note(d, 'Track lost.'); }
      }
      if (c.mode === 'stare') {
        const s = c.slew;                   // prepoint: swing smoothly from the old point to the new one, then hold it
        if (s && s.tx === c.sx && s.tz === c.sz) {
          const u = Math.min(1, (performance.now() - s.t0) / s.dur), k = u * u * (3 - 2 * u);
          if (u < 1) { const x = s.fx + (c.sx - s.fx) * k, z = s.fz + (c.sz - s.fz) * k; return new THREE.Vector3(x, gs(x, z), z); }
          c.slew = null;
        }
        return new THREE.Vector3(c.sx, gs(c.sx, c.sz), c.sz);   // a stare on a roof holds the roof
      }
      if (c.mode === 'scan') {
        let cx, cz, R;
        if (d.task.kind === 'orbit') { cx = d.task.cx; cz = d.task.cz; R = d.task.r * 1.1; }
        else { cx = d.pos.x + Math.sin(d.hdg) * 700; cz = d.pos.z + Math.cos(d.hdg) * 700; R = 450; }
        const t = simT() + d.id * 37, rho = R * (0.12 + 0.88 * (0.5 + 0.5 * Math.sin(t * 0.045))), phi = t * 0.09;
        const x = cx + Math.cos(phi) * rho, z = cz + Math.sin(phi) * rho; return new THREE.Vector3(x, gy(x, z), z);
      }
      return null;
    }
    function updateCam(d, aspect) {
      const cam = d.cam3, c = d.cam, tier = CAM[TYPES[d.type].cam] || CAM.attack;
      c.fov = clamp(c.fov, tier.fovMin, tier.fovMax);
      cam.aspect = aspect || FEED_W / FEED_H; cam.fov = c.fov;
      cam.position.set(d.pos.x, d.pos.y - 1.5, d.pos.z);
      const a = aim(d);
      if (a) { const dx = a.x - cam.position.x, dy = a.y - cam.position.y, dz = a.z - cam.position.z; c.az = Math.atan2(dx, dz); c.el = Math.atan2(dy, Math.hypot(dx, dz)); }
      c.el = clamp(c.el, -1.55, 0.2);
      tv.set(Math.sin(c.az) * Math.cos(c.el), Math.sin(c.el), Math.cos(c.az) * Math.cos(c.el)).add(cam.position);
      cam.lookAt(tv); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    }
    const rc = new THREE.Raycaster(), nv = new THREE.Vector2();
    function groundThrough(d, nx, ny) { nv.set(nx, ny); rc.setFromCamera(nv, d.cam3); return rayGround(rc.ray.origin, rc.ray.direction); }
    // ground-stabilised slew (Lee, 2026-11-02): a mouse drag or arrow key turns the view by an angle, then locks on the
    // ground point now under the crosshair (stare), so the picture no longer drifts as the drone flies its orbit.
    // Slewing breaks a track, as on a real sensor.
    const sd = new THREE.Vector3();
    function slewBy(d, daz, del) {
      const c = d.cam; updateCam(d);
      const az = c.az + daz, el = clamp(c.el + del, -1.55, -0.01);
      sd.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      const p = rayGround(d.cam3.position, sd);
      if (!p) return del ? slewBy(d, daz, 0) : false;   // only sky that way: keep the sideways part, drop the upward part
      c.mode = 'stare'; c.sx = p.x; c.sz = p.z; c.trk = null; c.slew = null; return true;
    }
    let lastKeySlew = 0;
    function keySlew() {                    // held arrow keys in a feed window: half a field of view per second, Shift x3
      const now = performance.now(), dt = lastKeySlew ? Math.min(0.25, (now - lastKeySlew) / 1000) : 0; lastKeySlew = now;
      for (const d of drones) {
        const K = d.slewKeys;
        if (!d.feed || !K || !K.size || d.state !== 'fly' || !mine(d)) continue;
        const rate = d.cam.fov * Math.PI / 180 * (d.slewFast ? 1.5 : 0.5) * dt;
        const daz = ((K.has('ArrowLeft') ? 1 : 0) - (K.has('ArrowRight') ? 1 : 0)) * rate;
        const del = ((K.has('ArrowUp') ? 1 : 0) - (K.has('ArrowDown') ? 1 : 0)) * rate;
        if (daz || del) slewBy(d, daz, del);
      }
    }

    // ---- per-frame: fly (sub-stepped so 10x stays stable), then overlays
    let lastSim = null, uiTick = 0;
    function tick() {
      const t = simT(); if (lastSim === null) lastSim = t;
      let dt = t - lastSim; lastSim = t; if (dt < 0) dt = 0;
      if (NET.client) netMove();                 // a room's student: the host flies every drone
      else while (dt > 1e-6) { const h = Math.min(0.25, dt); for (const d of drones) step(d, h); dt -= h; }
      for (const d of drones) {
        if (d.state === 'falling') {
          d.obj.position.copy(d.pos); d.obj.rotation.set(d.pitch, d.hdg, d.fall.roll, 'YXZ');
          d.sym.position.set(d.pos.x, d.pos.y + 25, d.pos.z); d.sym.visible = !obs; continue;
        }
        if (d.state !== 'fly') continue;
        d.obj.position.copy(d.pos); d.obj.rotation.set(d.pitch, d.hdg, 0, 'YXZ');
        d.sym.position.set(d.pos.x, d.pos.y + 25, d.pos.z); d.sym.visible = !obs;
        if ((d.task.kind === 'gps' || d.task.kind === 'recover' || d.task.kind === 'route') && uiTick % 10 === 0) drawTask(d);
        if (!TYPES[d.type].cam) continue;           // LUCAS: no camera, no footprint
        updateCam(d);
        const pts = [];
        for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          nv.set(nx, ny); rc.setFromCamera(nv, d.cam3);
          const h = rayGround(rc.ray.origin, rc.ray.direction, 9000, 20);
          pts.push(h ? h.setY(h.y + 4) : rc.ray.origin.clone().addScaledVector(rc.ray.direction, 3000).setY(gy(d.pos.x, d.pos.z) + 4));
        }
        if (!d.foot) d.foot = polyline(pts, 0xd6b25a, true, 2); else setLine(d.foot, pts, true);
        if (!d.footFill) d.footFill = footFill();
        { const a = d.footFill.geometry.attributes.position; pts.forEach((q, i) => a.setXYZ(i, q.x, q.y, q.z)); a.needsUpdate = true; }
        nv.set(0, 0); rc.setFromCamera(nv, d.cam3); d.spi = rayGround(rc.ray.origin, rc.ray.direction);
        const sp = [d.pos.clone(), d.spi ? d.spi.clone().setY(d.spi.y + 2) : d.pos.clone()];
        if (!d.spiLine) d.spiLine = polyline(sp, 0xd6b25a, false, 1.5, { dashed: true, dashSize: 30, gapSize: 20 }); else setLine(d.spiLine, sp, false);
      }
      for (const d of drones) if (TYPES[d.type].cam) scanArea(d);
      applyShow();
      identTick();
      ui.visible = !obs;
      if (++uiTick % 15 === 0 && !$('w-uas').contains(document.activeElement)) draw();   // don't rebuild under a focused input or open select
    }

    // ---- feeds: the main window renders every feed (terrain loaded once) and copies each into its pop-out
    function hideForFeed(on, keep) {
      const list = [groups.grid, groups.sketch, ui, FIRES.debug.unitGroup, FIRES.debug.arcGroup, OPFOR.debug.lines, OPFOR.debug.handles, OPFOR.debug.pips];
      if (on) { keep.length = 0; for (const o of list) { keep.push(o.visible); o.visible = false; }
        for (const [, g] of OPFOR.debug.view.g) { keep.push(g.sym.visible); g.sym.visible = false; } }
      else { let i = 0; for (const o of list) o.visible = keep[i++]; for (const [, g] of OPFOR.debug.view.g) g.sym.visible = keep[i++]; }
      // the sensor sees the real world: buildings, trees and the enemy show in the feed even if the instructor hid them
      const real = [window.__city.bGrp, window.__city.tGrp, OPFOR.debug.root];
      if (on) { keep.realV = real.map(o => o.visible); for (const o of real) o.visible = true; }
      else if (keep.realV) real.forEach((o, i) => { o.visible = keep.realV[i]; });
    }
    const kept = [];
    const noise = (() => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'), im = g.createImageData(256, 256);
      for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; } g.putImageData(im, 0, 0); return c; })();
    const small = document.createElement('canvas'), sctx = small.getContext('2d');
    function snow(g, alpha, scale) {        // seamless TV snow: the noise tile as a repeating pattern at a random offset
      if (!g.snowPat) g.snowPat = g.createPattern(noise, 'repeat');
      g.save(); g.globalAlpha = alpha; g.setTransform(scale, 0, 0, scale, -Math.random() * 256 * scale, -Math.random() * 256 * scale);
      g.fillStyle = g.snowPat; g.fillRect(0, 0, FEED_W / scale + 256, FEED_H / scale + 256); g.restore();
    }
    function renderFeeds() {
      for (const d of drones) if (d.feed && d.feed.closed) d.feed = null;
      keySlew();
      const open = drones.filter(d => d.feed);
      if (!open.length) return;
      const pr = renderer.getPixelRatio(), cw = canvas.width / pr, ch = canvas.height / pr;
      const fw = Math.min(FEED_W, cw), fh = Math.min(FEED_H, ch);
      hideForFeed(true, kept); renderer.setScissorTest(true);
      const n = Math.min(open.length, MAX_FEEDS_PER_FRAME);
      for (let j = 0; j < n; j++) {
        const d = open[(rr + j) % open.length], g = d.fctx, tier = CAM[TYPES[d.type].cam];
        if (d.state !== 'fly' && d.state !== 'falling') {
          g.filter = 'none'; g.fillStyle = '#000'; g.fillRect(0, 0, FEED_W, FEED_H);
          if (d.state === 'dead') {                 // snow: two layers of the noise tile at random offsets, then a dark band for the text
            snow(g, 1, 2); snow(g, 0.35, 1);
            g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, FEED_H / 2 - 44, FEED_W, 84);
          }
          g.fillStyle = '#d6b25a'; g.font = '600 28px monospace'; g.textAlign = 'center';
          g.fillText(d.state === 'dead' ? 'SIGNAL LOST' : 'RECOVERED', FEED_W / 2, FEED_H / 2 - 10); g.font = '16px monospace'; g.fillText(d.why.slice(0, 80), FEED_W / 2, FEED_H / 2 + 22); hud(d); continue;
        }
        const falling = d.state === 'falling', fu = falling ? Math.min(1, (simT() - d.fall.t0) / 12) : 0;   // how far the picture has broken up
        if (falling && Math.random() < 0.05 + 0.3 * fu) { hud(d); continue; }        // dropped frames, more as it falls
        if (tier.drop && Math.random() < tier.drop) { hud(d); continue; }          // frozen frame
        updateCam(d, fw / fh); d.obj.visible = false;
        renderer.setViewport(0, 0, fw, fh); renderer.setScissor(0, 0, fw, fh); renderer.render(scene, d.cam3);
        d.obj.visible = true;
        const sw = Math.max(80, Math.round(FEED_W * tier.res)), sh = Math.max(50, Math.round(FEED_H * tier.res));
        if (tier.res < 1) {
          if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
          sctx.drawImage(canvas, 0, canvas.height - fh * pr, fw * pr, fh * pr, 0, 0, sw, sh);
          g.filter = tier.blur ? 'blur(' + tier.blur + 'px)' : 'none'; g.imageSmoothingEnabled = true;
          g.drawImage(small, 0, 0, sw, sh, 0, 0, FEED_W, FEED_H); g.filter = 'none';
        } else g.drawImage(canvas, 0, canvas.height - fh * pr, fw * pr, fh * pr, 0, 0, FEED_W, FEED_H);
        if (tier.noise) { g.globalAlpha = tier.noise; g.drawImage(noise, -Math.random() * 200, -Math.random() * 200, 1024, 1024); g.globalAlpha = 1; }
        if (falling) {
          const jx = (Math.random() - 0.5) * 30 * fu, jy = (Math.random() - 0.5) * 20 * fu;      // shake and tearing
          if (jx || jy) g.drawImage(g.canvas, jx, jy);
          for (let b = Math.floor(1 + 4 * fu * Math.random()); b > 0; b--) {
            const y = Math.random() * FEED_H, h = 4 + Math.random() * 30 * fu, sx = (Math.random() - 0.5) * 120 * fu;
            g.drawImage(g.canvas, 0, y, FEED_W, h, sx, y, FEED_W, h);
          }
          snow(g, 0.05 + 0.75 * fu * fu, 2);           // light at first, near-total just before impact
        }
        g.strokeStyle = 'rgba(230,233,223,.85)'; g.lineWidth = 1.5; const X = FEED_W / 2, Y = FEED_H / 2;
        g.beginPath(); g.moveTo(X - 30, Y); g.lineTo(X - 8, Y); g.moveTo(X + 8, Y); g.lineTo(X + 30, Y); g.moveTo(X, Y - 30); g.lineTo(X, Y - 8); g.moveTo(X, Y + 8); g.lineTo(X, Y + 30); g.stroke();
        hud(d);
      }
      rr = (rr + n) % Math.max(1, open.length);
      renderer.setScissorTest(false); renderer.setViewport(0, 0, cw, ch); hideForFeed(false, kept);
    }
    function hud(d) {
      const w = d.feed; if (!w || w.closed) return; const doc = w.document, T = TYPES[d.type];
      if ((d.hudN = (d.hudN || 0) + 1) % 6) return;
      const fly = d.state === 'fly' || d.state === 'falling', left = Math.max(0, T.endur - (simT() - d.t0)), spi = d.state === 'fly' ? d.spi : null;
      doc.getElementById('h-name').textContent = d.name;
      doc.getElementById('h-mode').textContent = d.state === 'falling' ? 'NO POWER' : !fly ? (d.state === 'dead' ? 'LOST' : 'RECOVERED') : d.task.kind === 'strike' ? 'TERMINAL' : d.task.kind === 'recover' ? 'RTB' : d.cam.mode.toUpperCase();
      const agl = d.pos.y - gy(d.pos.x, d.pos.z);       // true metres above ground (the scene may be height-exaggerated)
      doc.getElementById('h-pos').textContent = fly ? gridAt(d.pos.x, d.pos.z) : '—';
      doc.getElementById('h-alt').textContent = fly ? ftStr(agl) + ' AGL · ' + ftStr(heightAt(d.pos.x, d.pos.z) + agl) + ' MSL' : '—';
      doc.getElementById('h-spi').textContent = fly && spi ? gridAt(spi.x, spi.z) : '—';
      doc.getElementById('h-rng').textContent = fly && spi ? (spi.distanceTo(d.pos) / 1000).toFixed(2) + ' km' : '—';
      doc.getElementById('h-fov').textContent = d.cam.fov.toFixed(1) + '°';
      doc.getElementById('h-end').textContent = fly ? fmt(left) : '—';
      doc.getElementById('h-end').style.color = fly && left < 300 ? '#ff8a73' : '';   // last 5 minutes in red
      doc.getElementById('h-t').textContent = 'T+' + fmt(simT());
      if (NET.room) { doc.getElementById('h-ctlw').hidden = false; doc.getElementById('h-ctl').textContent = flier(d) ? (flier(d) === NET.cs ? 'YOU' : flier(d)) : NET.host ? 'YOU (free)' : 'INSTRUCTOR';
        doc.body.classList.toggle('watch', !mine(d)); }
      for (const m of ['scan', 'stare', 'track']) doc.getElementById('m-' + m).setAttribute('aria-pressed', String(d.cam.mode === m));
      const sb = doc.getElementById('f-strike');
      if (sb) { sb.disabled = !fly || d.task.kind === 'strike' || d.task.kind === 'recover';
        if (d.armedStrike && performance.now() > d.armedStrike) { d.armedStrike = 0; sb.textContent = 'Strike'; sb.classList.remove('armed'); } }
      const ab = doc.getElementById('f-abort'); if (ab) ab.hidden = !(fly && d.task.kind === 'strike');
      const rb = doc.getElementById('f-recover'); if (rb) rb.disabled = !fly || d.task.kind === 'recover';
    }
    function note(d, text) { const w = d.feed; if (w && !w.closed) { const el = w.document.getElementById('f-msg'); el.textContent = text; } }
    const FEED_HTML = (name, T) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name} — UAS feed</title><style>
      html,body{margin:0;background:#0b0f0c;color:#e6e9df;font:13px ui-monospace,Menlo,Consolas,monospace;height:100%}
      #wrap{display:flex;flex-direction:column;height:100%}
      #fv{display:block;width:100%;flex:1 1 auto;min-height:0;object-fit:contain;background:#000;cursor:crosshair}
      #hud{position:absolute;top:6px;left:8px;right:8px;display:flex;flex-wrap:wrap;gap:4px 14px;pointer-events:none;text-shadow:0 0 3px #000}
      #hud b{color:#d6b25a;font-weight:600;margin-right:4px}
      #bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;border-top:1px solid #2c3a2f}
      button,input{font:12px ui-monospace,Menlo,Consolas,monospace;color:#e6e9df;background:#141b16;border:1px solid #3a4a3d;border-radius:4px;padding:4px 8px}
      button[aria-pressed=true]{border-color:#d6b25a;color:#d6b25a}
      button:disabled{opacity:.4} [hidden]{display:none!important}
      #f-strike{border-color:#c8402c;color:#ffb3a5;font-weight:600} #f-strike.armed{background:#5a1a10}
      #f-abort{border-color:#d6b25a;color:#d6b25a;font-weight:600}
      #f-note{flex:1 1 160px}
      #f-msg{color:#9aa39a;flex-basis:100%;min-height:1.2em}
      .sep{width:1px;height:20px;background:#2c3a2f}
      body.watch #bar button:not(#f-mark),body.watch #f-pp{opacity:.35}
    </style></head><body><div id="wrap">
      <div style="position:relative;flex:1 1 auto;min-height:0;display:flex"><canvas id="fv" width="${FEED_W}" height="${FEED_H}"></canvas>
      <div id="hud"><span><b>UAS</b><span id="h-name"></span></span><span><b>MODE</b><span id="h-mode"></span></span><span><b>POS</b><span id="h-pos"></span></span><span><b>ALT</b><span id="h-alt"></span></span>
      <span><b>SPI</b><span id="h-spi"></span></span><span><b>RNG</b><span id="h-rng"></span></span><span><b>FOV</b><span id="h-fov"></span></span>
      <span><b>END</b><span id="h-end"></span></span><span id="h-t"></span><span id="h-ctlw" hidden><b>FLOWN BY</b><span id="h-ctl"></span></span></div></div>
      <div id="bar">
        <button id="m-scan" title="Hands-off sweep of the orbit area">Scan</button>
        <button id="m-stare" title="Click the video: lock on that ground point">Stare</button><button id="m-track" title="Shift-click a vehicle in the video to follow it">Track</button>
        <span class="sep"></span><button id="z-in" title="Zoom in (or mouse wheel)">Zoom +</button><button id="z-out" title="Zoom out">Zoom −</button>
        <button id="f-orbit" title="Move the orbit to the point under the crosshair">Orbit here</button>
        ${T.fam === 'altius' ? '<span class="sep"></span><input id="f-pp" value="4Q FJ " size="17" spellcheck="false" aria-label="Prepoint grid" title="Grid to slew the camera to (Enter)"><button id="f-ppgo" title="Slew the camera to this grid and hold it">Prepoint</button>' : ''}
        <span class="sep"></span><input id="f-note" placeholder="note for the mark (what you see)"><button id="f-mark" title="Mark the grid under the crosshair">Mark</button>
        ${T.burst ? '<button id="f-strike" title="Dive on the stare point or tracked vehicle (click twice)">Strike</button>' : ''}
        ${T.waveoff ? '<button id="f-abort" hidden title="Pull out of the dive and climb back to orbit">Wave off</button>' : ''}
        ${T.recover ? '<button id="f-recover" title="Fly back to the launch point and land">Recover</button>' : ''}
        <div id="f-msg">Click: stare at a point. Shift-click: track a vehicle. Drag or arrow keys: slew (Shift: faster). Wheel or +/−: zoom.</div>
      </div></div></body></html>`;
    // reminder before the first feed (and again if the browser blocks one): feeds open as pop-up windows
    let modal = null, skipModal = false;
    try { skipModal = localStorage.getItem('fist-uas-popup-ok') === '1'; } catch (e) {}
    function feedModal(d, blocked) {
      if (!modal) {
        modal = document.createElement('div'); modal.className = 'umodal'; modal.hidden = true;
        modal.innerHTML = '<div class="umodal-b" role="dialog" aria-modal="true" aria-labelledby="umodal-h"><h3 id="umodal-h"></h3><p class="umodal-t"></p>' +
          '<p class="umodal-t2">If nothing opens, the browser blocked it: click the blocked pop-up icon at the right end of the address bar, choose <b>Always allow pop-ups</b> for this site, then press <b>View feed</b> again.</p>' +
          '<label class="umodal-c"><input type="checkbox"> Don\'t show this again</label><div class="row"><button class="feed-btn umodal-go">Open feed</button><button class="umodal-x">Cancel</button></div></div>';
        document.body.appendChild(modal);
        modal.querySelector('.umodal-x').addEventListener('click', () => { modal.hidden = true; });
        modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
        modal.querySelector('.umodal-go').addEventListener('click', () => {
          if (modal.querySelector('input').checked) { skipModal = true; try { localStorage.setItem('fist-uas-popup-ok', '1'); } catch (e) {} }
          modal.hidden = true; if (modal.d) openFeed(modal.d, true);
        });
      }
      modal.d = d;
      modal.querySelector('h3').textContent = blocked ? 'The browser blocked the feed window' : 'Drone feeds open in their own window';
      modal.querySelector('.umodal-t').textContent = blocked ? 'Pop-ups are blocked for this site, so ' + d.name + "'s feed could not open."
        : "Each drone's camera opens in a separate window, so you can drag it to another monitor.";
      modal.querySelector('.umodal-c').hidden = blocked;
      modal.hidden = false; modal.querySelector('.umodal-go').focus();
    }
    function openFeed(d, confirmed) {
      if (!TYPES[d.type].cam) return;
      if (d.feed && !d.feed.closed) { d.feed.focus(); return; }
      if (!confirmed && !skipModal) return feedModal(d, false);
      const w = window.open('', 'uas-feed-' + d.id, 'width=860,height=640');
      if (!w) return feedModal(d, true);
      w.document.open(); w.document.write(FEED_HTML(d.name, TYPES[d.type])); w.document.close();
      const doc = w.document, cv = doc.getElementById('fv');
      d.feed = w; d.fctx = cv.getContext('2d');
      const ndc = e => { const r = cv.getBoundingClientRect(), s = Math.min(r.width / FEED_W, r.height / FEED_H), ox = r.left + (r.width - FEED_W * s) / 2, oy = r.top + (r.height - FEED_H * s) / 2;
        return [((e.clientX - ox) / (FEED_W * s)) * 2 - 1, -((e.clientY - oy) / (FEED_H * s)) * 2 + 1]; };
      // in a room only the flier steers the camera or gives orders; watchers get a note (marks are open to everyone)
      const fly = () => { if (mine(d)) return true; note(d, (flier(d) ? 'Flown by ' + flier(d) : 'Flown by the instructor') + '. Take control in the UAS panel to fly it.'); return false; };
      const zoom = f => { if (!fly()) return; d.cam.fov *= f; updateCam(d); };
      let drag = null;
      cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: false }; try { cv.setPointerCapture(e.pointerId); } catch (err) {} });
      cv.addEventListener('pointermove', e => {
        if (!drag || d.state !== 'fly' || !mine(d)) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return; drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
        const k = d.cam.fov * Math.PI / 180 / cv.getBoundingClientRect().height;
        slewBy(d, dx * k, dy * k);           // the picture follows the hand on both axes (sideways used to run backwards)
      });
      cv.addEventListener('pointerup', e => {
        const was = drag; drag = null; if (!was || was.moved || d.state !== 'fly' || !fly()) return;
        const [nx, ny] = ndc(e); updateCam(d); const p = groundThrough(d, nx, ny); if (!p) return note(d, 'No ground there.');
        if (e.shiftKey) {
          const v = vehiclesNear(p.x, p.z, 40).find(o => { const w = new THREE.Vector3(); o.m.getWorldPosition(w); return los(d.cam3.position, w.setY(w.y + 1.5)); });
          if (v) { d.cam.mode = 'track'; d.cam.trk = v.m; d.cam.last = { x: p.x, z: p.z }; note(d, 'Tracking.'); return; }
          note(d, 'No vehicle there to track; staring at the point instead.');
        }
        d.cam.mode = 'stare'; d.cam.sx = p.x; d.cam.sz = p.z; d.cam.trk = null;
      });
      cv.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
      const B = id => doc.getElementById(id);
      B('m-scan').addEventListener('click', () => { if (!fly()) return; d.cam.mode = 'scan'; d.cam.trk = null; });
      B('m-stare').addEventListener('click', () => { if (fly() && d.spi) { d.cam.mode = 'stare'; d.cam.sx = d.spi.x; d.cam.sz = d.spi.z; d.cam.trk = null; } });
      B('m-track').addEventListener('click', () => note(d, 'Shift-click a vehicle in the video to track it.'));
      B('z-in').addEventListener('click', () => zoom(1 / 1.5));
      B('z-out').addEventListener('click', () => zoom(1.5));
      B('f-orbit').addEventListener('click', () => { if (fly() && d.spi && d.state === 'fly' && d.task.kind !== 'strike') { cmd('orbit', { d: d.id, x: d.spi.x, z: d.spi.z }); note(d, 'Orbit moved to ' + gridAt(d.spi.x, d.spi.z) + '.'); } });
      B('f-mark').addEventListener('click', () => { if (!d.spi) return; cmd('mark', { d: d.id, x: d.spi.x, z: d.spi.z, note: B('f-note').value.trim() }); B('f-note').value = ''; note(d, 'Marked ' + gridAt(d.spi.x, d.spi.z) + '.'); });
      if (B('f-strike')) B('f-strike').addEventListener('click', e => {
        if (!fly()) return;
        if (!d.armedStrike) { if (d.cam.mode !== 'stare' && d.cam.mode !== 'track') return note(d, 'Stare at a point or track a vehicle first.'); d.armedStrike = performance.now() + 5000; e.target.textContent = 'Confirm strike'; e.target.classList.add('armed'); return; }
        d.armedStrike = 0; e.target.textContent = 'Strike'; e.target.classList.remove('armed'); cmd('strike', { d: d.id });
      });
      if (B('f-abort')) B('f-abort').addEventListener('click', () => { if (fly()) cmd('waveoff', { d: d.id }); });
      if (B('f-recover')) B('f-recover').addEventListener('click', () => { if (fly()) cmd('recover', { d: d.id }); });
      // prepoint (Altius): type a grid, the camera slews there (about 60 deg/s) and stares at it
      const prepoint = () => {
        if (d.state !== 'fly') return note(d, 'The drone is not flying.');
        if (!fly()) return;
        const g = FIRES.debug.parseGrid(B('f-pp').value); if (g.err) return note(d, g.err);
        const p = toLocal(g.e, g.n); if (!inPlay(p.x, p.z)) return note(d, 'That grid is off the map.');
        const c = d.cam; updateCam(d);
        const f = d.spi || new THREE.Vector3(c.sx, gy(c.sx, c.sz), c.sz), o = d.cam3.position;
        const ang = f.clone().sub(o).angleTo(new THREE.Vector3(p.x, gy(p.x, p.z), p.z).sub(o));
        c.mode = 'stare'; c.trk = null; c.sx = p.x; c.sz = p.z;
        c.slew = { fx: f.x, fz: f.z, tx: p.x, tz: p.z, t0: performance.now(), dur: clamp(ang / (Math.PI / 3) * 1000, 300, 2000) };
        const tg = new THREE.Vector3(p.x, gy(p.x, p.z), p.z), dir = tg.clone().sub(o), L = dir.length(), hit = rayGround(o, dir.normalize());
        note(d, 'Prepoint ' + gridAt(p.x, p.z) + (hit && hit.distanceTo(o) < L - 30 ? ' — masked from here by a building or terrain; the SPI shows what is in the way.' : '.'));
      };
      if (B('f-ppgo')) B('f-ppgo').addEventListener('click', prepoint);
      // keys: arrows slew (held), +/- zoom; ignored while typing in the note or grid box (Enter there runs the prepoint)
      d.slewKeys = new Set();
      const typing = () => { const a = doc.activeElement; return !!a && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };
      w.addEventListener('keydown', e => {
        if (typing()) { if (e.key === 'Enter' && doc.activeElement.id === 'f-pp') prepoint(); return; }
        if (e.key === '+' || e.key === '=') zoom(1 / 1.25); else if (e.key === '-') zoom(1.25);
        else if (/^Arrow(Up|Down|Left|Right)$/.test(e.key)) { d.slewKeys.add(e.key); d.slewFast = e.shiftKey; e.preventDefault(); }
      });
      w.addEventListener('keyup', e => { d.slewKeys.delete(e.key); d.slewFast = e.shiftKey; });
      w.addEventListener('blur', () => d.slewKeys.clear());
    }

    // ---- marks: a grid, a time and the student's own note (no prediction, no truth)
    // by: who marked it in a room (callsign); from: a mark the host sent (a student redraws the host's list, no log)
    function addMark(d, x, z, text, by, from) {
      const mk = { id: from ? from.id : nextId++, t: from ? from.t : simT(), x, z, grid: gridAt(x, z), by: from ? from.by : (by && NET.room ? by + (d ? ' (' + d.name + ')' : '') : d ? d.name : 'Map'), note: text || '' };
      const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.strokeStyle = '#ffd25a'; g.lineWidth = 7;
      g.beginPath(); g.moveTo(12, 12); g.lineTo(52, 52); g.moveTo(52, 12); g.lineTo(12, 52); g.stroke();
      mk.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true, sizeAttenuation: false }));
      mk.sprite.scale.set(0.03, 0.03, 1); mk.sprite.renderOrder = 13; mk.sprite.position.set(x, gy(x, z) + 10, z); ui.add(mk.sprite);
      marks.unshift(mk); if (from) return mk;
      FIRES.log('MARK ' + mk.grid + ' (' + mk.by + ')' + (mk.note ? ': ' + mk.note : '')); draw(); return mk;
    }

    // ---- panel
    const addRow = $('uas-add');
    for (const [k, label] of Object.entries(FAMS)) {
      const b = document.createElement('button'); b.textContent = '+ ' + label; b.title = 'Add a ' + label + ' launch point';
      b.addEventListener('click', () => { armed = { kind: 'lp', fam: k }; msg('uas-msg', 'Click the map to place a ' + label + ' launch point, or type a grid and press Place' + (k === 'lucas' ? ' (LUCAS may be off the map)' : '') + '. Esc cancels.', 'arm'); });
      addRow.appendChild(b);
    }
    $('uas-place').addEventListener('click', () => {
      if (!armed || armed.kind !== 'lp') return msg('uas-msg', 'Pick a type first.', 'bad');
      const g = FIRES.debug.parseGrid($('uas-grid').value); if (g.err) return msg('uas-msg', g.err, 'bad');
      const p = toLocal(g.e, g.n); if (!onMap(p.x, p.z) && armed.fam !== 'lucas') return msg('uas-msg', 'Altius and Switchblade launch points must be on the map.', 'bad');
      addLP(armed.fam, p.x, p.z); armed = null; msg('uas-msg', 'Placed.');
    });
    function btn(text, title, fn, cls) { const b = document.createElement('button'); b.textContent = text; if (title) b.title = title; if (cls) b.className = cls; b.addEventListener('click', fn); return b; }
    function sel(title, opts, cur, fn, fmtO) {
      const s = document.createElement('select'); s.title = title;
      if (!opts.includes(cur)) opts = [...opts, cur].sort((a, b) => a - b);
      for (const v of opts) { const o = document.createElement('option'); o.value = v; o.textContent = fmtO(v); if (v === cur) o.selected = true; s.appendChild(o); }
      s.addEventListener('change', () => fn(Number(s.value))); return s;
    }
    function draw() {
      const L = $('uas-lps'); L.textContent = '';
      for (const lp of lps) {
        const row = document.createElement('div'); row.className = 'drow';
        const nm = document.createElement('div'); nm.className = 'dn'; nm.innerHTML = '<span></span><span class="ug"></span>';
        nm.firstChild.textContent = lp.name; nm.lastChild.textContent = 'Launch Point ' + gridAt(lp.x, lp.z) + (onMap(lp.x, lp.z) ? '' : ' · off map');
        row.appendChild(nm);
        const bar = document.createElement('div'); bar.className = 'row';
        if (lp.fam === 'lucas') {
          const inp = document.createElement('input'); inp.className = 'grid-in'; inp.placeholder = 'target grid'; inp.value = lp.draft != null ? lp.draft : '4Q FJ ';
          inp.addEventListener('focus', () => { const n = inp.value.length; inp.setSelectionRange(n, n); }); inp.addEventListener('input', () => { lp.draft = inp.value; });
          bar.appendChild(inp);
          bar.appendChild(btn('Launch', 'Fly to the grid and strike it. No camera.', () => {
            const g = FIRES.debug.parseGrid(inp.value); if (g.err) return msg('uas-lmsg', g.err, 'bad');
            const p = toLocal(g.e, g.n); if (!inPlay(p.x, p.z)) return msg('uas-lmsg', 'Target must be on the map.', 'bad');
            lp.draft = null; msg('uas-lmsg', ''); cmd('launch', { lp: lp.id, type: 'lucas', target: { x: p.x, z: p.z } });
          }));
        } else for (const k of famTypes(lp.fam)) bar.appendChild(btn((famTypes(lp.fam).length > 1 ? TYPES[k].short : 'Launch'), 'Launch one ' + TYPES[k].label + '; it orbits over the launch point until tasked', () => cmd('launch', { lp: lp.id, type: k })));
        if (!STUDENT) bar.appendChild(lpRemoveBtn(lp, (t, c) => msg('uas-lmsg', t, c)));   // launch points are the instructor's
        row.appendChild(bar); L.appendChild(row);
      }
      const D = $('uas-list'); D.textContent = '';
      for (const d of drones) {
        if (d.state === 'ready') continue;
        const T = TYPES[d.type], row = document.createElement('div'); row.className = 'drow' + (d.state !== 'fly' ? ' dead' : '');
        const k = d.task;
        const st = d.state === 'falling' ? 'Going down' : d.state === 'dead' ? (d.why.startsWith('impact') ? 'Expended' : 'Lost') : d.state === 'landed' ? 'Recovered' :
          k.kind === 'strike' ? 'Terminal' : k.kind === 'gps' ? 'Inbound' : k.kind === 'recover' ? 'Returning' : k.kind === 'route' ? 'Route ' + (k.i + 1) + '/' + k.pts.length : 'Orbit ' + k.r + ' m';
        const nm = document.createElement('div'); nm.className = 'dn';
        nm.innerHTML = '<span></span><span class="ug"></span>'; nm.firstChild.textContent = d.name + '  ' + st;
        nm.lastChild.textContent = d.state === 'landed' ? 'ready in ' + fmt(TURNAROUND - (simT() - d.landedAt)) : d.state !== 'fly' ? d.why :
          T.gps ? 'impact in about ' + fmt(eta(d)) + ' · ' + gridAt(k.kind === 'gps' ? k.tx : k.lx, k.kind === 'gps' ? k.tz : k.lz)
            : 'cam ' + d.cam.mode + ' · ' + fmt(Math.max(0, T.endur - (simT() - d.t0))) + ' left · ' + ftStr(d.alt) + ' AGL';
        row.appendChild(nm);
        const bar = document.createElement('div'); bar.className = 'row';
        if (NET.room && d.state === 'fly' && !T.gps) {           // who flies it, and Take control / Release
          const f = flier(d), who = document.createElement('span'); who.className = 'ug ctl';
          who.textContent = f ? (f === NET.cs ? 'You fly it' : 'Flown by ' + f) : NET.host ? 'Free: yours until a student takes it' : 'Free';
          bar.appendChild(who);
          if (f && f === NET.cs) bar.appendChild(btn('Release', 'Stop flying it, so someone else can take it', () => cmd('release', { d: d.id })));
          else if (f ? NET.host : NET.client) bar.appendChild(btn('Take control', 'Fly this UAS: its orders and camera become yours', () => cmd('take', { d: d.id })));
        }
        if (d.state === 'fly' && !T.gps && k.kind !== 'strike' && mine(d)) {
          bar.appendChild(btn('Orbit', 'Click the map: orbit there', () => { armed = { kind: 'orbit', d }; msg('uas-dmsg', 'Click the map where ' + d.name + ' should orbit. Esc cancels.', 'arm'); }));
          bar.appendChild(btn('Route', 'Click the map for each waypoint; Enter or Done to finish', () => { armed = { kind: 'route', d }; routeDraft = []; msg('uas-dmsg', 'Click waypoints for ' + d.name + ', then press Done or Enter. Esc cancels.', 'arm'); draw(); }));
          if (armed && armed.kind === 'route' && armed.d === d) bar.appendChild(btn('Done', '', finishRoute));
          bar.appendChild(sel('Height above ground', [500, 1000, 2000, 3000, 5000, 8000], ft(d.alt), v => cmd('alt', { d: d.id, alt: v * FT }), v => v.toLocaleString('en-US') + ' ft'));
          if (k.kind === 'orbit') bar.appendChild(sel('Orbit radius', [250, 400, 700, 1000, 1500, 2500], k.r, v => cmd('radius', { d: d.id, r: v }), v => 'r ' + v));
          if (T.recover && k.kind !== 'recover') { const b = btn('Recover', d.lp ? 'Fly back to ' + d.lp.name + ' and land' : 'No ' + FAMS[T.fam] + ' launch point to recover to', () => cmd('recover', { d: d.id })); b.disabled = !d.lp; bar.appendChild(b); }
        }
        if (d.state === 'fly' && T.waveoff && k.kind === 'strike' && mine(d)) bar.appendChild(btn('Wave off', 'Pull out of the dive', () => cmd('waveoff', { d: d.id })));
        if (d.state === 'fly') bar.appendChild(btn('IDENT', 'Centre the map on this UAS and flash its symbol', () => ident(d)));
        if (T.cam) bar.appendChild(btn('View feed', 'Open this drone\'s camera in its own window', () => openFeed(d), 'feed-btn'));
        row.appendChild(bar); D.appendChild(row);
      }
      if (!D.children.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Nothing in flight. Launch from Launch UAS above.'; D.appendChild(p); }
      const M = $('uas-marks'); M.textContent = '';
      if (!marks.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No marks yet. Mark from a feed (grid under the crosshair).'; M.appendChild(p); }
      for (const mk of marks) {
        const row = document.createElement('div'); row.className = 'urow mrow';
        const nm = document.createElement('span'); nm.className = 'un'; nm.textContent = 'T+' + fmt(mk.t) + '  ' + mk.grid + '  (' + fmt(simT() - mk.t) + ' ago)';
        const gr = document.createElement('span'); gr.className = 'ug'; gr.textContent = mk.by + (mk.note ? ' — ' + mk.note : ''); nm.appendChild(gr);
        row.append(nm, btn('Go', 'Look at this mark on the map', () => controls.target.set(mk.x, gy(mk.x, mk.z), mk.z)),
          btn('×', 'Delete this mark', () => cmd('unmark', { id: mk.id })));
        M.appendChild(row);
      }
    }
    let draftLine = null;
    function finishRoute() {
      if (!armed || armed.kind !== 'route') return;
      const d = armed.d; armed = null;
      if (routeDraft && routeDraft.length) cmd('route', { d: d.id, pts: routeDraft });
      dropObj(draftLine); draftLine = null; routeDraft = null; msg('uas-dmsg', ''); draw();
    }

    // ---- map clicks (a click, not the end of a drag); typing in panel inputs must not trip Enter/Esc
    let down = null;
    canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', e => {
      if (!down || obs || !armed) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null; if (moved > 5) return;
      const p = pick(e.clientX, e.clientY); if (!p) return;
      if (armed.kind === 'lp') { addLP(armed.fam, p.x, p.z); armed = null; msg('uas-msg', 'Placed.'); }
      else if (armed.kind === 'orbit') { const d = armed.d; armed = null; cmd('orbit', { d: d.id, x: p.x, z: p.z }); msg('uas-dmsg', d.name + ' orbiting ' + gridAt(p.x, p.z) + '.'); }
      else if (armed.kind === 'route') {
        routeDraft.push({ x: p.x, z: p.z }); dropObj(draftLine);
        draftLine = polyline([armed.d.pos.clone(), ...routeDraft.map(q => new THREE.Vector3(q.x, gy(q.x, q.z) + 6, q.z))], 0xd6b25a, false);
      }
    });
    addEventListener('keydown', e => {
      if (!armed) return;
      if (e.key === 'Enter' && armed.kind === 'route') finishRoute();
      if (e.key === 'Escape') { armed = null; routeDraft = null; dropObj(draftLine); draftLine = null; msg('uas-msg', ''); msg('uas-dmsg', 'Cancelled.'); draw(); }
    });
    addEventListener('beforeunload', () => { for (const d of drones) if (d.feed && !d.feed.closed) d.feed.close(); });
    draw();
    const feedCams = () => drones.filter(d => d.feed && (d.state === 'fly' || d.state === 'falling')).map(d => d.cam3);
    const feedFocus = () => drones.filter(d => d.feed && d.spi && d.state === 'fly').map(d => ({ x: d.spi.x, z: d.spi.z, r: 350, cam: d.cam3.position }));
    return { tick, renderFeeds, feedFocus, feedCams, cmd, runCmd, netState, applyNet, applyCam, droneById, setSend(f) { sendCmd = f; }, camOut, debug: { cmd, OPS, ctl, mine, lpList, TYPES, CAM, lps, drones, marks, addLP, launch, setTask, openFeed, commitStrike, waveOff, recover, addMark, eta, models: tmpl, updateCam, groundThrough, los, rayGround } };
  })();
  window.__uas = UAS.debug;

  // ---- SCENARIO: export the working scenario to a file; load a built-in one (data/scenarios/index.json) or a file.
  //      File: { format: 'fist-scenario', version: 1, name, opfor: { nextId, groups }, units: [...], lps: [...] }
  (function scenario() {
    const $ = id => document.getElementById(id), list = $('sc-list'), loadBtn = $('sc-load'), nameIn = $('sc-name'), fileIn = $('sc-filein');
    const msg = (text, cls) => { $('sc-msg').textContent = text; $('sc-msg').className = 'msg' + (cls ? ' ' + cls : ''); };
    let builtIn = [], fromFile = null;
    try { nameIn.value = localStorage.getItem(STORE.name) || ''; } catch (e) {}
    if (nameIn.value) msg('Current scenario: ' + nameIn.value);
    nameIn.addEventListener('input', () => { try { localStorage.setItem(STORE.name, nameIn.value.trim()); } catch (e) {} });

    function disarm() { delete loadBtn.dataset.armed; loadBtn.textContent = 'Load'; }
    function fillList() {
      list.textContent = '';
      const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; list.appendChild(o); };
      builtIn.forEach((s, i) => add(String(i), s.name));
      if (fromFile) add('file', 'File: ' + fromFile.name);
      if (!list.options.length) add('', 'No built-in scenarios yet');
      if (fromFile) list.value = 'file';
      loadBtn.disabled = !list.value; disarm();
    }
    list.addEventListener('change', disarm);
    load('scenarios/index.json', 'json').then(j => { if (j && Array.isArray(j.scenarios)) builtIn = j.scenarios; }).catch(() => {}).then(fillList);

    function isValid(s) {
      const VT = OPFOR.debug.VT;
      return !!s && s.format === 'fist-scenario' && s.version === 1 && Array.isArray(s.units) && Array.isArray(s.lps) && !!s.opfor && Array.isArray(s.opfor.groups) &&
        s.opfor.groups.every(g => Array.isArray(g.route) && Array.isArray(g.units) && g.units.every(u => VT[u.type]));
    }
    function apply(s) {       // the reload gives a clean start: clock at zero, no missions, drones or damage left over
      if (!isValid(s)) return msg('That is not a usable scenario file.', 'bad');
      try {
        localStorage.setItem(STORE.opfor, JSON.stringify(s.opfor));
        localStorage.setItem(STORE.units, JSON.stringify(s.units));
        localStorage.setItem(STORE.lps, JSON.stringify(s.lps));
        localStorage.setItem(STORE.name, s.name || '');
      } catch (e) { return msg('This browser would not store the scenario.', 'bad'); }
      location.reload();
    }
    loadBtn.addEventListener('click', async () => {
      const hasWork = OPFOR.debug.groups.length > 0 || FIRES.debug.units.length > 0;
      if (hasWork && !loadBtn.dataset.armed) { loadBtn.dataset.armed = '1'; loadBtn.textContent = 'Confirm: replace'; return msg('This replaces the enemy groups, firing units and launch points here. Export first to keep them.', 'arm'); }
      disarm();
      if (list.value === 'file') return apply(fromFile);
      try { apply(await load('scenarios/' + builtIn[+list.value].file, 'json')); }
      catch (e) { msg('Could not load that scenario.', 'bad'); }
    });
    $('sc-open').addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0]; fileIn.value = ''; if (!f) return;
      let s = null; try { s = JSON.parse(await f.text()); } catch (e) {}
      if (!isValid(s)) return msg('That is not a usable scenario file.', 'bad');
      fromFile = s; if (!s.name) s.name = f.name.replace(/\.json$/i, '');
      fillList(); msg('Press Load to open ' + s.name + '.', 'arm');
    });
    $('sc-export').addEventListener('click', () => {
      const name = nameIn.value.trim() || 'Untitled scenario';
      const body = JSON.stringify({ format: 'fist-scenario', version: 1, name, opfor: OPFOR.debug.snapshot(), units: FIRES.debug.unitList(), lps: UAS.debug.lpList() }, null, 1);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      a.download = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.json';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      msg('Exported ' + a.download + '.');
    });
  })();


  // ---- banner: keep --tb-h in step with the banner so panels and the observer bar sit below it
  const topbar = document.getElementById('topbar');
  function setTbH() { document.documentElement.style.setProperty('--tb-h', topbar.offsetHeight + 'px'); }
  setTbH(); new ResizeObserver(setTbH).observe(topbar);

  // ---- timeline: elapsed sim time on a scale that stretches as the exercise runs (events go here later)
  (function timeline() {
    const ticks = document.getElementById('tl-ticks'), now = document.getElementById('tl-now'), done = document.getElementById('tl-done');
    let span = 0;
    function draw() {
      ticks.textContent = '';
      const step = span <= 1200 ? 60 : span <= 3600 ? 300 : 600, major = step * 5;
      for (let s = step; s < span; s += step) {
        const i = document.createElement('i'); i.style.left = (100 * s / span) + '%'; if (s % major === 0) i.className = 'maj'; ticks.appendChild(i);
        if (s % major === 0) { const b = document.createElement('b'); b.style.left = (100 * s / span) + '%'; b.textContent = Math.round(s / 60) + 'm'; ticks.appendChild(b); }
      }
    }
    (function upd() {
      const t = window.__fires ? window.__fires.simT : 0;
      const want = Math.max(600, Math.ceil((t + 120) / 600) * 600);
      if (want !== span) { span = want; draw(); }
      const f = Math.min(1, t / span); now.style.left = `calc(${100 * f}% - 1px)`; done.style.width = (100 * f) + '%';
      setTimeout(upd, 250);
    })();
  })();

  // ---- control panels: toolbar toggles, drag by the title bar, several open at once,
  //      position and open/closed remembered in this browser only
  window.__wins = (function () {
    const KEY = 'fist-trainer-panels-v1', wins = [...document.querySelectorAll('.win')];
    const tools = [...document.querySelectorAll('#tools [data-win]')];
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { saved = {}; }
    if (LITE) for (const k of Object.keys(saved)) saved[k].open = false;   // phones: start with the view clear; the toolbar opens panels
    const save = () => { try { const o = {}; for (const w of wins) o[w.id] = { x: w.offsetLeft, y: w.offsetTop, open: !w.hidden }; localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} };
    let z = 10;
    const tbH = () => topbar.offsetHeight;
    function defaults(w) {
      const W = innerWidth, gap = 16, top = tbH() + 12;
      if (W < 700) return { x: gap, y: top, open: !LITE && w.id === 'w-ops' };
      if (w.id === 'w-ops') return { x: gap, y: top, open: true };
      if (w.id === 'w-fires') return { x: W - 336 - gap, y: top, open: true };
      return { x: gap + 336 + 12, y: top, open: false };   // Display, OPFOR and later panels open beside OPs
    }
    function clamp(w, x, y) {
      const minY = tbH() + 4, maxX = innerWidth - 60, maxY = innerHeight - 44;
      w.style.left = Math.max(-w.offsetWidth + 80, Math.min(maxX, x)) + 'px';
      w.style.top = Math.max(minY, Math.min(maxY, y)) + 'px';
    }
    function sync() { for (const b of tools) b.setAttribute('aria-pressed', String(!document.getElementById(b.dataset.win).hidden)); }
    function front(w) { w.style.zIndex = ++z; }
    function show(w, on) { w.hidden = !on; if (on) { front(w); clamp(w, w.offsetLeft, w.offsetTop); } sync(); save(); }
    for (const w of wins) {
      const s = saved[w.id] || defaults(w);
      w.hidden = !s.open; w.style.left = s.x + 'px'; w.style.top = s.y + 'px';
      if (!w.hidden) clamp(w, s.x, s.y);
      w.addEventListener('pointerdown', () => front(w));
      w.querySelector('.win-x').addEventListener('click', () => show(w, false));
      const h = w.querySelector('.win-h');
      h.addEventListener('pointerdown', e => {
        if (e.target.closest('button')) return;
        const ox = e.clientX - w.offsetLeft, oy = e.clientY - w.offsetTop; try { h.setPointerCapture(e.pointerId); } catch (err) {}
        const mv = ev => clamp(w, ev.clientX - ox, ev.clientY - oy);
        const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); save(); };
        h.addEventListener('pointermove', mv); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      });
    }
    for (const b of tools) b.addEventListener('click', () => { const w = document.getElementById(b.dataset.win); show(w, w.hidden); });
    addEventListener('resize', () => { for (const w of wins) if (!w.hidden) clamp(w, w.offsetLeft, w.offsetTop); });
    sync();
    // standing at an OP: panels, toolbar and the 3D/Map switch step aside; the clock stays
    let before = null;
    const right = document.querySelector('.tb-right');
    function observer(on) {
      document.getElementById('rules-btn').hidden = on;
      if (on) { before = wins.filter(w => !w.hidden); for (const w of wins) w.hidden = true; right.hidden = true; }
      else { for (const w of before || []) w.hidden = false; before = null; right.hidden = false; sync(); }
    }
    return { observer, show: (id, on) => show(document.getElementById(id), on) };
  })();

  // ---- RULES & ASSUMPTIONS (Lee, 2026-11-02): a bottom-right tab that opens a page of every design choice and number.
  //      Built from the live tables (FIRES, UAS, OPFOR, DAMAGE), so it cannot drift from what the sim does.
  //      Rename the tab here: RULES_TITLE.
  (function rules() {
    const RULES_TITLE = 'Rules and Assumptions';
    const btn = document.getElementById('rules-btn'), dlg = document.getElementById('rules'), body = document.getElementById('rules-b');
    btn.textContent = RULES_TITLE; document.getElementById('rules-title').textContent = RULES_TITLE;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const tbl = (head, rows, cls) => '<table class="rt' + (cls ? ' ' + cls : '') + '"><thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    const list = items => '<ul class="rl">' + items.map(i => '<li>' + i + '</li>').join('') + '</ul>';
    const f = fn => esc(String(fn).replace(/^\s*\w+\s*=>\s*/, ''));               // "R => 8 + R / 350" -> "8 + R / 350"
    const kmh = ms => Math.round(ms * 3.6);
    const mmss = s => s >= 3600 ? (s / 3600).toFixed(1).replace(/\.0$/, '') + ' h' : Math.round(s / 60) + ' min';
    const pct = p => p >= 0.995 ? '100' : p < 0.005 ? '0' : Math.round(p * 100) + '';
    const PH = '<span class="ph">placeholder</span>';

    function build() {
      const FT = FIRES.debug.TYPES, UT = UAS.debug.TYPES, CAM = UAS.debug.CAM, VT = OPFOR.debug.VT, FX = OPFOR.debug.fxRules, D = DAMAGE;
      const CLS = { soft: 'Soft (fuel truck, civilians)', eng: 'Engineering', armor: 'Armour (ZBD, ZTD, PLZ)' }, cls = Object.keys(CLS);
      const MUN = Object.keys(D.R), QF = FIRES.debug.QF, munName = k => FT[k] ? FT[k].short : UT[k] ? UT[k].label : QF[k] ? QF[k].label : k, src = k => k === 'm777' || k === 'm119' ? 'Fire Mission Sim' : PH;
      const MISS = [0, 5, 10, 15, 20, 30, 50];
      const sec = [];

      sec.push(['dmg', 'Damage', `
        <p class="fm">P(struck, one burst) = Pdh × exp( −(d / R)² )</p>
        ${tbl(['Term', 'Meaning'], [
          ['d', 'ground distance, burst to vehicle, at the moment that burst lands (m)'],
          ['R', 'radius for that munition vs that class (m) — at d = R, P ≈ 37 % of Pdh'],
          ['Pdh', 'chance a burst right on the vehicle strikes it'],
          ['Mission', 'P(struck) = 1 − Π(1 − p<sub>i</sub>) — every round rolls separately; one success is enough']])}
        ${list([
          'One outcome: <b>struck or not struck</b>. Struck = stops for good, burns. No M/K/F-kill.',
          'Dice are keyed (seed | burst | vehicle), not drawn in order: 1×, 5×, 10× give the same result.',
          'Tube rounds (artillery, mortars) do nothing if the round <b>or</b> the vehicle is in the water.',
          'Ships (LCU, RoRo) cannot be struck; nor can cargo still aboard.',
          'A struck vehicle is not rolled again. The rest of its column drives on past it (no bypass logic yet).',
          'UAS impacts get ' + D.UAS_MISS + ' m (1σ, each axis) guidance scatter around the aim point.',
          'Artillery rounds burst on the first building or terrain crest in their path (see Artillery); a burst on a building uses 3D distance.',
          'A building between a burst and a vehicle shields the vehicle completely (artillery and UAS).',
          'Drone flight paths ignore buildings (the operator steers to the end).'])}
        <h4>R and Pdh</h4>
        ${tbl(['Munition', ...cls.map(c => CLS[c] + '<br>R m · Pdh'), 'Source'],
          MUN.map(k => [munName(k), ...cls.map(c => { const r = D.R[k][c], p = D.PDH[k] && typeof D.PDH[k][c] === 'number' ? D.PDH[k][c] : 1; return r + ' · ' + (p === 1 ? '1' : p.toFixed(2)); }), src(k)]), 'num')}
        <h4>Chance one burst strikes, by miss distance (%)</h4>
        ${tbl(['Munition', 'Class', ...MISS.map(m => m + ' m')],
          MUN.flatMap(k => cls.map((c, j) => [j ? '' : munName(k), CLS[c].split(' ')[0], ...MISS.map(m => pct(D.pStrike(k, c === 'soft' ? 'fuel' : c === 'eng' ? 'eng' : 'zbd', m)))])), 'num')}`]);

      sec.push(['arty', 'Artillery', `
        ${tbl(['Unit', 'Tubes', 'Range m', 'Angle', 'Top MV m/s', 'Charges (% of top MV)', 'Volley every', 'Sheaf m', 'Range σ m', 'Deflection σ m'],
          Object.entries(FT).map(([k, t]) => { const w = FIRES.debug.BAL.W[k]; return [t.label, t.tubes, t.min + '–' + t.max, t.angle === 'high' ? 'high only' : 'high (default) / low', w.v, w.ch.map(c => Math.round(c * 100)).join(' / '), t.interval + ' s', t.sheaf, f(t.sR), f(t.sD)]; }), 'num')}
        <p class="fm">a = g + (−k·|v|·v) &nbsp; — gravity plus quadratic drag, constant air density, 0.05 s steps</p>
        ${list([
          'R = range gun to target, m. Muzzle velocities, charges and drag are notional — not firing tables ' + PH + '.',
          'k fitted so the top charge\'s maximum range = the unit\'s max range (M777 ' + FIRES.debug.BAL.W.m777.k.toExponential(2) + ', M119 ' + FIRES.debug.BAL.W.m119.k.toExponential(2) + ', 120 mm ' + FIRES.debug.BAL.W.m120.k.toExponential(2) + ', 81 mm ' + FIRES.debug.BAL.W.m252.k.toExponential(2) + ' per m).',
          'Charge choice — Low: lowest charge that reaches at ≤ ' + FIRES.debug.BAL.LOW_MAX + ' mils. High: charge with QE closest to ' + FIRES.debug.BAL.HIGH_BEST + ' mils (within ' + FIRES.debug.BAL.HIGH_MIN + '–' + FIRES.debug.BAL.HIGH_MAX + ').',
          'Time of flight, the drawn arc and the shells all come from the computed trajectory. Height difference gun → target is included.',
          'No ammunition count or limit: the instructor sets rounds per tube each mission. Parallel sheaf: tubes spread evenly across the gun-target line over the sheaf width, then gaussian scatter (σ above). Each round fires up to 1.5 s after its volley time.',
          'Each round flies the mission path stretched to its own impact point. It bursts on the first <b>building</b> or <b>terrain crest</b> below its path (first 30 m from the guns and off-map stretches not checked).',
          'A burst on a building rolls damage by 3D distance to the vehicle. A building between any burst and a vehicle shields it completely.',
          'Not modelled: air density with height, wind, drift, fuzes, shell types, mean-point-of-impact error, different dispersion at high angle.'])}
        <h4>Call for fire — the Fire Mission Sim's mission types</h4>
        ${tbl(['Type of mission', 'Tubes', 'Rounds per tube', 'Rounds apart'],
          [['Fire for effect', 'all', 'instructor sets', 'unit\'s volley interval'], ['Immediate suppression', 'all', '1', '—'],
           ['Adjust fire', 'half, rounded up (sim: 3 of 6)', '1', '—'], ['Suppression', '1', '18', '7 s (about 2 minutes)']])}
        ${list([
          'Method of control decides only when the guns fire. <b>When ready</b>: on Send. <b>At my command</b>: laid and held until FIRE is pressed. <b>Time on target</b>: fired at TOT − time of flight, so the first rounds land at the TOT (sim clock); a TOT inside the time of flight is refused.',
          'A held mission is solved again when it fires: a unit moved meanwhile fires from its new position; a unit removed or now out of range cancels the mission.',
          'No acknowledgement delay and no one-mission-per-battery rule (both are in the sim): the instructor is the FDC.'])}
        <h4>Examples — same height gun and target</h4>
        ${tbl(['Unit', 'Range', 'Low: charge · QE · ToF', 'High: charge · QE · ToF'],
          Object.entries(FT).flatMap(([k, t]) => [1000, 3000, 5000, 10000, 15000, 20000].filter(R => R >= t.min && R <= t.max).map((R, j) => {
            const c = s => s.err ? '—' : 'ch ' + s.ch + ' · ' + Math.round(s.qe) + ' mils · ' + Math.round(s.tof) + ' s';
            return [j ? '' : t.short, R / 1000 + ' km', t.angle === 'high' ? 'n/a' : c(FIRES.debug.BAL.solve(k, R, 0, false)), c(FIRES.debug.BAL.solve(k, R, 0, true))]; })), 'num')}`]);

      sec.push(['qf', 'Quick fire', `
        ${tbl(['Munition', 'Group', 'Default count', 'Default spread (1σ) m', 'Between impacts s', 'R soft · eng · armour m'],
          Object.entries(QF).map(([k, q]) => [q.label, q.cat, q.n, q.sd, q.gap, D.R[k].soft + ' · ' + D.R[k].eng + ' · ' + D.R[k].armor]), 'num')}
        ${list([
          'For the instructor: effects land on the aim point at once. No firing unit, no flight, no range limit, no trajectory, no masking by buildings or crests on the way in.',
          'Each round lands at the aim point plus gaussian scatter (spread, 1σ each axis). One landing inside a building footprint bursts on the roof.',
          'Damage rolls exactly as for any other burst (see Damage). Artillery types use the artillery rows, so tube rounds still do nothing in the water.',
          'RT-2000 rockets are treated as unitary HE; the Mk45 submunition load is not modelled. GMLRS and ATACMS are the unitary warheads.',
          'All quick-fire figures are guesses scaled from the 155 mm row by explosive weight ' + PH + '.'])}`]);

      sec.push(['uas', 'UAS', `
        ${tbl(['Type', 'Transit', 'Loiter', 'Dive', 'Endurance', 'Cruise AGL', 'Orbit r', 'Turn', 'Camera', 'Notes'],
          Object.values(UT).map(t => [t.label, t.speed + ' m/s (' + kmh(t.speed) + ' km/h)', t.loiter ? t.loiter + ' m/s' : '—', t.dive ? t.dive + ' m/s' : '—', mmss(t.endur), t.alt + ' m', t.r ? t.r + ' m' : '—', t.turn + '°/s', t.cam || 'none',
            [t.recover ? 'recoverable' : '', t.waveoff ? 'can wave off' : '', t.gps ? 'GPS target only' : '', !t.burst ? 'no warhead' : ''].filter(Boolean).join(', ') || '—']), 'num')}
        <h4>Camera tiers</h4>
        ${tbl(['Tier', 'Resolution', 'Noise', 'Blur', 'Zoom (FOV)', 'Frame drop'],
          Object.entries(CAM).map(([k, c]) => [k, Math.round(c.res * 100) + ' %', c.noise, c.blur, c.fovMin + '–' + c.fovMax + '°', Math.round(c.drop * 100) + ' %']), 'num')}
        ${list([
          'Speeds, endurance and heights: published where available, otherwise estimates — see the UAS project doc. Treat as ' + PH + '.',
          'Terminal dive starts at max(250 m, 0.45 × height) out — about a 65° dive.',
          'Out of endurance: power lost, airframe falls; the warhead does <b>not</b> detonate.',
          'No launch limits (the instructor limits them). Recovered ISR leaves the list after 10 min.',
          'Flight is automatic (orbit, route, scan); no manual flying. No drone-to-drone handoff.',
          'Camera sight lines stop at buildings and terrain: stare, SPI, marks and prepoint land on the first roof, wall or slope.',
          'Track holds through up to 2 s of masking, then drops ("Track lost: target masked"). Shift-click locks only a vehicle the camera can see.',
          'Feeds always show buildings, trees and the enemy, whatever the instructor\'s Display switches say.'])}`]);

      sec.push(['opfor', 'Enemy vehicles', `
        ${tbl(['Type', 'L × W × H m', 'Land', 'Water', 'Gap', 'Damage class', 'Notes'],
          Object.entries(VT).map(([k, t]) => [t.name, t.L + ' × ' + t.W + ' × ' + t.H, t.land ? t.land + ' km/h' : '—', t.water ? t.water + ' km/h' : '—', t.gap + ' m',
            D.CLASS[k] ? CLS[D.CLASS[k]].split(' ')[0] : 'cannot be struck',
            [t.amph ? 'amphibious' : '', t.ship ? 'draft ' + t.draft + ' m, offloads one vehicle at a time (30 s each unless set on the ship)' : ''].filter(Boolean).join(', ') || '—']), 'num')}
        ${list([
          'Sizes and speeds are approximate public figures ' + PH + '; speed and gap are set per group in the editor.',
          'Water = no terrain data or ground below 0.3 m.',
          'Swimming amphibians ride low (0.6 × height under water).',
          'Movement is a fixed function of the clock: column in file at the set gap, scripted holds, instructor halt/resume.',
          'No vehicle-to-vehicle avoidance. Struck vehicles do not block the road.',
          'Each ZBD lets out ' + VT.inf.squad + ' soldiers 30 m after it comes ashore, without stopping. They walk its route at ' + VT.inf.land + ' km/h and stop at its end or the next water. Each can be struck; a ZBD struck before it lands lets out nobody.'])}
        <h4>Routes and roads</h4>
        ${tbl(['Rule', 'Value'], [
          ['Follow roads', 'on by default for land groups; shortest road path between each pair of clicked points'],
          ['Road preference', 'cost per metre × ' + OPFOR.debug.roadRules.ROAD_W.join(' / ') + ' (major / mid / minor road) — ' + PH],
          ['Snap reach', 'a clicked point joins the nearest road by a straight link if one is within ' + OPFOR.debug.roadRules.ROAD_REACH + ' m'],
          ['Straight legs', 'ships; Follow roads off; either end in the water (landings, swims); no road within reach'],
          ['Buildings', 'off-road legs and each vehicle of a line steer around building footprints, through gaps roughly 5 to 11 m wide or more; a vehicle on a longer way round speeds up to stay level. Amber where no way round was found, and on the short links to a road'],
          ['Road data', 'OpenStreetMap drivable roads; no one-way streets, lanes, width or traffic'],
          ['Column behind its start point', 'lined up straight back from the first stretch of road']])}`]);

      { const CV = window.__civ;
        sec.push(['civ', 'Civilians', `
        ${tbl(['Setting', 'Cars on the map', 'Fishing boats'], CV.LEVELS.map(l => [l[1], l[2] ? l[2] + ' ' + PH : 'none', CV.BOATS[l[0]] || 'none']))}
        ${list([
          'Seeded: the same cars on the same streets every run. A higher setting adds cars; it never reshuffles the lower one.',
          Math.round(CV.PARKED * 100) + ' % parked at the kerb on minor and mid roads (never on major roads); the rest drive.',
          'Driving speed by road class: ' + CV.KMH.join(' / ') + ' km/h (major / mid / minor), ±15 % per car ' + PH + '. Right-hand traffic.',
          'Drivers take a random turn at each junction (never straight back unless it is a dead end). No lights, rules or collisions — cars pass through each other.',
          'A moving car\'s position is a fixed function of the clock: pause, 10× and replays agree.',
          'Drawn as full models near where someone is looking (main view centre, open UAS feeds\' aim points; up to ' + CV.NEAR_CAP + '), coloured boxes elsewhere out to ' + CV.FAR_R / 1000 + ' km, nothing beyond.',
          'UAS can track civilians exactly like enemy vehicles — the camera does not tell friend from foe.',
          'Boats: about half at anchor (swinging slowly), the rest motor at 4–8 kn between random points 0.8–3 km apart, always 150 m+ offshore and on open water. Moving boats trail a simple V wake (one flat textured shape, ~80 m long, ~19.5° arms).',
          'Civilians (cars and boats) can be struck exactly like enemy vehicles: soft class (same radii as a fuel truck), Pdh 1. A struck car stops where it is, darkens and burns; the fires log names it ("STRUCK CIVILIAN WHITE PICKUP").'])}`]); }
      sec.push(['fx', 'Effects', `
        ${tbl(['Effect', 'Rule'], [
          ['Shell burst', 'flash 0.8 s; smoke 60 s; scorch fades over 10 min'],
          ['Struck vehicle', 'model darkened, stops where hit'],
          ['Fire', 'full for ' + mmss(FX.BURN_FULL) + ', then 60 %; fuel truck 1.8× bigger; burns to end of exercise'],
          ['Smoke', FX.PUFFS + ' puffs, each rises ' + FX.PUFF_LIFE + ' s (~2.8 m/s, ~140 m), black → grey'],
          ['Wind', 'from ' + String(FX.WIND_FROM).padStart(3, '0') + '° (trade wind), one wind for all fires — ' + PH],
          ['Clock', 'all effects run on sim time: pause freezes them']])}`]);

      sec.push(['obs', 'Observation', `
        ${tbl(['Item', 'Value'], [
          ['Eye height', '1.8 m standing, 0.5 m prone'],
          ['Target height (viewshed)', '2.5 m vehicle, 0 m bare ground'],
          ['Viewshed range', '5 or 10 km'],
          ['Naked-eye field of view', '55°'],
          ['Binoculars', 'Steiner M30r 8×30, mil reticle (6400 mils); true field 7.5° — ' + PH + ', not from the spec'],
          ['Terrain', 'USGS 3DEP 1 m DEM, thinned to 10 m'],
          ['Buildings and trees', '2020 NOAA lidar; block sight on a 10 m grid; trees block completely'],
          ['OP inside a building', 'observer stands on the roof'],
          ['Map clicks (instructor)', 'land on a roof or wall when Buildings are shown, else on the ground'],
          ['Phones and tablets', (LITE ? 'THIS DEVICE: ' : '') + 'demo (lite) mode — 1x resolution, no anti-aliasing, civilians Sparse as coloured boxes, trees simplified at half the distance. ?lite=1 / ?lite=0 forces it.'],
          ['Trees drawn (display only)', 'only those in 250 m cells inside some camera\'s view (main view or an open UAS feed); simpler shapes and no trunks once a tree is a few pixels across, none past about 20 km. Sight lines still use every tree.'],
          ['Terrain drawn (display only)', 'in ~1.5 km tiles; tiles outside the view are skipped, and distant tiles use every 2nd or 4th grid point (full detail near a camera and under a viewshed). Sight lines, heights and clicks still use the 10 m grid.'],
          ['Far enemy vehicles (display only)', 'drawn as a plain box of the model\'s colour once under about 3 pixels long in every camera.'],
          ['Traffic updates', 'civilian positions are redrawn at half the frame rate (every frame while a UAS feed is open)']])}`]);

      body.innerHTML = '<nav class="rnav">' + sec.map(s => `<a href="#r-${s[0]}">${s[1]}</a>`).join('') + '</nav>' +
        sec.map(s => `<section id="r-${s[0]}"><h3>${s[1]}</h3>${s[2]}</section>`).join('');
      for (const a of body.querySelectorAll('.rnav a')) a.addEventListener('click', e => { e.preventDefault(); body.querySelector(a.getAttribute('href')).scrollIntoView({ block: 'start' }); });
    }
    let built = false;   // built once per page load: the example table runs ~50 trajectory solutions
    function open(on) { if (on && !built) { build(); built = true; } dlg.hidden = !on; btn.setAttribute('aria-expanded', String(on)); if (on) document.getElementById('rules-x').focus(); else btn.focus(); }
    btn.addEventListener('click', () => open(dlg.hidden));
    document.getElementById('rules-x').addEventListener('click', () => open(false));
    dlg.addEventListener('click', e => { if (e.target === dlg) open(false); });
    addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.hidden) { e.stopPropagation(); open(false); } }, true);
    window.__rules = { open };
  })();

  // ---- render loop with label projection
  const v = new THREE.Vector3();
  document.getElementById('loading').hidden = true; liteNote();
  let lastT = performance.now();
  // ---- performance readout (Display → Diagnostics → Performance; Lee, 2026-11-03): what each frame costs, so a
  //      feature's weight can be seen by switching it on and off. Frame time, fps, JS time per module, GPU work.
  const PERF = (() => {
    const el = document.getElementById('perf'), btn = document.getElementById('tg-perf');
    let on = false, acc = {}, frames = 0, t0 = performance.now(), frameMs = 0, worst = 0;
    renderer.info.autoReset = false;                       // count every render in a frame (main view + UAS feeds)
    if (btn) btn.addEventListener('click', () => { on = !on; btn.setAttribute('aria-pressed', String(on)); el.hidden = !on; });
    function time(name, fn) { if (!on) return fn(); const a = performance.now(); const r = fn(); acc[name] = (acc[name] || 0) + performance.now() - a; return r; }
    function frame(ms) {
      const inf = renderer.info.render, mem = renderer.info.memory;
      if (on) { frameMs += ms; worst = Math.max(worst, ms); frames++; acc.calls = (acc.calls || 0) + inf.calls; acc.tris = (acc.tris || 0) + inf.triangles; }
      renderer.info.reset();
      const now = performance.now(); if (!on || now - t0 < 1000) return;
      const n = frames || 1, f = k => ((acc[k] || 0) / n).toFixed(1);
      const heap = performance.memory ? ' · JS heap ' + Math.round(performance.memory.usedJSHeapSize / 1e6) + ' MB' : '';
      el.textContent = `${Math.round(n * 1000 / (now - t0))} fps · frame ${(frameMs / n).toFixed(1)} ms (worst ${worst.toFixed(0)})\n` +
        `JS ms/frame: fires ${f('fires')} · enemy ${f('opfor')} · UAS ${f('uas')} · civilians ${f('civ')} · trees ${f('trees')} · feeds ${f('feeds')} · draw ${f('render')}\n` +
        `GPU/frame: ${Math.round((acc.calls || 0) / n)} draw calls · ${((acc.tris || 0) / n / 1e6).toFixed(2)} M triangles · ${mem.geometries} geometries · ${mem.textures} textures${heap}`;
      acc = {}; frames = 0; frameMs = 0; worst = 0; t0 = now;
    }
    return { time, frame };
  })();
  // ---- ROOM (multiplayer build step 2; plan in Trainer/notes/trainer-multiplayer.md). The host (instructor, ?room=CODE) runs
  //      the sim and sends: the enemy groups and halts, firing units, civilian level and damage when they change; the clock
  //      4x a second; every drone, launch point, mark and who flies what 5x a second; each burst and strike as it happens.
  //      A student (?role=student&room=CODE) moves the enemy and civilians itself from those and the clock, mirrors the drones,
  //      and sends back commands (UAS orders, Take control) and the camera of any drone it flies.
  //      Link (step 3): a websocket to the Cloudflare relay (source: Fires Lab\relay\, beside the repo) when RELAY_URL is set
  //      or the address says &relay=local (ws://<this host>:8787, i.e. `npm run dev` in relay\) or &relay=wss://…; otherwise,
  //      or with &relay=tab, a BroadcastChannel (tabs of one browser). The relay sends host messages to every student (or to
  //      the one named in "to") and student messages to the host, and itself says bye / hostbye / nohost.
  //      Instructor PIN: the host claims the room with a PIN (&pin=, else one kept in this browser's localStorage per room);
  //      another instructor is refused while the room is held. The host badge's tooltip shows it, to host from another computer.
  const RELAY_URL = '';          // set after `npx wrangler deploy`, e.g. 'wss://fist-relay.<account>.workers.dev'
  const ROOM = (() => {
    if (!NET.room) return null;
    const q = new URLSearchParams(location.search), rq = q.get('relay');
    const relay = rq === 'tab' ? null : rq === 'local' ? 'ws://' + location.hostname + ':8787' : rq && /^wss?:\/\//.test(rq) ? rq : RELAY_URL || null;
    const me = Math.random().toString(36).slice(2, 10);
    let pin = '';
    if (NET.host && relay) {
      const k = 'fist-room-pin-' + NET.room;
      try { pin = q.get('pin') || localStorage.getItem(k) || ''; } catch {}
      if (!pin) pin = String(Math.floor(1000 + Math.random() * 9000));
    }
    const keepPin = () => { try { localStorage.setItem('fist-room-pin-' + NET.room, pin); } catch {} };   // on the relay's hostok
    let handle = () => {}, onLink = () => {};
    const link = (() => {
      if (!relay) { const ch = new BroadcastChannel('fist-room-' + NET.room); ch.onmessage = e => handle(e.data); return { post: o => ch.postMessage(o) }; }
      const url = relay.replace(/\/+$/, '') + '/room/' + encodeURIComponent(NET.room) + '?' +
        new URLSearchParams({ role: NET.host ? 'host' : 'student', id: me, cs: NET.cs, pin });
      let ws = null, tries = 0;
      const connect = () => {
        ws = new WebSocket(url);
        ws.onopen = () => { tries = 0; onLink('open'); };
        ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
        ws.onclose = e => {
          ws = null;
          if (e.code === 4003) { onLink('refused'); return; }          // another instructor holds this room: don't retry
          onLink('closed'); setTimeout(connect, Math.min(10000, 1000 * 2 ** tries++));
        };
      };
      connect();
      return { post: o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } };
    })();
    const send = (type, o) => link.post(Object.assign({ type, from: me, cs: NET.cs }, o || {}));
    const F = FIRES.debug, O = OPFOR.debug, badge = document.getElementById('room-badge');
    const say = (text, cls, title) => { badge.hidden = false; badge.textContent = text; badge.className = cls || ''; badge.title = title || ''; };
    const struckList = () => [...O.struck].map(([k, w]) => { const [g, i] = k.split(':').map(Number); return { g, i, t: w.t, cause: w.cause }; });
    if (NET.host) {
      const students = new Map();                 // tab id -> { cs, seen }
      const roster = () => { const n = students.size, who = [...students.values()].map(s => s.cs);
        say('Room ' + NET.room + ' · ' + n + ' student' + (n === 1 ? '' : 's'), 'host', (who.length ? 'In the room: ' + who.join(', ') : 'Nobody has joined yet') +
          (pin ? '\nInstructor PIN ' + pin + ' (add &pin=' + pin + ' to host this room from another computer)' : '')); };
      const dmg = () => ({ opfor: struckList(), civ: CIV.hits() });
      const full = to => send('full', { to, opfor: O.netState(), units: F.unitList(), civ: CIV.debug.level, clock: { t: F.simT, speed: F.speed }, dmg: dmg(), uas: UAS.netState() });
      NET.emit = (type, o) => send(type, o);
      onLink = st => {
        if (st === 'open') roster();
        else if (st === 'refused') say('Room ' + NET.room + ' is held by another instructor', 'lost', 'Pick another room code, or add &pin=<their PIN> to the address');
        else say('Room ' + NET.room + ' · relay connection lost, retrying…', 'lost');
      };
      handle = m => {
        if (!m || m.from === me) return;
        if (m.type === 'hostok') { keepPin(); return; }
        if (m.type === 'hello' || m.type === 'ping') {
          const isNew = !students.has(m.from); students.set(m.from, { cs: m.cs, seen: performance.now() });
          if (m.type === 'hello') { full(m.from); if (isNew) FIRES.log(m.cs + ' joined the room'); }
          if (isNew) roster();
        } else if (m.type === 'bye') { const s = students.get(m.from); if (s) { students.delete(m.from); FIRES.log(s.cs + ' left the room'); roster(); } }
        else if (m.type === 'cmd') UAS.runCmd(m.op, m.a || {}, m.cs);
        else if (m.type === 'cam') { const d = UAS.droneById(m.d); if (d && UAS.debug.ctl.get(d.id) === m.cs) UAS.applyCam(d, m.cam); }
      };
      setInterval(() => send('uas', Object.assign(UAS.netState(), { clock: { t: F.simT, speed: F.speed } })), 200);   // one message: the relay bills per message
      const last = {};
      const changed = (k, v) => { const j = JSON.stringify(v); if (j === last[k]) return false; last[k] = j; return true; };
      changed('opfor', O.netState()); changed('units', F.unitList()); changed('civ', CIV.debug.level);
      setInterval(() => {
        const op = O.netState(), un = F.unitList();
        if (changed('opfor', op)) send('opfor', { opfor: op });
        if (changed('units', un)) send('units', { units: un });
        if (changed('civ', CIV.debug.level)) send('civ', { civ: CIV.debug.level });
        send('dmg', { dmg: dmg() });
        const now = performance.now();
        for (const [id, s] of students) if (now - s.seen > 7000) { students.delete(id); FIRES.log(s.cs + ' lost contact'); roster(); }
      }, 1000);
      addEventListener('beforeunload', () => send('hostbye'));
      roster();
      return { send, students };
    }
    // ---- student
    let joined = false, lastHost = 0, paused = false;
    const status = () => say('Room ' + NET.room + ' · ' + NET.cs + (paused ? ' · PAUSED BY INSTRUCTOR' : ''), paused ? 'paused' : 'ok');
    function strikeOne(s) {
      if (s.g !== undefined) { const g = O.groups.find(o => o.id === s.g); return !!g && O.strike(g, s.i, s.t, s.cause); }
      return CIV.strike(s.civ, s.t, !!s.boat);
    }
    const applyDmg = d => { for (const s of d.opfor || []) strikeOne(s); for (const s of d.civ || []) strikeOne(s); };   // already-struck ones are skipped
    function clock(c) {
      lastHost = performance.now(); F.speed = c.speed;
      if (Math.abs(F.simT - c.t) > 0.3) F.simT = c.t;
      const p = c.speed === 0; if (p !== paused || !badge.textContent.includes(NET.cs)) { paused = p; status(); }
    }
    onLink = st => {
      if (st === 'open') { joined = false; send('hello'); }          // (re)connected: ask for the full state again
      else if (st === 'closed') say('Room ' + NET.room + ' · relay connection lost, retrying…', 'lost');
    };
    handle = m => {
      if (!m || m.from === me) return;
      if (m.type === 'nohost') { if (!joined) say('Room ' + NET.room + ' · waiting for the instructor…', 'lost'); return; }
      if (m.type === 'full') {
        if (m.to !== me) return;
        joined = true; clock(m.clock);
        CIV.set(m.civ); FIRES.setUnits(m.units); O.applyNet(m.opfor); UAS.applyNet(m.uas); applyDmg(m.dmg);
        status(); return;
      }
      if (!joined) return;
      if (m.type === 'clock') clock(m);
      else if (m.type === 'uas') { if (m.clock) clock(m.clock); UAS.applyNet(m); }
      else if (m.type === 'opfor') O.applyNet(m.opfor);
      else if (m.type === 'units') FIRES.setUnits(m.units);
      else if (m.type === 'civ') CIV.set(m.civ);
      else if (m.type === 'burst') FIRES.blast(m.e, m.n, m.s, m.y);
      else if (m.type === 'strike') strikeOne(m);
      else if (m.type === 'dmg') applyDmg(m.dmg);
      else if (m.type === 'hostbye') { lastHost = 0; joined = false; say('Room ' + NET.room + ' · the instructor left', 'lost'); }
    };
    UAS.setSend((op, a) => send('cmd', { op, a }));
    say('Room ' + NET.room + ' · joining as ' + NET.cs + '…', 'lost');
    send('hello');
    setInterval(() => { if (!joined) send('hello'); else send('ping'); }, 1500);
    setInterval(() => { if (joined) for (const c of UAS.camOut()) send('cam', c); }, 200);
    setInterval(() => { if (joined && performance.now() - lastHost > 5000 && !badge.className.includes('lost')) say('Room ' + NET.room + ' · lost the instructor, waiting…', 'lost'); else if (joined && performance.now() - lastHost < 5000 && badge.className === 'lost') status(); }, 1000);
    addEventListener('beforeunload', () => send('bye'));
    return { send };
  })();
  window.__room = ROOM;

  // ---- student screen: on the map (not at an OP, not in a feed) hide the enemy, civilians, bursts, smoke and fire, and
  //      trajectories for the one main render, then put them back. Feeds render first with their own rules, so they still see it all.
  function studentVeil() {
    const list = [OPFOR.debug.root, OPFOR.debug.pips, OPFOR.debug.lines, OPFOR.debug.handles, OPFOR.debug.fxRoot, CIV.debug.grp, FIRES.debug.fxGroup, FIRES.debug.arcGroup];
    const out = []; for (const o of list) if (o) { out.push([o, o.visible]); o.visible = false; }
    return out;
  }
  if (STUDENT) {
    document.getElementById('vw-map').click();               // the student's main view is the 2D map
    window.__opfor.showEnemy = false; window.__opfor.showRoutes = false;
  }
  let lastFrameStart = performance.now();
  // ---- MAP GRID LABELS (Lee, 2026-11-11): in the 2D Map view the 1 km grid is numbered in the margins like a printed
  //      map: easting along the top and bottom, northing down both sides, two principal digits (621000 E -> 21), plus a
  //      grid zone box (zone and 100 km square at the view centre). Every 2nd, 5th or 10th line when zoomed out so the
  //      numbers never crowd. Shown with Display -> Grid; hidden in 3D, at an OP and in UAS feeds (HTML, not in the scene).
  const MAPGRID = (() => {
    const box = document.createElement('div'); box.id = 'mapgrid'; box.hidden = true; document.body.insertBefore(box, labelBox.nextSibling);
    const gzd = document.createElement('div'); gzd.className = 'gzd'; box.appendChild(gzd);
    const pool = []; let used = 0;
    const lab = (txt, x, y, cls) => {
      let d = pool[used]; if (!d) { d = document.createElement('div'); box.appendChild(d); pool.push(d); }
      used++; if (d.textContent !== txt) d.textContent = txt; d.className = 'gl ' + cls;
      d.style.left = x + 'px'; d.style.top = y + 'px'; d.style.display = '';
    };
    const P = new THREE.Vector3(), MIN_PX = 46, STEPS = [1, 2, 5, 10];
    const sx = (x, z) => { P.set(x, 0, z).project(camera); return (P.x + 1) / 2 * canvas.clientWidth; };
    const sy = (x, z) => { P.set(x, 0, z).project(camera); return (1 - P.y) / 2 * canvas.clientHeight; };
    let top = 0, bottom = 0;
    function edges() {                    // the margins: below the banner, above the readout
      const tb = document.getElementById('topbar'), rd = document.querySelector('.readout');
      top = tb ? tb.getBoundingClientRect().bottom : 0;
      bottom = rd ? rd.getBoundingClientRect().top : canvas.clientHeight;
    }
    addEventListener('resize', edges);
    function tick() {
      const on = mapView && groups.grid.visible;
      if (box.hidden !== !on) { box.hidden = !on; if (on) edges(); }
      if (!on) return;
      used = 0;
      const w = canvas.clientWidth, t = controls.target, E0 = CE + PLAY.x0, E1 = CE + PLAY.x1, N0 = CN - PLAY.z1, N1 = CN - PLAY.z0;
      const kmPx = Math.abs(sx(t.x + 1000, t.z) - sx(t.x, t.z)), step = 1000 * (STEPS.find(k => k * kmPx >= MIN_PX) || 20);
      const yTop = top + 6, yBot = bottom - 6;
      for (let e = Math.ceil(E0 / step) * step; e <= E1; e += step) {          // eastings: top and bottom margins
        const x = sx(e - CE, t.z); if (x < 28 || x > w - 28) continue;
        const txt = String(Math.floor((e % 100000) / 1000)).padStart(2, '0');
        lab(txt, x, yTop, 'e top'); lab(txt, x, yBot, 'e bot');
      }
      for (let n = Math.ceil(N0 / step) * step; n <= N1; n += step) {          // northings: both side margins
        const y = sy(t.x, CN - n); if (y < top + 64 || y > bottom - 30) continue;   // clear of the zone box
        const txt = String(Math.floor((n % 100000) / 1000)).padStart(2, '0');
        lab(txt, 8, y, 'n left'); lab(txt, w - 8, y, 'n right');
      }
      for (let i = used; i < pool.length; i++) pool[i].style.display = 'none';
      const g = (FIRES.debug.toGrid(CE + t.x, CN - t.z) || '').split(' ');
      const txt = g.length > 1 ? 'GZD ' + g[0] + '  ·  ' + g[1] + '  ·  1 km grid' : '';
      if (gzd.textContent !== txt) gzd.textContent = txt;
      gzd.style.top = (top + 30) + 'px';
    }
    return { tick };
  })();
  (function loop(now, once) {
    now = now || performance.now(); const dt = Math.min(0.25, (now - lastT) / 1000); lastT = now;
    const fs = performance.now();
    PERF.time('fires', () => FIRES.tick(dt));
    PERF.time('opfor', () => OPFOR.tick());
    PERF.time('uas', () => UAS.tick());
    PERF.time('civ', () => CIV.tick(FIRES.debug.simT, UAS.feedFocus()));
    if (!obs) { navTick(dt); controls.update(); } reticleTick(); sky.position.copy(camera.position); WATER.time.value = now / 1000;
    const cams = [camera, ...UAS.feedCams()];
    PERF.time('trees', () => { CITY.treeTick(cams); GROUND.update(cams); OPFOR.farTick(cams); });
    PERF.time('feeds', () => UAS.renderFeeds());
    const veiled = STUDENT && !obs ? studentVeil() : null;     // the student's map hides what only the sensors may show
    PERF.time('render', () => { if (FXAA) FXAA.render(scene, camera); else renderer.render(scene, camera); });
    if (veiled) for (const [o, v] of veiled) o.visible = v;
    PERF.frame(now - lastFrameStart); lastFrameStart = now;
    MAPGRID.tick();
    if (!labelBox.hidden) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      for (const t of tags) {
        v.copy(t.v).project(camera);
        const show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        t.d.style.display = show ? '' : 'none';
        if (show) { t.d.style.left = ((v.x + 1) / 2 * w) + 'px'; t.d.style.top = ((1 - v.y) / 2 * h) + 'px'; }
      }
    }
    if (!once) requestAnimationFrame(loop);
    // testing aid: window.__frame() runs one frame by hand (a page in a hidden window gets no animation frames)
    if (!window.__frame) window.__frame = () => loop(performance.now(), true);
  })();
})().catch(err => { const l = document.getElementById('loading'); l.hidden = false; l.textContent = 'The terrain could not load in this browser: ' + err.message; });
