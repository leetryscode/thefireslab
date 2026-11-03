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
  // some servers unzip a .gz on the way out and some don't: unpack only if the bytes are still gzip (1f 8b)
  const gz = new Uint8Array(demGz, 0, 2), packed = gz[0] === 0x1f && gz[1] === 0x8b;
  const buf = packed ? await new Response(new Blob([demGz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : demGz;
  const dm = new Int16Array(buf);
  const H = new Float32Array(NX * NY);
  for (let i = 0; i < NX * NY; i++) H[i] = dm[i] < 0 ? 0 : dm[i] / 10;
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
  sky.renderOrder = -10; sky.frustumCulled = false;
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
vec3 waterShade(vec3 base, vec3 P, float foam){
  vec3 toCam = cameraPosition - P; float dist = length(toCam); vec3 V = toCam / dist;
  vec2 q = P.xz; float px = max(length(fwidth(q)), 0.01);
  vec3 n = waveNormal(q, px);
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
  float fb = foam * (0.55 + 0.45 * sin(uTime * 0.9 + wnoise(q * 0.05) * 9.0)) * (0.6 + 0.4 * wnoise(q * 0.3 + uTime * 0.2));
  return mix(c, vec3(0.86, 0.9, 0.92), clamp(fb, 0.0, 1.0) * 0.75);
}
`;
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
  function waterUniforms(sh) { sh.uniforms.uTime = WATER.time; sh.uniforms.uSun = WATER.sunDir; sh.uniforms.uHz = WATER.hz; sh.uniforms.uZn = WATER.zn; }

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
    // shrink, then blur: the fade runs ~700 m and ends inside the real photo
    const c = document.createElement('canvas'); c.width = w; c.height = h; const k = c.getContext('2d');
    k.fillStyle = '#000'; k.fillRect(0, 0, w, h); k.filter = 'blur(30px)'; k.drawImage(a, 0, 0);
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
    sh.fragmentShader = 'uniform sampler2D fadeMap;\nuniform sampler2D waterMap;\nuniform sampler2D urbanMap;\nuniform float urbanOn;\nvarying vec3 vWW;\n' + GRADE_GLSL + WATER_GLSL + sh.fragmentShader.replace('#include <color_fragment>',
      '#ifdef USE_COLOR\n  diffuseColor.rgb = mix(vColor, diffuseColor.rgb, texture2D(fadeMap, vUv).r);\n#endif\n' +
      '  { float u = texture2D(urbanMap, vUv).r * urbanOn; float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n' +
      '    diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.24, 0.235, 0.22), vec3(lum), 0.2), u * 0.92); }')
      .replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', 'outgoingLight = gradeGround(diffuseColor.rgb, outgoingLight);\n  { vec4 wm = texture2D(waterMap, vUv); if (wm.r > 0.004) outgoingLight = mix(outgoingLight, waterShade(outgoingLight, vWW, wm.g), wm.r); }\n  gl_FragColor = vec4( outgoingLight, diffuseColor.a );');   // r128 has no output_fragment chunk
  };
  const ground = new THREE.Mesh(geo, photoMat);
  scene.add(ground);
  // open ocean beyond the data, in the photo's deep-water colour, so the horizon is sea rather than void
  scene.add(sky);
  const seaMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(OCEAN).convertSRGBToLinear() });
  seaMat.extensions = { derivatives: true };
  seaMat.onBeforeCompile = sh => {
    waterUniforms(sh);
    sh.vertexShader = 'varying vec3 vWW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'varying vec3 vWW;\n' + WATER_GLSL + sh.fragmentShader.replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
      'outgoingLight = waterShade(outgoingLight, vWW, 0.0);\n  gl_FragColor = vec4( outgoingLight, diffuseColor.a );');
  };
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(160000, 160000, 1, 1), seaMat);
  sea.rotation.x = -Math.PI / 2; sea.position.y = -2; scene.add(sea);
  scene.add(new THREE.HemisphereLight(0xdfe6d8, 0x2a2a22, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(-6000, 7000, -4000);
  scene.add(sun);

  // ---- overlays, rebuilt when exaggeration changes
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

  function buildGrid() {
    clear(groups.grid);
    const pts = [];
    for (let e = Math.ceil(W / 1000) * 1000; e <= W + NX * CELL; e += 1000) {
      const v = drape([toLocal(e, NTOP - 5), toLocal(e, NTOP - NY * CELL + 5)], 4, CELL);
      for (let k = 0; k < v.length - 1; k++) if (inImagery((v[k].x + v[k + 1].x) / 2, (v[k].z + v[k + 1].z) / 2)) pts.push(v[k], v[k + 1]);
    }
    for (let n = Math.ceil((NTOP - NY * CELL) / 1000) * 1000; n <= NTOP; n += 1000) {
      const v = drape([toLocal(W + 5, n), toLocal(W + NX * CELL - 5, n)], 4, CELL);
      for (let k = 0; k < v.length - 1; k++) if (inImagery((v[k].x + v[k + 1].x) / 2, (v[k].z + v[k + 1].z) / 2)) pts.push(v[k], v[k + 1]);
    }
    groups.grid.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xd6b25a, transparent: true, opacity: 0.45 })));
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
    for (let i = 0; i < NX * NY; i++) pos.setY(i, H[i] * ex);
    pos.needsUpdate = true; geo.computeVertexNormals();
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
  function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); for (const m of fatMats) m.resolution.set(w, h); }
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
      function crownGeo(seed) {
        const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position, c = new Float32Array(p.count * 3);
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
      function palmGeo() {
        const P = [], C = [], F = 9, S = 4;
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
      const crowns = counts.map((c, k) => new THREE.InstancedMesh(crownGeo(k * 1.7 + 0.4), leafMat, Math.max(1, c)));
      const palms = new THREE.InstancedMesh(palmGeo(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), Math.max(1, nPalm));
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
      for (const m of [...crowns, palms, trunks]) {
        m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.frustumCulled = false; tGrp.add(m);
      }
      st.palms = pi;
    }
    const metaEl = document.getElementById('city-meta');
    async function init() {
      let d;
      try { d = await load('city.json', 'json'); }
      catch (e) { console.warn('city.json not loaded:', e.message); if (metaEl) metaEl.textContent = 'Buildings and trees: data not found.'; return; }
      const t0 = performance.now();
      [OB, OT] = await Promise.all([grid(d.ob), grid(d.ot)]);
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
    return { set, setRoofs, roofAt, solidAt: (x, z) => roofAt(x, z, true) !== null, get ready() { return st.ready; }, debug: { st, P, get HB() { return HB; }, bGrp, tGrp } };
  })();
  window.__city = CITY.debug;

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
    const key = new Map(), X = [], Z = [], E = [];           // E: [a, b, cls]
    const node = (x, z) => { const k = x * 262144 + z; let i = key.get(k); if (i === undefined) { i = X.length; key.set(k, i); X.push(x / 10); Z.push(z / 10); } return i; };
    for (const [, cls, f] of R) { let p = node(f[0], f[1]); for (let i = 2; i < f.length; i += 2) { const q = node(f[i], f[i + 1]); if (q !== p) E.push(p, q, cls); p = q; } }
    const n = X.length, deg = new Int32Array(n + 1);
    for (let e = 0; e < E.length; e += 3) { deg[E[e] + 1]++; deg[E[e + 1] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const to = new Int32Array(deg[n]), w = new Float32Array(deg[n]), fill = deg.slice(0, n);
    const SEG = 100, seg = new Map();                          // 100 m buckets of edge ids
    for (let e = 0; e < E.length; e += 3) {
      const a = E[e], b = E[e + 1], c = ROAD_W[E[e + 2]] * Math.hypot(X[b] - X[a], Z[b] - Z[a]);
      to[fill[a]] = b; w[fill[a]++] = c; to[fill[b]] = a; w[fill[b]++] = c;
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
    // shortest road path between two points; null if either is more than ROAD_REACH from a road or no road path joins them
    function path(ax, az, bx, bz) {
      const A = nearest(ax, az), B = nearest(bx, bz); if (!A || !B) return null;
      const P = [{ x: ax, z: az }, { x: A.x, z: A.z }];
      if (A.s === B.s) { P.push({ x: B.x, z: B.z }, { x: bx, z: bz }); return P; }
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
        for (let k = deg[i]; k < deg[i + 1]; k++) push(to[k], gi + w[k], i);
        if (done.size > 60000) break;
      }
      if (bestEnd < 0) return null;
      const mid = []; for (let i = bestEnd; i !== -1; i = prev.get(i)) mid.push({ x: X[i], z: Z[i] });
      P.push(...mid.reverse(), { x: B.x, z: B.z }, { x: bx, z: bz });
      return P.filter((p, k) => !k || Math.hypot(p.x - P[k - 1].x, p.z - P[k - 1].z) > 0.5);
    }
    return { path, nearest, nodes: n, edges: E.length / 3 };
  }

  const ROADS = (() => {
    const grp = new THREE.Group(); scene.add(grp); window.__roads = grp;
    const prevEx = onExCity; onExCity = () => { if (prevEx) prevEx(); grp.scale.y = ex; };
    const lin = v => Math.pow(v / 255, 2.2);
    const ASPH = [[86, 88, 92], [98, 99, 102], [116, 116, 114]].map(c => c.map(lin)), KERB = [184, 182, 174].map(lin);
    (async () => {
      let d; try { d = await load('roads.json', 'json'); } catch (e) { console.warn('roads.json not loaded:', e.message); return; }
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
    let prev = 0;
    for (let t = 0; t < 70000; t += 8) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (Math.abs(x) > HW || Math.abs(z) > HH) { prev = t; continue; }
      if (y <= heightAt(x, z) * ex) {
        let lo = prev, hi = t;
        for (let k = 0; k < 20; k++) { const mid = (lo + hi) / 2; if (o.y + d.y * mid <= heightAt(o.x + d.x * mid, o.z + d.z * mid) * ex) hi = mid; else lo = mid; }
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
    hEl.textContent = dm[rr * NX + c] < 0 ? 'sea (no data)' : heightAt(p.x, p.z).toFixed(0) + ' m';
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
  const FIRES = (() => {
    // Placeholder figures, all in one place. Replace with real values when supplied.
    const TYPES = {
      m777: { label: 'M777 155 mm battery', short: 'M777', tubes: 6, rounds: 300, min: 2500, max: 22000, angle: 'low',
              tof: R => 8 + R / 350, interval: 15, sheaf: 100, sR: R => 10 + 0.0035 * R, sD: R => 5 + 0.0015 * R, burst: 1.0 },
      m119: { label: 'M119 105 mm battery', short: 'M119', tubes: 6, rounds: 360, min: 1500, max: 11500, angle: 'low',
              tof: R => 6 + R / 280, interval: 10, sheaf: 80, sR: R => 8 + 0.004 * R, sD: R => 4 + 0.002 * R, burst: 0.75 },
      m120: { label: '120 mm mortar section', short: '120mm', tubes: 4, rounds: 200, min: 200, max: 7200, angle: 'high',
              tof: R => 15 + R / 300, interval: 8, sheaf: 60, sR: R => 10 + 0.008 * R, sD: R => 6 + 0.004 * R, burst: 0.8 },
      m252: { label: '81 mm mortar section', short: '81mm', tubes: 4, rounds: 240, min: 80, max: 5600, angle: 'high',
              tof: R => 12 + R / 300, interval: 5, sheaf: 40, sR: R => 8 + 0.01 * R, sD: R => 5 + 0.005 * R, burst: 0.55 }
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
    function addUnit(type, e, n, alt) {
      const t = TYPES[type], count = units.filter(u => u.type === type).length + 1;
      const name = t.short + ' ' + 'ABCDEFGH'[count - 1];
      const u = { id: nextId++, type, name, e, n, alt: onMap(e, n) ? null : (alt || 0), rounds: t.rounds };
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
    const addBtns = $('addbtns'); let placing = null, moving = null, picking = false;
    const placeMsg = $('place-msg'), fmMsg = $('fm-msg');
    function msg(el, text, cls) { el.textContent = text; el.className = 'msg' + (cls ? ' ' + cls : ''); }
    for (const [k, t] of Object.entries(TYPES)) {
      const b = document.createElement('button'); b.id = 'add-' + k; b.textContent = '+ ' + t.short; b.title = t.label;
      b.addEventListener('click', () => { placing = k; moving = null; picking = false; msg(placeMsg, 'Click the map to place a ' + t.label + ', or type a grid and press Place. Esc cancels.', 'arm'); });
      addBtns.appendChild(b);
    }
    $('place-go').addEventListener('click', () => {
      const g = parseGrid($('place-grid').value); if (g.err) return msg(placeMsg, g.err, 'bad');
      if (moving) { moveUnit(moving, g.e, g.n, Number($('place-alt').value) || 0); return; }
      if (!placing) return msg(placeMsg, 'Pick a unit type first.', 'bad');
      addUnit(placing, g.e, g.n, Number($('place-alt').value) || 0); placing = null; msg(placeMsg, 'Placed. Pick another type to add more.');
    });
    function moveUnit(u, e, n, alt) {
      u.e = e; u.n = n; u.alt = onMap(e, n) ? null : (alt || 0); placeSprite(u); moving = null;
      log('Moved ' + u.name + ' to ' + gridTxt(e, n) + (onMap(e, n) ? '' : ' (off map)')); msg(placeMsg, 'Moved.'); drawUnits();
    }
    function drawUnits() {
      const L = $('ulist'); L.textContent = '';
      for (const u of units) {
        const row = document.createElement('div'); row.className = 'urow';
        const nm = document.createElement('span'); nm.className = 'un'; nm.textContent = u.name + '  ' + u.rounds + ' rds';
        const gr = document.createElement('span'); gr.className = 'ug'; gr.textContent = gridTxt(u.e, u.n) + (onMap(u.e, u.n) ? '' : '  off map'); nm.appendChild(gr);
        const mv = document.createElement('button'); mv.textContent = 'Move'; mv.addEventListener('click', () => { moving = u; placing = null; msg(placeMsg, 'Click the map, or type a grid and press Place, to move ' + u.name + '.', 'arm'); });
        const rm = document.createElement('button'); rm.textContent = 'Remove'; rm.addEventListener('click', () => { unitGroup.remove(u.sprite); units.splice(units.indexOf(u), 1); log('Removed ' + u.name); drawUnits(); });
        row.append(nm, mv, rm); L.appendChild(row);
      }
      const sel = $('fm-unit'), keep = sel.value; sel.textContent = '';
      if (!units.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'Place a unit first'; sel.appendChild(o); }
      for (const u of units) { const o = document.createElement('option'); o.value = String(u.id); o.textContent = u.name + ' (' + u.rounds + ')'; sel.appendChild(o); }
      if (units.some(u => String(u.id) === keep)) sel.value = keep;
    }

    // ---- fire missions
    $('fm-pick').addEventListener('click', () => { picking = true; placing = null; moving = null; msg(fmMsg, 'Click the target on the map. Esc cancels.', 'arm'); });
    $('fm-fire').addEventListener('click', fire);
    function fire() {
      const u = units.find(x => String(x.id) === $('fm-unit').value);
      if (!u) return msg(fmMsg, 'Place a firing unit first.', 'bad');
      const g = parseGrid($('fm-grid').value); if (g.err) return msg(fmMsg, g.err, 'bad');
      if (!onMap(g.e, g.n)) return msg(fmMsg, 'That target is off the map.', 'bad');
      const t = TYPES[u.type], R = Math.hypot(g.e - u.e, g.n - u.n);
      if (R > t.max) return msg(fmMsg, `Out of range: ${(R / 1000).toFixed(1)} km, ${t.short} max ${(t.max / 1000).toFixed(1)} km.`, 'bad');
      if (R < t.min) return msg(fmMsg, `Inside minimum range: ${Math.round(R)} m, ${t.short} min ${t.min} m.`, 'bad');
      const per = Number($('fm-rds').value), total = per * t.tubes;
      if (total > u.rounds) return msg(fmMsg, `${u.name} has only ${u.rounds} rounds; this mission needs ${total}.`, 'bad');
      u.rounds -= total; drawUnits();
      const id = missions.length + 1, r = rng(id * 2654435761 + u.id * 97), tof = t.tof(R);
      const ux = (g.e - u.e) / R, uy = (g.n - u.n) / R;       // gun-target line, east/north components
      const impacts = [];
      for (let k = 0; k < per; k++) for (let j = 0; j < t.tubes; j++) {
        const lat = t.tubes > 1 ? (j / (t.tubes - 1) - 0.5) * t.sheaf : 0;  // parallel sheaf across the gun-target line
        const dr = gauss(r) * t.sR(R), dd = gauss(r) * t.sD(R) + lat;
        impacts.push({ t: simT + k * t.interval + tof + r() * 1.5, e: g.e + ux * dr - uy * dd, n: g.n + uy * dr + ux * dd, done: false });
      }
      const m = { id, u, t, g, R, tof, per, t0: simT, impacts, splash: false, endT: Math.max(...impacts.map(i => i.t)), arc: null, shells: [] };
      missions.push(m); buildArc(m);
      log(`M${id} ${u.name} → ${gridTxt(g.e, g.n)}, ${per} rd × ${t.tubes}, range ${(R / 1000).toFixed(1)} km, ToF ${Math.round(tof)} s — SHOT`);
      msg(fmMsg, `Mission ${id} away. Splash in ${Math.round(tof)} s.`);
    }

    // ---- arcs: a gun-to-target curve shaped for the eye (apex grows with range; high angle for mortars)
    function arcPoint(m, f, out) {
      const G = gunPos(m.u), tp = toLocal(m.g.e, m.g.n), T = new THREE.Vector3(tp.x, heightAt(tp.x, tp.z) * ex, tp.z);
      const apex = m.R * (m.t.angle === 'high' ? 0.43 : 0.117) * Math.min(1, ex);
      return out.copy(G).lerp(T, f).setY(G.y + (T.y - G.y) * f + 4 * apex * f * (1 - f));
    }
    function buildArc(m) {
      const pts = []; const tmp = new THREE.Vector3();
      for (let i = 0; i <= 64; i++) pts.push(arcPoint(m, i / 64, tmp).clone());
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
      const p = toLocal(i.e, i.n), y = heightAt(p.x, p.z) * ex, s = m.t.burst;
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0xffd27a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      flash.position.set(p.x, y + 4, p.z); fxGroup.add(flash);
      const smoke = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x3e3a36, transparent: true, depthWrite: false }));
      smoke.position.set(p.x, y + 6, p.z); fxGroup.add(smoke);
      const scorch = new THREE.Mesh(scorchGeo, new THREE.MeshBasicMaterial({ map: smokeTex, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      scorch.rotation.x = -Math.PI / 2; scorch.position.set(p.x, y + 0.5, p.z); scorch.scale.setScalar(14 * s); fxGroup.add(scorch);
      fx.push({ flash, smoke, scorch, t0: i.t, y, s });
      if (fx.length > 600) { const o = fx.shift(); fxGroup.remove(o.flash, o.smoke, o.scorch); }
    }
    function animateFx() {
      for (const f of fx) {
        const a = simT - f.t0;
        f.flash.visible = a >= 0 && a < 0.8; if (f.flash.visible) { const k = 25 + 70 * f.s * (a / 0.8); f.flash.scale.set(k, k, 1); f.flash.material.opacity = 1 - a / 0.8; }
        const life = 60; f.smoke.visible = a >= 0 && a < life;
        if (f.smoke.visible) { const k = (18 + 60 * Math.sqrt(a / life)) * f.s; f.smoke.scale.set(k, k * 1.25, 1); f.smoke.position.y = f.y + k * 0.45 + a * 0.8; f.smoke.material.opacity = 0.9 * Math.pow(1 - a / life, 1.5); }
        f.scorch.visible = a >= 0 && a < 600; if (f.scorch.visible) f.scorch.material.opacity = 0.55 * (1 - a / 600);
      }
    }

    // ---- the clock step
    const tmpV = new THREE.Vector3();
    function tick(dt) {
      simT += dt * speed; $('clock').textContent = fmt(simT);
      for (const m of missions) {
        if (!m.splash && simT >= m.t0 + m.tof - 5) { m.splash = true; log(`M${m.id} SPLASH`); }
        m.impacts.forEach((i, k) => { if (!i.done && simT >= i.t) { i.done = true; burst(i, m); for (const f of impactFns) f(i, m, k); } });
        for (let k = 0; k < m.per; k++) {
          const f = (simT - (m.t0 + k * m.t.interval)) / m.tof, s = m.shells[k];
          s.visible = arcsOn && f > 0 && f < 1;
          if (s.visible) { arcPoint(m, f, tmpV); s.position.copy(tmpV); const d = camera.position.distanceTo(tmpV) * 0.004; s.scale.setScalar(Math.max(2, d)); }
        }
        if (m.arc && simT > m.endT + 20) { arcGroup.remove(m.arc); m.arc.geometry.dispose(); m.arc = null; log(`M${m.id} rounds complete, ${m.impacts.length} rds, ${m.struck || 0} struck`); }
      }
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
    addEventListener('keydown', e => { if (e.code === 'Space' && !obs && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); playing = !playing; applyClock(); } });
    function setMap(on) {
      mapMode = on; $('vw-map').setAttribute('aria-pressed', String(on)); $('vw-3d').setAttribute('aria-pressed', String(!on));
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
      if (moved > 5 || !(placing || moving || picking)) return;
      const p = pick(e.clientX, e.clientY); if (!p) return;
      const E = CE + p.x, N = CN - p.z;
      if (placing) { addUnit(placing, E, N, 0); msg(placeMsg, 'Placed. Pick another type to add more.'); placing = null; }
      else if (moving) moveUnit(moving, E, N, 0);
      else if (picking) { $('fm-grid').value = toGrid(E, N); picking = false; msg(fmMsg, 'Target set. Press Fire.'); }
    });
    addEventListener('keydown', e => { if (e.key === 'Escape' && (placing || moving || picking)) { placing = moving = null; picking = false; msg(placeMsg, 'Cancelled.'); msg(fmMsg, ''); } });
    drawUnits();
    return { tick, onImpact: f => impactFns.push(f), onExaggeration() { for (const u of units) placeSprite(u); }, blast(e, n, size) { burst({ e, n, t: simT }, { t: { burst: size } }); }, log, debug: { units, missions, fx, parseGrid, toGrid, addUnit, TYPES, unitGroup, arcGroup, get simT() { return simT; }, set simT(v) { simT = Math.max(0, +v || 0); } } };
  })();
  window.__fires = FIRES.debug; window.__view = { camera, controls, toLocal, heightAt }; window.__firesHook = () => { FIRES.onExaggeration(); if (typeof OPFOR !== 'undefined') OPFOR.onExaggeration(); };


  // ---- OPFOR: enemy groups (convoys), drawn routes, ships that carry cargo groups.
  //      Everything a vehicle does is a pure function of the sim clock, so pause, 5x/10x and
  //      editing at T+0 all just work. Damage comes later. Vehicle figures are placeholders.
  const OPFOR = (function () {
    const $ = id => document.getElementById(id);
    // L x W x H metres, approximate public figures; speeds km/h; all placeholders to tune
    const VT = {
      zbd:  { name: 'ZBD',         L: 9.5, W: 3.4, H: 2.6, amph: true,  land: 40, water: 20, gap: 50 },
      ztd:  { name: 'ZTD',         L: 9.5, W: 3.4, H: 2.8, amph: true,  land: 40, water: 20, gap: 50 },
      eng:  { name: 'Engineering', L: 8.0, W: 3.2, H: 3.2, amph: false, land: 30, water: 0,  gap: 50 },
      fuel: { name: 'Fuel Truck',  L: 9.0, W: 2.5, H: 3.3, amph: false, land: 40, water: 0,  gap: 50 },
      plz:  { name: 'PLZ-05 SPH',  L: 10.6, W: 3.3, H: 3.3, amph: false, land: 40, water: 0,  gap: 50 },   // 155 mm SP howitzer; model has 'turret' and 'gun' nodes for aiming
      lcu:  { name: 'LCU',         L: 41,  W: 9,   H: 5,   ship: true,  land: 0,  water: 18, gap: 150, draft: 1.5, unload: 120 },
      roro: { name: 'RoRo',        L: 150, W: 25,  H: 22,  ship: true,  land: 0,  water: 25, gap: 500, draft: 6,   unload: 600 }
    };
    const LAND = ['zbd', 'ztd', 'eng', 'fuel', 'plz'], SHIPS = ['lcu', 'roro'];
    const KEY = 'fist-trainer-opfor-v2';                   // v1 (straight-line test routes) dropped 2026-11-02
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

    // ---- persistence (this browser only; scenario files come later)
    function save() { try { localStorage.setItem(KEY, JSON.stringify({ nextId, groups: groups.map(g => ({ id: g.id, name: g.name, units: g.units, route: g.route, start: g.start, land: g.land, water: g.water, gap: g.gap, carrier: g.carrier, unload: g.unload, parent: g.parent || null, splitAt: g.splitAt, join: g.join || null, roads: g.roads !== false })) })); } catch (e) {} }
    function load() { try { const o = JSON.parse(localStorage.getItem(KEY)); if (o && Array.isArray(o.groups)) { groups = o.groups; nextId = o.nextId || groups.length + 1; } } catch (e) {} }

    // ---- motion profile: arc length vs time along the route, speed by land or water
    function fullRoute(g, d = 0) {             // own points, then (if rejoined) the rest of the route it joins
      if (!g.join || d > 6) return g.route;
      const tg = groups.find(o => o.id === g.join.group); if (!tg) return g.route;
      return g.route.concat(fullRoute(tg, d + 1).slice(g.join.at + 1));
    }
    // ---- road snapping (Lee, 2026-11-02): land groups follow the roads between clicked points by default.
    //      A leg stays a straight line when the group is a ship, the group has Follow roads off, either end is in the
    //      water (beach landings, swims), or no road lies within ROAD_REACH of an end. Straight legs (and the short
    //      off-road links from a clicked point to its road) are checked against building footprints and warned.
    const legCache = new Map();
    const snapOn = g => !isShip(g) && g.roads !== false;
    function leg(g, a, b) {                    // a, b local points -> { pts: [a ... b], road, why }
      const on = snapOn(g), k = (on ? 1 : 0) + '|' + Math.round(a.x) + ',' + Math.round(a.z) + '|' + Math.round(b.x) + ',' + Math.round(b.z);
      let r = legCache.get(k); if (r) return r;
      let why = !on ? '' : waterAt(a.x, a.z) || waterAt(b.x, b.z) ? 'water' : !ROADNET ? 'loading' : '';
      let pts = null;
      if (on && !why) { pts = ROADNET.path(a.x, a.z, b.x, b.z); if (!pts) why = 'noroad'; }
      r = { pts: pts || [{ x: a.x, z: a.z }, { x: b.x, z: b.z }], road: !!pts, why };
      r.cross = crossings(r);
      if (why !== 'loading' && (CITY.ready || !r.cross.length)) legCache.set(k, r);
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
      for (let k = 1; k < pts.length; k++) { const l = leg(g, pts[k - 1], pts[k]); legs.push(l); out.push(...l.pts.slice(1)); at.push(out.length - 1); }
      return { pts: out, at, legs };
    }
    onRoadNet = () => { legCache.clear(); refresh(); };
    onCityReady = () => { legCache.clear(); refresh(); };

    function profile(g) {
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
          const wet = waterAt(x, z), kmh = ship ? g.water : (wet ? (g.water || g.land) : g.land);
          s += ds; t += ds / Math.max(0.5, kmh / 3.6);
          S.push(s); T.push(t); X.push(x); Z.push(z);
        }
        while (wp < rp.at.length && rp.at[wp] === k) { wpS[wp] = s; hold(wp); wp++; }   // a clicked route point: holds and split points key on these
      }
      g.prof = { S, T, X, Z, len: s, dur: t, stops, wpS, legs: rp.legs };
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
    const splitNeed = b => { const p = parentOf(b); return p && p.prof && p.prof.wpS[b.splitAt] !== undefined ? p.prof.wpS[b.splitAt] + offsetOf(b) * p.gap : null; };
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
      return arr === null ? null : arr + (c.unload || 0) + g.start;
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
          const sp = sAt(p, t); return sp === null ? null : Math.min(0, sp - offsetOf(g) * p.gap - p.prof.wpS[g.splitAt]); }
      }
      if (!g.prof) return null;
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
    const WAKE_MAX = 9000, WAKE_AGE = 60, WAKE_STEP = 3;
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
        if (n + 6 > WAKE_MAX) return;
        for (const [x, z, a] of [[ax, az, a0], [bx, bz, a0], [cx, cz, a1], [ax, az, a0], [cx, cz, a1], [dx, dz, a1]]) {
          wakePos[n * 3] = x; wakePos[n * 3 + 1] = 0.3; wakePos[n * 3 + 2] = z; wakeA[n] = a; n++;
        }
      };
      for (const g of groups) {
        if (!g.prof) continue;
        const ship = isShip(g);
        const v = view.g.get(g.id); if (!v) continue;
        v.meshes.forEach((m, i) => {
          if (!m.visible || struckAt(g, i, t)) return;                     // a struck vehicle has stopped: no wake
          const T = VT[m.userData.t], pts = [];
          if (!ship && !(T.amph && waterAt(m.position.x, m.position.z))) return;   // land vehicles: only while swimming
          for (let k = 0; k * WAKE_STEP <= WAKE_AGE; k++) {
            const sk = sAt(g, t - k * WAKE_STEP); if (sk === null) break;
            const r = resolve(g, sk - i * g.gap); if (!r || !r.g.prof) break;
            const p = posAt(r.g, r.s), fx = Math.sin(p.hd), fz = Math.cos(p.hd);
            if (!ship && !waterAt(p.x, p.z)) break;                          // the wake starts where it entered the water
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
    const MODELS = { zbd: { url: 'data/m01.bin', yaw: -Math.PI / 2 }, fuel: { url: 'data/m02.bin', yaw: 0 }, lcu: { url: 'data/m03.bin', yaw: Math.PI }, roro: { url: 'data/m04.bin', yaw: 0 }, eng: { url: 'data/m05.bin', yaw: -Math.PI / 2 }, plz: { url: 'data/m06.bin', yaw: 0 }, ztd: { url: 'data/m07.bin', yaw: 0 } }, tmpl = {};   // yaw turns the model's nose onto +Z
    function makeBody(t) {
      if (!tmpl[t]) return new THREE.Mesh(boxGeo[t], boxMat[t]);
      const o = tmpl[t].clone(); o.position.y = -VT[t].H / 2; o.rotation.y = MODELS[t].yaw || 0; return o;   // container sits at H/2; model pivot on the ground
    }
    function makeVeh(t) { const c = new THREE.Group(); c.userData.t = t; c.add(makeBody(t)); return c; }
    if (THREE.GLTFLoader) for (const t of Object.keys(MODELS)) new THREE.GLTFLoader().load(MODELS[t].url, gl => {
      tmpl[t] = gl.scene;
      for (const [, v] of view.g) for (const c of v.meshes) if (c.userData.t === t) { c.clear(); c.add(makeBody(t)); }
    }, undefined, e => console.warn('Vehicle model failed to load; keeping boxes:', t, e));
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
    const vName = (g, i) => VT[vehicles(g)[i]].name + ' ' + (i + 1) + ' of ' + g.name;
    function vehiclesAt(t) {                   // every vehicle on the ground at time t (not aboard a ship), struck ones where they stopped
      const out = [];
      for (const g of groups) {
        const st0 = startOf(g); if (g.carrier && (st0 === null || t < st0)) continue;
        const s0 = sAt(g, t); if (s0 === null) continue;
        vehicles(g).forEach((type, i) => {
          const w = struckAt(g, i, t);
          if (w) { out.push({ g, i, type, key: skey(g, i), x: w.x, z: w.z, hd: w.hd, struck: true }); return; }
          const r = resolve(g, s0 - i * g.gap); if (!r || !r.g.prof) return;
          const p = posAt(r.g, r.s); out.push({ g, i, type, key: skey(g, i), x: p.x, z: p.z, hd: p.hd, struck: false });
        });
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
    function makeFx(type) {
      const T = VT[type], big = type === 'fuel' ? 1.8 : 1, g = new THREE.Group();
      const flames = [0xff8a30, 0xffcf70].map((c, k) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, color: c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); s.renderOrder = 6; g.add(s); return s; });
      const puffs = []; for (let k = 0; k < PUFFS; k++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0x111010, transparent: true, depthWrite: false })); s.renderOrder = 5; g.add(s); puffs.push(s); }
      fxRoot.add(g); return { g, flames, puffs, big, T };
    }
    function dropFx(w) { if (!w.fx) return; fxRoot.remove(w.fx.g); for (const o of w.fx.g.children) o.material.dispose(); w.fx = null; }
    function strike(g, i, t, cause) {
      const k = skey(g, i); if (struck.has(k)) return false;
      const v = vehiclesAt(t).find(o => o.key === k); if (!v) return false;
      const w = { t, x: v.x, z: v.z, hd: v.hd, cause, type: v.type }; w.fx = makeFx(v.type); struck.set(k, w); return true;
    }
    function animFx(t) {
      for (const [, w] of struck) {
        const f = w.fx; if (!f) continue;
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
        if (!g || i >= vehicles(g).length || vehicles(g)[i] !== w.type) { dropFx(w); struck.delete(k); } }
    }
    const struckCount = g => vehicles(g).filter((_, i) => struckAt(g, i, simT())).length;

    function rebuildViews() {
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
      }
      if (sel && editing) {
        if (joinPick) {
          for (const o of groups) if (canJoin(sel, o)) o.route.forEach((q, i) => { if (i > 0 || !o.parent) addHandle(toLocal(q.e, q.n), hTexJoin, { gid: o.id, i, join: true }); });
        } else {
          for (const o of groups) if (o !== sel && inFamily(o, sel)) o.route.forEach((q, i) => addHandle(toLocal(q.e, q.n), hTexFam, { gid: o.id, i, fam: true }));
          const pts = sel.route.map(p => toLocal(p.e, p.n));
          pts.forEach((p, i) => addHandle(p, i === selPt ? hTexSel : hTexPt, { gid: sel.id, i }));
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
      const k = data.mid ? 0.011 : data.fam ? 0.013 : 0.016; s.scale.set(k, k, 1);
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
        const last = g.route.length - 1, keep = g.route[last] && g.route[last].hold;
        g.route[last] = { e: q.e, n: q.n }; if (keep) g.route[last].hold = keep;
      }
      for (const g of groups) if (g.parent) {
        const p = parentOf(g), q = p && p.route[g.splitAt];
        if (!q) { detach(g); continue; }
        const first = { e: q.e, n: q.n }; if (g.route[0] && g.route[0].hold) first.hold = g.route[0].hold;
        if (g.route.length) g.route[0] = first; else g.route.push(first);
      }
    }
    function detach(b) { const st = b.parent ? startOf(b) : b.start; b.parent = null; delete b.splitAt; b.start = st === null || !isFinite(st) ? 0 : Math.round(st); }
    let note = '';
    function refresh() { syncBranches(); for (const g of groups) profile(g); pruneStruck(); rebuildViews(); rebuildLines(); renderList(); renderEditor(); save(); }

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
      if (c && t < st - g.start) return t < st - g.start - (c.unload || 0) ? 'Aboard ' + c.name : 'Unloading';
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
      for (const g of groups) {
        const v = view.g.get(g.id); if (!v) continue;
        const cargo = !!g.carrier, st0 = startOf(g), aboard = cargo && (st0 === null || t < st0);
        const s0 = aboard ? null : sAt(g, t);
        let leadPos = null, gap = g.gap;
        let anyPos = null;
        v.meshes.forEach((m, i) => {
          if (s0 === null) { m.visible = false; return; }
          const w = struckAt(g, i, t);
          const r = w ? null : resolve(g, s0 - i * gap);
          if (!w && (!r || !r.g.prof)) { m.visible = false; return; }       // aboard, or no route to stand on
          const p = w || posAt(r.g, r.s), T = VT[m.userData.t];
          charred(m, !!w);
          const wet = waterAt(p.x, p.z), ground = wet ? 0 : heightAt(p.x, p.z) * ex;
          const draft = T.draft || (wet && T.amph ? T.H * 0.6 : 0);          // swimming IFVs ride low, about 1 m showing
          m.position.set(p.x, ground + T.H / 2 - draft, p.z); m.rotation.y = p.hd; m.visible = true;
          if (!leadPos && !w && (!g.parent || s0 >= 0)) leadPos = m.position;   // the symbol rides the first vehicle still running
          if (!anyPos && (!g.parent || s0 >= 0)) anyPos = m.position;
        });
        if (!leadPos) leadPos = anyPos;          // all struck: the symbol stays on the wrecks
        const showSym = !!leadPos && !obs && showEnemy;
        v.sym.visible = showSym;
        if (showSym) v.sym.position.set(leadPos.x, leadPos.y + 30, leadPos.z);
        let showLab = showSym && !labelHidden();
        if (showLab) { pv.copy(v.sym.position).project(camera); showLab = pv.z < 1 && Math.abs(pv.x) < 1.1 && Math.abs(pv.y) < 1.1;
          if (showLab) { v.label.style.left = ((pv.x + 1) / 2 * w) + 'px'; v.label.style.top = ((1 - pv.y) / 2 * h - 14) + 'px'; } }
        v.label.style.display = showLab ? '' : 'none';
      }
      updateWakes(t); animFx(t);
      root.visible = showEnemy; lines.visible = !obs && showRoutes; handles.visible = !obs;
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
      if (!editing || !sel || e.target !== canvas || e.button !== 0) return;
      downAt = { x: e.clientX, y: e.clientY }; dragged = false;
      const h = hitHandle(e);
      if (joinPick) { if (h && h.join) { e.stopPropagation(); e.preventDefault(); doJoin(sel, groups.find(o => o.id === h.gid), h.i); downAt = null; } return; }
      if (!h) return;
      e.stopPropagation(); e.preventDefault(); controls.enabled = false;
      if (h.mid) { drag = { mid: h.i }; return; }
      if (h.gid !== sel.id) { sel = groups.find(o => o.id === h.gid); renderList(); }
      drag = { i: h.i }; selPt = h.i; rebuildLines(); renderEditor();
    }, true);
    addEventListener('pointermove', e => {
      if (drag === null) return;
      const p = pick(e.clientX, e.clientY); if (!p) return;
      if (drag.mid !== undefined) { sel.route.splice(drag.mid + 1, 0, toEN(p)); shiftRefs(sel, drag.mid + 1, 1); drag = { i: drag.mid + 1 }; selPt = drag.i; }
      if (sel.parent && drag.i === 0) return;              // a branch starts where its parent splits
      if (sel.join && drag.i === sel.route.length - 1) return;   // and ends where it rejoins
      sel.route[drag.i] = Object.assign({}, sel.route[drag.i], toEN(p)); dragged = true; profile(sel); rebuildLines();
    }, true);
    addEventListener('pointerup', e => {
      if (drag !== null) { drag = null; controls.enabled = !obs; refresh(); downAt = null; return; }
      if (!editing || !sel || e.target !== canvas || !downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y); downAt = null;
      if (moved > 5) return;
      const p = pick(e.clientX, e.clientY); if (!p) return;
      if (joinPick) return;
      if (sel.join) { sel.route.splice(sel.route.length - 1, 0, toEN(p)); selPt = sel.route.length - 2; }   // new points go before the rejoin
      else { sel.route.push(toEN(p)); selPt = sel.route.length - 1; }
      refresh();
    }, true);
    canvas.addEventListener('dblclick', () => { if (editing) setEditing(false); });
    addEventListener('keydown', e => {
      if (!editing || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (joinPick && e.key === 'Escape') { joinPick = false; rebuildLines(); renderEditor(); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Escape') { setEditing(false); e.preventDefault(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && sel.route.length) {
        const i = selPt >= 0 && selPt < sel.route.length ? selPt : sel.route.length - 1; e.preventDefault();
        if (sel.parent && i === 0) { note = 'That point is the split from ' + parentOf(sel).name + '; it cannot be removed here.'; renderEditor(); return; }
        if (sel.join && i === sel.route.length - 1) { note = 'That point is where it rejoins; press Unjoin first.'; renderEditor(); return; }
        const used = refsAt(sel, i); if (used.length) { note = used.map(o => o.name).join(', ') + ' ' + (used.length > 1 ? 'use' : 'uses') + ' that point to split or rejoin. Change ' + (used.length > 1 ? 'them' : 'it') + ' first.'; renderEditor(); return; }
        sel.route.splice(i, 1); shiftRefs(sel, i + 1, -1);
        selPt = Math.min(i, sel.route.length - 1); refresh();
      }
    });
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
        units: [{ type, n: T.ship ? 1 : 6 }], route: [], roads: true, start: 0, land: T.land, water: T.water, gap: T.gap, carrier: null, unload: T.unload || 0 };
      if (opts && opts.carrier) { const c = groups.find(o => o.id === opts.carrier); g.carrier = c.id; if (c.route.length) g.route = [{ ...c.route[c.route.length - 1] }]; }
      groups.push(g); sel = g; refresh(); setEditing(true); return g;
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
        route: [{ e: g.route[k].e, n: g.route[k].n }], start: 0, land: g.land, water: g.water, gap: g.gap, carrier: null, unload: 0, parent: g.id, splitAt: k };
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
        wrap.append(b, hb); list.appendChild(wrap);
        for (const c of groups.filter(o => o.carrier === g.id || o.parent === g.id)) row(c, depth + 1);
      };
      for (const g of top) row(g, 0);
      updateStatuses();
    }
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
        const swimmers = g.units.every(u => VT[u.type].amph);
        if (!ship && wet > 3 && !swimmers) out.push('Route crosses water: ' + g.units.filter(u => !VT[u.type].amph).map(u => VT[u.type].name).join(', ') + ' cannot swim.');
        const legs = routePath(g, g.route).legs, pr = ks => ks.map(k => (k + 1) + '–' + (k + 2)).join(', ');
        const far = legs.map((l, k) => l.why === 'noroad' ? k : -1).filter(k => k >= 0), thru = legs.map((l, k) => l.cross.length ? k : -1).filter(k => k >= 0);
        if (far.length) out.push(`No road within ${ROAD_REACH} m (points ${pr(far)}): straight line.`);
        if (thru.length) out.push(`Points ${pr(thru)} cross a building (amber): move a point or add one.`);
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
        ${g.parent ? `<p class="hint">Rides at the rear of <b>${esc(parentOf(g).name)}</b> and turns off at its point ${g.splitAt + 1}.</p>`
          : c ? `<p class="hint">Carried by <b>${esc(c.name)}</b>. Drives off after it arrives and unloads.</p>
               <div class="row"><span class="lbl">Delay after unload</span><input id="op-start" style="width:70px" aria-label="Delay after unloading, mm:ss"></div>`
            : `<div class="row"><span class="lbl">Start</span><input id="op-start" style="width:70px" aria-label="Start time, mm:ss"><span class="hint">mm:ss</span></div>`}
        <div class="row"><span class="lbl">Speed km/h</span>
          ${ship ? '' : '<label class="mini">land <input id="op-land" style="width:50px"></label>'}
          <label class="mini">water <input id="op-water" style="width:50px"></label></div>
        <div class="row"><span class="lbl">Spacing m</span><input id="op-gap" style="width:60px" aria-label="Spacing in metres"></div>
        ${ship ? '' : `<div class="row"><span class="lbl">Roads</span><button id="op-roads" aria-pressed="${g.roads !== false}">Follow roads</button><span class="hint">${g.roads !== false ? 'between your points' : 'straight lines'}</span></div>`}
        ${ship ? `<div class="row"><span class="lbl">Unload s</span><input id="op-unload" style="width:60px" aria-label="Unloading time in seconds"></div>` : ''}
        <div class="row"><span class="lbl">Route</span><button id="op-edit" aria-pressed="${editing}">${editing ? 'Done' : 'Edit route'}</button><button id="op-clear">Clear route</button></div>
        <p class="msg ${editing ? 'arm' : ''}" id="op-msg"></p>
        ${g.join ? `<div class="row"><span class="hint">Rejoins <b>${esc((groups.find(o => o.id === g.join.group) || {}).name || '?')}</b> at its point ${g.join.at + 1}, then follows its route.</span><button id="op-unjoin">Unjoin</button></div>`
          : editing && g.route.length >= 1 && groups.some(o => canJoin(g, o)) ? `<div class="row"><button id="op-join" aria-pressed="${joinPick}">${joinPick ? 'Cancel rejoin' : 'Rejoin a route'}</button><span class="hint">${joinPick ? 'Click a blue point on the route to rejoin.' : 'snap the end onto another route'}</span></div>` : ''}
        ${editing && selPt >= 0 && selPt < g.route.length ? `<div class="ptrow">
            ${selPt < g.route.length - 1 || g.join ? `<div class="row"><span class="lbl">Point ${selPt + 1} hold</span><input id="op-hold" style="width:70px" aria-label="Hold at this point, mm:ss"><span class="hint">mm:ss, 0 for none</span></div>` : `<div class="row"><span class="lbl">Point ${selPt + 1}</span><span class="hint">end of route</span></div>`}
            <div class="row"><button id="op-split">Split here</button><span class="hint">${branchesOf(g).filter(b => b.splitAt === selPt).map(b => esc(b.name)).join(', ') || 'rear vehicles take a new road'}</span></div></div>` : ''}
        ${!editing && g.route.some((p, k) => +p.hold > 0 && k < g.route.length - 1) ? `<p class="hint">Holds: ${g.route.map((p, k) => +p.hold > 0 && k < g.route.length - 1 ? 'point ' + (k + 1) + ' for ' + fmt(p.hold).slice(2) : '').filter(Boolean).join(', ')}.</p>` : ''}
        ${ship ? `<div class="row"><span class="lbl">Cargo</span><button id="op-cargo">+ Cargo group</button></div>
                  <p class="hint">${kids.length ? 'Carrying ' + kids.map(k => esc(k.name)).join(', ') + '.' : 'Nothing aboard yet.'}</p>` : ''}
        <div class="row"><button id="op-del" class="fire-btn">Delete group</button></div>`;
      $('op-name').value = g.name;
      $('op-name').addEventListener('change', e => { g.name = e.target.value.trim() || g.name; refresh(); });
      const ub = $('op-units');
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
      if ($('op-land')) { $('op-land').value = g.land; $('op-land').addEventListener('change', e => { g.land = Math.max(1, +e.target.value || g.land); refresh(); }); }
      $('op-water').value = g.water; $('op-water').addEventListener('change', e => { g.water = Math.max(0, +e.target.value || 0); refresh(); });
      if ($('op-roads')) $('op-roads').addEventListener('click', () => { g.roads = g.roads === false; refresh(); });
      $('op-gap').value = g.gap; $('op-gap').addEventListener('change', e => { g.gap = Math.max(5, +e.target.value || g.gap); refresh(); });
      if ($('op-unload')) { $('op-unload').value = g.unload; $('op-unload').addEventListener('change', e => { g.unload = Math.max(0, +e.target.value || 0); refresh(); }); }
      if ($('op-hold')) { const p = g.route[selPt]; $('op-hold').value = fmt(+p.hold || 0).slice(2);
        $('op-hold').addEventListener('change', e => { const v = parseT(e.target.value); if (v === null) { e.target.value = fmt(+p.hold || 0).slice(2); return; }
          if (v > 0) p.hold = v; else delete p.hold; refresh(); }); }
      if ($('op-split')) $('op-split').addEventListener('click', () => splitHere(g, selPt));
      if ($('op-join')) $('op-join').addEventListener('click', () => { joinPick = !joinPick; rebuildLines(); renderEditor(); });
      if ($('op-unjoin')) $('op-unjoin').addEventListener('click', () => unjoin(g));
      $('op-edit').addEventListener('click', () => setEditing(!editing));
      $('op-clear').addEventListener('click', () => {
        for (const b of branchesOf(g)) detach(b);
        for (const o of groups) if (o.join && o.join.group === g.id) delete o.join;
        delete g.join;
        g.route = g.parent ? g.route.slice(0, 1) : c && c.route.length ? [{ ...c.route[c.route.length - 1] }] : []; refresh(); setEditing(true); });
      if ($('op-cargo')) $('op-cargo').addEventListener('click', () => newGroup({ type: 'fuel', carrier: g.id, name: g.name + ' cargo ' + (kids.length + 1) }));
      $('op-del').addEventListener('click', e => { if (e.target.dataset.armed) removeGroup(g); else { e.target.dataset.armed = '1'; e.target.textContent = 'Confirm delete'; } });
      const w = warnings(g), m = $('op-msg');
      const n0 = note; note = '';
      m.textContent = (n0 ? n0 + ' ' : '') + (editing ? (joinPick ? 'Pick the point where this group rejoins: click a blue square. Esc cancels.' : 'Click the map to add points. Click a square to select it (white): set a hold or split there; drag it to move. Drag a faint square to add a bend. Red squares belong to the rest of the split: click one to edit that group. Delete removes the white point. Enter or Done to finish.') + (w.length ? ' ' + w.filter(x => !/Click on the map/.test(x)).join(' ') : '')
                              : w.join(' ') || (g.prof ? `Route ${(g.prof.len / 1000).toFixed(1)} km, about ${Math.round(g.prof.dur / 60)} min for the lead.` : ''));
      if (n0 || (!editing && w.length)) m.className = 'msg bad';
    }
    const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    $('op-new').addEventListener('click', () => newGroup({ type: $('op-newtype').value }));
    $('op-newtype').innerHTML = [...LAND, ...SHIPS].map(k => `<option value="${k}">${VT[k].name}${VT[k].ship ? ' (ship)' : ''}</option>`).join('');
    $('op-clearall').addEventListener('click', e => {
      if (!e.target.dataset.armed) { e.target.dataset.armed = '1'; e.target.textContent = 'Confirm: remove all'; return; }
      groups = []; sel = null; editing = false; delete e.target.dataset.armed; e.target.textContent = 'Remove all'; refresh();
    });

    load(); refresh();
    return { tick, onExaggeration: rebuildLines, debug: { models: tmpl, view, lines, handles, set showEnemy(v) { showEnemy = !!v; }, set showRoutes(v) { showRoutes = !!v; }, get groups() { return groups; }, VT, waterAt, toLocal, splitHere, resolve, offsetOf, doJoin, unjoin, fullRoute, get joinPick() { return joinPick; }, halt, resume, isHalted, moveTime, struck, strike, vehiclesAt, vName, struckAt, fxRules: { PUFFS, PUFF_LIFE, BURN_FULL, WIND_FROM }, routePath, pathEN: g => routePath(g, fullRoute(g)).pts.map(p => ({ e: CE + p.x, n: CN - p.z })), roadRules: { ROAD_W, ROAD_REACH }, realTimeAt, newGroup, refresh, sAt, posAt, startOf, status, select(g) { sel = g; renderList(); renderEditor(); }, setEditing } };
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
    const CLASS = { zbd: 'armor', ztd: 'armor', plz: 'armor', eng: 'eng', fuel: 'soft' };   // ships (LCU, RoRo) absent = immune
    const R = {
      m777:        { soft: 35, eng: 15, armor: 10 },             // = sim M109 155 mm
      m119:        { soft: 25, eng: 10, armor: 6 },              // = sim M101 105 mm
      m120:        { soft: 25, eng: 10, armor: 6 },              // guess: like 105
      m252:        { soft: 15, eng: 5,  armor: 3 },              // guess
      altius_600m: { soft: 10, eng: 3,  armor: 2 },              // guesses from here down
      altius_700m: { soft: 15, eng: 5,  armor: 4 },
      switchblade: { soft: 12, eng: 4,  armor: 3 },
      lucas:       { soft: 30, eng: 12, armor: 8 }
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
    function burstAt(id, mun, x, z, t) {
      const O = OPFOR.debug, out = { hits: [], near: null }, wetB = O.waterAt(x, z);
      for (const v of O.vehiclesAt(t)) {
        const d = Math.hypot(v.x - x, v.z - z);
        if (!out.near || d < out.near.d) out.near = { v, d };
        if (v.struck || d > 320) continue;
        let p = pStrike(mun, v.type, d);
        if (p > 0 && TUBES[mun] && (wetB || O.waterAt(v.x, v.z))) p = 0;
        if (p > 0 && u01(id + '|' + v.key) < p && O.strike(v.g, v.i, t, id)) out.hits.push({ v, d, p });
      }
      return out;
    }
    // artillery: every round that lands
    FIRES.onImpact((imp, m, k) => {
      const p = toLocal(imp.e, imp.n), r = burstAt('M' + m.id + '|' + k, m.u.type, p.x, p.z, imp.t);
      for (const h of r.hits) { m.struck = (m.struck || 0) + 1; FIRES.log(`M${m.id} STRUCK ${OPFOR.debug.vName(h.v.g, h.v.i)} (${Math.round(h.d)} m)`); }
    });
    // UAS: aim point plus a little keyed guidance scatter
    function uasImpact(id, type, x, z, t) {
      const g = k => { const u = Math.max(1e-9, u01(id + '|' + k)), w = u01(id + '|' + k + 'b'); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); };
      const px = x + g('mx') * UAS_MISS, pz = z + g('mz') * UAS_MISS;
      return Object.assign(burstAt(id, type, px, pz, t), { x: px, z: pz });
    }
    return { burstAt, uasImpact, pStrike, R, PDH, CLASS, UAS_MISS };
  })();
  window.__damage = DAMAGE;

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
        if (y <= gy(x, z)) {
          let lo = prev, hi = t;
          for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (o.y + d.y * mid <= gy(o.x + d.x * mid, o.z + d.z * mid)) hi = mid; else lo = mid; }
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
      const lp = { id: nextId++, fam, name: name || (FAMS[fam] + (n > 1 ? ' ' + n : '')), x, z };
      lp.sprite = sprite(lp.name, true); lp.sprite.position.set(x, gy(x, z) + 40, z);
      lps.push(lp); FIRES.log('Placed ' + lp.name + ' launch point at ' + gridAt(x, z) + (onMap(x, z) ? '' : ' (off the map)')); draw(); return lp;
    }
    // Scenario file (Lee's KML v1.2 converted): { lps: [{ fam, name, e, n }] } (an old rounds field is ignored)
    fetch('data/uas.json').then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !Array.isArray(j.lps)) return;
      for (const l of j.lps) if (FAMS[l.fam]) { const p = toLocal(l.e, l.n); addLP(l.fam, p.x, p.z, l.name); }
    }).catch(() => {});

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
      return out.sort((a, b) => a.dd - b.dd);
    }
    function impact(d, p) {
      const r = DAMAGE.uasImpact('U' + d.id, d.type, p.x, p.z, simT());
      FIRES.blast(CE + r.x, CN - r.z, TYPES[d.type].burst);
      const O = OPFOR.debug, nm = v => O.vName(v.g, v.i);
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
      if (!TYPES[d.type].recover || d.state !== 'fly') return;
      setTask(d, { kind: 'recover' }); FIRES.log(d.name + ' returning to ' + d.lp.name + ' for recovery');
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
        if (c.trk && c.trk.parent && c.trk.visible) { c.trk.getWorldPosition(tv); c.last = { x: tv.x, z: tv.z }; return tv.clone().setY(tv.y + 1); }
        c.mode = 'stare'; if (c.last) { c.sx = c.last.x; c.sz = c.last.z; } note(d, 'Track lost.');
      }
      if (c.mode === 'stare') {
        const s = c.slew;                   // prepoint: swing smoothly from the old point to the new one, then hold it
        if (s && s.tx === c.sx && s.tz === c.sz) {
          const u = Math.min(1, (performance.now() - s.t0) / s.dur), k = u * u * (3 - 2 * u);
          if (u < 1) { const x = s.fx + (c.sx - s.fx) * k, z = s.fz + (c.sz - s.fz) * k; return new THREE.Vector3(x, gy(x, z), z); }
          c.slew = null;
        }
        return new THREE.Vector3(c.sx, gy(c.sx, c.sz), c.sz);
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
        if (!d.feed || !K || !K.size || d.state !== 'fly') continue;
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
      while (dt > 1e-6) { const h = Math.min(0.25, dt); for (const d of drones) step(d, h); dt -= h; }
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
      const list = [groups.grid, groups.sketch, ui, FIRES.debug.unitGroup, FIRES.debug.arcGroup, OPFOR.debug.lines, OPFOR.debug.handles];
      if (on) { keep.length = 0; for (const o of list) { keep.push(o.visible); o.visible = false; }
        for (const [, g] of OPFOR.debug.view.g) { keep.push(g.sym.visible); g.sym.visible = false; } }
      else { let i = 0; for (const o of list) o.visible = keep[i++]; for (const [, g] of OPFOR.debug.view.g) g.sym.visible = keep[i++]; }
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
    </style></head><body><div id="wrap">
      <div style="position:relative;flex:1 1 auto;min-height:0;display:flex"><canvas id="fv" width="${FEED_W}" height="${FEED_H}"></canvas>
      <div id="hud"><span><b>UAS</b><span id="h-name"></span></span><span><b>MODE</b><span id="h-mode"></span></span><span><b>POS</b><span id="h-pos"></span></span><span><b>ALT</b><span id="h-alt"></span></span>
      <span><b>SPI</b><span id="h-spi"></span></span><span><b>RNG</b><span id="h-rng"></span></span><span><b>FOV</b><span id="h-fov"></span></span>
      <span><b>END</b><span id="h-end"></span></span><span id="h-t"></span></div></div>
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
      const zoom = f => { d.cam.fov *= f; updateCam(d); };
      let drag = null;
      cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: false }; try { cv.setPointerCapture(e.pointerId); } catch (err) {} });
      cv.addEventListener('pointermove', e => {
        if (!drag || d.state !== 'fly') return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return; drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
        const k = d.cam.fov * Math.PI / 180 / cv.getBoundingClientRect().height;
        slewBy(d, dx * k, dy * k);           // the picture follows the hand on both axes (sideways used to run backwards)
      });
      cv.addEventListener('pointerup', e => {
        const was = drag; drag = null; if (!was || was.moved || d.state !== 'fly') return;
        const [nx, ny] = ndc(e); updateCam(d); const p = groundThrough(d, nx, ny); if (!p) return note(d, 'No ground there.');
        if (e.shiftKey) {
          const v = vehiclesNear(p.x, p.z, 40)[0];
          if (v) { d.cam.mode = 'track'; d.cam.trk = v.m; d.cam.last = { x: p.x, z: p.z }; note(d, 'Tracking.'); return; }
          note(d, 'No vehicle there to track; staring at the point instead.');
        }
        d.cam.mode = 'stare'; d.cam.sx = p.x; d.cam.sz = p.z; d.cam.trk = null;
      });
      cv.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
      const B = id => doc.getElementById(id);
      B('m-scan').addEventListener('click', () => { d.cam.mode = 'scan'; d.cam.trk = null; });
      B('m-stare').addEventListener('click', () => { if (d.spi) { d.cam.mode = 'stare'; d.cam.sx = d.spi.x; d.cam.sz = d.spi.z; d.cam.trk = null; } });
      B('m-track').addEventListener('click', () => note(d, 'Shift-click a vehicle in the video to track it.'));
      B('z-in').addEventListener('click', () => zoom(1 / 1.5));
      B('z-out').addEventListener('click', () => zoom(1.5));
      B('f-orbit').addEventListener('click', () => { if (d.spi && d.state === 'fly' && d.task.kind !== 'strike') { setTask(d, { kind: 'orbit', cx: d.spi.x, cz: d.spi.z, r: d.task.r || TYPES[d.type].r }); note(d, 'Orbit moved to ' + gridAt(d.spi.x, d.spi.z) + '.'); } });
      B('f-mark').addEventListener('click', () => { if (!d.spi) return; addMark(d, d.spi.x, d.spi.z, B('f-note').value.trim()); B('f-note').value = ''; note(d, 'Marked ' + gridAt(d.spi.x, d.spi.z) + '.'); });
      if (B('f-strike')) B('f-strike').addEventListener('click', e => {
        if (!d.armedStrike) { if (d.cam.mode !== 'stare' && d.cam.mode !== 'track') return note(d, 'Stare at a point or track a vehicle first.'); d.armedStrike = performance.now() + 5000; e.target.textContent = 'Confirm strike'; e.target.classList.add('armed'); return; }
        d.armedStrike = 0; e.target.textContent = 'Strike'; e.target.classList.remove('armed'); commitStrike(d);
      });
      if (B('f-abort')) B('f-abort').addEventListener('click', () => waveOff(d));
      if (B('f-recover')) B('f-recover').addEventListener('click', () => recover(d));
      // prepoint (Altius): type a grid, the camera slews there (about 60 deg/s) and stares at it
      const prepoint = () => {
        if (d.state !== 'fly') return note(d, 'The drone is not flying.');
        const g = FIRES.debug.parseGrid(B('f-pp').value); if (g.err) return note(d, g.err);
        const p = toLocal(g.e, g.n); if (!onMap(p.x, p.z)) return note(d, 'That grid is off the map.');
        const c = d.cam; updateCam(d);
        const f = d.spi || new THREE.Vector3(c.sx, gy(c.sx, c.sz), c.sz), o = d.cam3.position;
        const ang = f.clone().sub(o).angleTo(new THREE.Vector3(p.x, gy(p.x, p.z), p.z).sub(o));
        c.mode = 'stare'; c.trk = null; c.sx = p.x; c.sz = p.z;
        c.slew = { fx: f.x, fz: f.z, tx: p.x, tz: p.z, t0: performance.now(), dur: clamp(ang / (Math.PI / 3) * 1000, 300, 2000) };
        const tg = new THREE.Vector3(p.x, gy(p.x, p.z), p.z), dir = tg.clone().sub(o), L = dir.length(), hit = rayGround(o, dir.normalize());
        note(d, 'Prepoint ' + gridAt(p.x, p.z) + (hit && hit.distanceTo(o) < L - 30 ? ' — masked by terrain from here; the SPI shows the near slope.' : '.'));
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
    function addMark(d, x, z, text) {
      const mk = { id: nextId++, t: simT(), x, z, grid: gridAt(x, z), by: d ? d.name : 'Map', note: text || '' };
      const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.strokeStyle = '#ffd25a'; g.lineWidth = 7;
      g.beginPath(); g.moveTo(12, 12); g.lineTo(52, 52); g.moveTo(52, 12); g.lineTo(12, 52); g.stroke();
      mk.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true, sizeAttenuation: false }));
      mk.sprite.scale.set(0.03, 0.03, 1); mk.sprite.renderOrder = 13; mk.sprite.position.set(x, gy(x, z) + 10, z); ui.add(mk.sprite);
      marks.unshift(mk); FIRES.log('MARK ' + mk.grid + ' (' + mk.by + ')' + (mk.note ? ': ' + mk.note : '')); draw();
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
            const p = toLocal(g.e, g.n); if (!onMap(p.x, p.z)) return msg('uas-lmsg', 'Target must be on the map.', 'bad');
            lp.draft = null; msg('uas-lmsg', ''); launch(lp, 'lucas', p);
          }));
        } else for (const k of famTypes(lp.fam)) bar.appendChild(btn((famTypes(lp.fam).length > 1 ? TYPES[k].short : 'Launch'), 'Launch one ' + TYPES[k].label + '; it orbits over the launch point until tasked', () => launch(lp, k)));
        bar.appendChild(btn('Remove', '', () => { dropObj(lp.sprite); lps.splice(lps.indexOf(lp), 1); FIRES.log('Removed ' + lp.name); draw(); }));
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
        if (d.state === 'fly' && !T.gps && k.kind !== 'strike') {
          bar.appendChild(btn('Orbit', 'Click the map: orbit there', () => { armed = { kind: 'orbit', d }; msg('uas-dmsg', 'Click the map where ' + d.name + ' should orbit. Esc cancels.', 'arm'); }));
          bar.appendChild(btn('Route', 'Click the map for each waypoint; Enter or Done to finish', () => { armed = { kind: 'route', d }; routeDraft = []; msg('uas-dmsg', 'Click waypoints for ' + d.name + ', then press Done or Enter. Esc cancels.', 'arm'); draw(); }));
          if (armed && armed.kind === 'route' && armed.d === d) bar.appendChild(btn('Done', '', finishRoute));
          bar.appendChild(sel('Height above ground', [500, 1000, 2000, 3000, 5000, 8000], ft(d.alt), v => { d.alt = v * FT; drawTask(d); draw(); }, v => v.toLocaleString('en-US') + ' ft'));
          if (k.kind === 'orbit') bar.appendChild(sel('Orbit radius', [250, 400, 700, 1000, 1500, 2500], k.r, v => { k.r = v; drawTask(d); }, v => 'r ' + v));
          if (T.recover && k.kind !== 'recover') bar.appendChild(btn('Recover', 'Fly back to the launch point and land', () => recover(d)));
        }
        if (d.state === 'fly' && T.waveoff && k.kind === 'strike') bar.appendChild(btn('Wave off', 'Pull out of the dive', () => waveOff(d)));
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
          btn('×', 'Delete this mark', () => { dropObj(mk.sprite); marks.splice(marks.indexOf(mk), 1); draw(); }));
        M.appendChild(row);
      }
    }
    let draftLine = null;
    function finishRoute() {
      if (!armed || armed.kind !== 'route') return;
      const d = armed.d; armed = null;
      if (routeDraft && routeDraft.length) setTask(d, { kind: 'route', pts: routeDraft, i: 0 });
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
      else if (armed.kind === 'orbit') { const d = armed.d; armed = null; setTask(d, { kind: 'orbit', cx: p.x, cz: p.z, r: d.task.r || TYPES[d.type].r }); msg('uas-dmsg', d.name + ' orbiting ' + gridAt(p.x, p.z) + '.'); }
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
    return { tick, renderFeeds, debug: { TYPES, CAM, lps, drones, marks, addLP, launch, setTask, openFeed, commitStrike, waveOff, recover, addMark, eta, models: tmpl, updateCam, groundThrough } };
  })();
  window.__uas = UAS.debug;


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
    const save = () => { try { const o = {}; for (const w of wins) o[w.id] = { x: w.offsetLeft, y: w.offsetTop, open: !w.hidden }; localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} };
    let z = 10;
    const tbH = () => topbar.offsetHeight;
    function defaults(w) {
      const W = innerWidth, gap = 16, top = tbH() + 12;
      if (W < 700) return { x: gap, y: top, open: w.id === 'w-ops' };
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
      const CLS = { soft: 'Soft (fuel truck)', eng: 'Engineering', armor: 'Armour (ZBD, ZTD, PLZ)' }, cls = Object.keys(CLS);
      const MUN = Object.keys(D.R), munName = k => FT[k] ? FT[k].short : UT[k].label, src = k => k === 'm777' || k === 'm119' ? 'Fire Mission Sim' : PH;
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
          'Buildings do not stop rounds or drones yet.'])}
        <h4>R and Pdh</h4>
        ${tbl(['Munition', ...cls.map(c => CLS[c] + '<br>R m · Pdh'), 'Source'],
          MUN.map(k => [munName(k), ...cls.map(c => { const r = D.R[k][c], p = D.PDH[k] && typeof D.PDH[k][c] === 'number' ? D.PDH[k][c] : 1; return r + ' · ' + (p === 1 ? '1' : p.toFixed(2)); }), src(k)]), 'num')}
        <h4>Chance one burst strikes, by miss distance (%)</h4>
        ${tbl(['Munition', 'Class', ...MISS.map(m => m + ' m')],
          MUN.flatMap(k => cls.map((c, j) => [j ? '' : munName(k), CLS[c].split(' ')[0], ...MISS.map(m => pct(D.pStrike(k, c === 'soft' ? 'fuel' : c === 'eng' ? 'eng' : 'zbd', m)))])), 'num')}`]);

      sec.push(['arty', 'Artillery', `
        ${tbl(['Unit', 'Tubes', 'Rounds', 'Range m', 'Angle', 'ToF s', 'Volley every', 'Sheaf m', 'Range σ m', 'Deflection σ m'],
          Object.values(FT).map(t => [t.label, t.tubes, t.rounds, t.min + '–' + t.max, t.angle, f(t.tof), t.interval + ' s', t.sheaf, f(t.sR), f(t.sD)]), 'num')}
        ${list([
          'R = range gun to target, m. All unit figures are unclassified placeholders ' + PH + '.',
          'Parallel sheaf: tubes spread evenly across the gun-target line over the sheaf width, then gaussian scatter (σ above) in range and deflection.',
          'Each round lands up to 1.5 s after its volley time (random, keyed per mission).',
          'Rounds per tube chosen per mission; the unit\'s round count goes down by rounds × tubes.',
          'Off-map firing units allowed. Trajectories are drawn for the eye, not ballistic. No terrain or building masking of the arc yet.',
          'Adjust fire, fuzes, shell types and mean-point-of-impact error not modelled yet.'])}`]);

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
          'Flight is automatic (orbit, route, scan); no manual flying. No drone-to-drone handoff.'])}`]);

      sec.push(['opfor', 'Enemy vehicles', `
        ${tbl(['Type', 'L × W × H m', 'Land', 'Water', 'Gap', 'Damage class', 'Notes'],
          Object.entries(VT).map(([k, t]) => [t.name, t.L + ' × ' + t.W + ' × ' + t.H, t.land ? t.land + ' km/h' : '—', t.water ? t.water + ' km/h' : '—', t.gap + ' m',
            D.CLASS[k] ? CLS[D.CLASS[k]].split(' ')[0] : 'cannot be struck',
            [t.amph ? 'amphibious' : '', t.ship ? 'draft ' + t.draft + ' m, unloads in ' + mmss(t.unload) : ''].filter(Boolean).join(', ') || '—']), 'num')}
        ${list([
          'Sizes and speeds are approximate public figures ' + PH + '; speed and gap are set per group in the editor.',
          'Water = no terrain data or ground below 0.3 m.',
          'Swimming amphibians ride low (0.6 × height under water).',
          'Movement is a fixed function of the clock: column in file at the set gap, scripted holds, instructor halt/resume.',
          'No vehicle-to-vehicle avoidance. Struck vehicles do not block the road.'])}
        <h4>Routes and roads</h4>
        ${tbl(['Rule', 'Value'], [
          ['Follow roads', 'on by default for land groups; shortest road path between each pair of clicked points'],
          ['Road preference', 'cost per metre × ' + OPFOR.debug.roadRules.ROAD_W.join(' / ') + ' (major / mid / minor road) — ' + PH],
          ['Snap reach', 'a clicked point joins the nearest road by a straight link if one is within ' + OPFOR.debug.roadRules.ROAD_REACH + ' m'],
          ['Straight legs', 'ships; Follow roads off; either end in the water (landings, swims); no road within reach'],
          ['Buildings', 'straight legs and links through a building footprint are flagged amber in the editor, not prevented'],
          ['Road data', 'OpenStreetMap drivable roads; no one-way streets, lanes, width or traffic'],
          ['Column behind its start point', 'lined up straight back from the first stretch of road']])}`]);

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
          ['OP inside a building', 'observer stands on the roof']])}`]);

      body.innerHTML = '<nav class="rnav">' + sec.map(s => `<a href="#r-${s[0]}">${s[1]}</a>`).join('') + '</nav>' +
        sec.map(s => `<section id="r-${s[0]}"><h3>${s[1]}</h3>${s[2]}</section>`).join('');
      for (const a of body.querySelectorAll('.rnav a')) a.addEventListener('click', e => { e.preventDefault(); body.querySelector(a.getAttribute('href')).scrollIntoView({ block: 'start' }); });
    }
    function open(on) { if (on) build(); dlg.hidden = !on; btn.setAttribute('aria-expanded', String(on)); if (on) document.getElementById('rules-x').focus(); else btn.focus(); }
    btn.addEventListener('click', () => open(dlg.hidden));
    document.getElementById('rules-x').addEventListener('click', () => open(false));
    dlg.addEventListener('click', e => { if (e.target === dlg) open(false); });
    addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.hidden) { e.stopPropagation(); open(false); } }, true);
    window.__rules = { open };
  })();

  // ---- render loop with label projection
  const v = new THREE.Vector3();
  document.getElementById('loading').hidden = true;
  let lastT = performance.now();
  (function loop(now) {
    now = now || performance.now(); const dt = Math.min(0.25, (now - lastT) / 1000); lastT = now;
    FIRES.tick(dt);
    OPFOR.tick();
    UAS.tick();
    if (!obs) { navTick(dt); controls.update(); } reticleTick(); sky.position.copy(camera.position); WATER.time.value = now / 1000; UAS.renderFeeds(); renderer.render(scene, camera);
    if (!labelBox.hidden) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      for (const t of tags) {
        v.copy(t.v).project(camera);
        const show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        t.d.style.display = show ? '' : 'none';
        if (show) { t.d.style.left = ((v.x + 1) / 2 * w) + 'px'; t.d.style.top = ((1 - v.y) / 2 * h) + 'px'; }
      }
    }
    requestAnimationFrame(loop);
  })();
})().catch(err => { const l = document.getElementById('loading'); l.hidden = false; l.textContent = 'The terrain could not load in this browser: ' + err.message; });
