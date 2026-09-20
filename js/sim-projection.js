/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   Fire Mission Sim — grid <-> screen projection.

   Pure functions. No DOM, no canvas, no state. Everything the sim draws on
   the feed, and everything it scores, goes through here.

   Reads the calibration constants from js/sim-camera.js (SIM_CAMERA), which
   were solved on 2026-09-19 against 50 markers of known 3D position rendered
   by Google Earth. Residual 2.65 px RMS, max 5.3 px. Enforced by section 28
   of test-runtime.js against sim-calibration-fixture.json.

   ---------------------------------------------------------
   THE ONE TRAP. Google Earth's heading is a TRUE azimuth. UTM grid north is
   not true north: grid convergence here is about -0.87 deg. Doing the
   projection in UTM rotates the whole camera by that much and costs roughly
   a factor of five in accuracy. So every rotation below happens in ECEF with
   a local ENU basis. UTM and MGRS exist only at the edges, because that is
   what a human says on the radio.
   ---------------------------------------------------------

   API (all angles in degrees, all distances in metres):

     worldToScreen(e, n, elevation)   -> {x, y, range, inFront, inFrame} | null
     screenToWorld(x, y, elevation)   -> {e, n, range} | null
     groundScaleAt(x, y, elevation)   -> {across, into, range} metres per pixel
     mgrsToUtm('20Q KF 03954 01805')  -> {e, n, zone, band, square}
     utmToMgrs(e, n, digits)          -> '20Q KF 03954 01805'

   worldToScreen takes a point and says where it draws. screenToWorld takes a
   pixel and says what is under it — but a pixel is a ray, not a point, so it
   cannot answer without being told how high the ground is there. Sea level
   and the coastal plain are fine at 0. The hillside is not: see the note on
   elevation at the foot of this file.
   ========================================================= */

const SIM_PROJ = (() => {

  /* ---------- WGS84 ---------- */
  const A = 6378137.0, F = 1 / 298.257223563;
  const E2 = F * (2 - F);
  const B = A * (1 - F);
  const EP2 = (A * A - B * B) / (B * B);
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

  function geodeticToEcef(lonDeg, latDeg, alt) {
    const lo = rad(lonDeg), la = rad(latDeg);
    const sLa = Math.sin(la), cLa = Math.cos(la);
    const N = A / Math.sqrt(1 - E2 * sLa * sLa);
    return [(N + alt) * cLa * Math.cos(lo),
            (N + alt) * cLa * Math.sin(lo),
            (N * (1 - E2) + alt) * sLa];
  }

  /* Bowring's closed form. Good to well under a millimetre at these altitudes. */
  function ecefToGeodetic(p) {
    const [x, y, z] = p;
    const lon = Math.atan2(y, x);
    const r = Math.hypot(x, y);
    const th = Math.atan2(z * A, r * B);
    const lat = Math.atan2(z + EP2 * B * Math.pow(Math.sin(th), 3),
                           r - E2 * A * Math.pow(Math.cos(th), 3));
    const N = A / Math.sqrt(1 - E2 * Math.pow(Math.sin(lat), 2));
    const alt = r / Math.cos(lat) - N;
    return { lon: deg(lon), lat: deg(lat), alt };
  }

  /* East / North / Up unit vectors, expressed in ECEF, at a geodetic point. */
  function enuBasis(lonDeg, latDeg) {
    const lo = rad(lonDeg), la = rad(latDeg);
    return {
      e: [-Math.sin(lo), Math.cos(lo), 0],
      n: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
      u: [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
    };
  }

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const m = Math.hypot(a[0], a[1], a[2]); return [a[0] / m, a[1] / m, a[2] / m]; };

  /* ---------- UTM, zone 20 north (this AO) ---------- */
  const K0 = 0.9996, ZONE = 20, LON0 = (ZONE - 1) * 6 - 180 + 3;   /* -63 deg */

  function latLonToUtm(latDeg, lonDeg) {
    const la = rad(latDeg), dl = rad(lonDeg - LON0);
    const N = A / Math.sqrt(1 - E2 * Math.pow(Math.sin(la), 2));
    const T = Math.pow(Math.tan(la), 2);
    const C = EP2 * Math.pow(Math.cos(la), 2);
    const Aa = Math.cos(la) * dl;
    const M = A * ((1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256) * la
             - (3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 * E2 * E2 / 1024) * Math.sin(2 * la)
             + (15 * E2 * E2 / 256 + 45 * E2 * E2 * E2 / 1024) * Math.sin(4 * la)
             - (35 * E2 * E2 * E2 / 3072) * Math.sin(6 * la));
    const e = K0 * N * (Aa + (1 - T + C) * Math.pow(Aa, 3) / 6
            + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Math.pow(Aa, 5) / 120) + 500000;
    let n = K0 * (M + N * Math.tan(la) * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Math.pow(Aa, 4) / 24
          + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Math.pow(Aa, 6) / 720));
    if (latDeg < 0) n += 10000000;
    return { e, n };
  }

  function utmToLatLon(e, n) {
    const x = e - 500000, y = n;
    const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    const M = y / K0;
    const mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256));
    const p1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu)
             + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
             + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu)
             + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
    const C1 = EP2 * Math.pow(Math.cos(p1), 2);
    const T1 = Math.pow(Math.tan(p1), 2);
    const N1 = A / Math.sqrt(1 - E2 * Math.pow(Math.sin(p1), 2));
    const R1 = A * (1 - E2) / Math.pow(1 - E2 * Math.pow(Math.sin(p1), 2), 1.5);
    const D = x / (N1 * K0);
    const lat = p1 - (N1 * Math.tan(p1) / R1) * (D * D / 2
              - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * Math.pow(D, 4) / 24
              + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
    const lon = rad(LON0) + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6
              + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / Math.cos(p1);
    return { lat: deg(lat), lon: deg(lon) };
  }

  /* ---------- MGRS ----------
     100 km square letters. Column letters cycle A-Z (I and O dropped) in sets
     of three zones; row letters cycle A-V (I and O dropped) and are offset by
     half the alphabet on even zones. Latitude bands are the standard C-X. */
  const COL_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
  const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';
  const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

  const bandFor = lat => BANDS[Math.max(0, Math.min(19, Math.floor((lat + 80) / 8)))];

  function squareFor(zone, e, n) {
    const col = COL_SETS[(zone - 1) % 3][Math.floor(e / 100000) - 1];
    let idx = Math.floor(n / 100000) % 20;
    if (zone % 2 === 0) idx = (idx + 5) % 20;
    return col + ROW_LETTERS[idx];
  }

  function utmToMgrs(e, n, digits) {
    digits = digits || 5;
    const { lat } = utmToLatLon(e, n);
    const sq = squareFor(ZONE, e, n);
    const p = Math.pow(10, 5 - digits);
    const ee = String(Math.floor((e % 100000) / p)).padStart(digits, '0');
    const nn = String(Math.floor((n % 100000) / p)).padStart(digits, '0');
    return `${ZONE}${bandFor(lat)} ${sq} ${ee} ${nn}`;
  }

  function mgrsToUtm(s) {
    const m = String(s).toUpperCase().replace(/\s+/g, '')
                .match(/^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d+)$/);
    if (!m) return null;
    const zone = +m[1], band = m[2], col = m[3], row = m[4], d = m[5];
    if (d.length % 2) return null;
    const half = d.length / 2, p = Math.pow(10, 5 - half);
    const colIdx = COL_SETS[(zone - 1) % 3].indexOf(col);
    if (colIdx < 0) return null;
    let rowIdx = ROW_LETTERS.indexOf(row);
    if (rowIdx < 0) return null;
    if (zone % 2 === 0) rowIdx = (rowIdx - 5 + 20) % 20;
    const e = (colIdx + 1) * 100000 + (+d.slice(0, half)) * p;
    /* Resolve the 2 000 km northing ambiguity against the band's own latitude.
       For band Q that lands in the 2 000 000 m block; the loop keeps it general. */
    const bandLat = (BANDS.indexOf(band) * 8) - 80;
    const approx = latLonToUtm(bandLat + 4, LON0).n;
    let n = rowIdx * 100000 + (+d.slice(half)) * p;
    while (n < approx - 1000000) n += 2000000;
    return { e, n, zone, band, square: col + row };
  }

  /* ---------- the camera ---------- */
  function buildCamera(cam) {
    const v = cam.view, i = cam.intrinsics, fr = cam.frame;
    const T = geodeticToEcef(v.target.lon, v.target.lat, v.target.alt_m);
    const bT = enuBasis(v.target.lon, v.target.lat);
    const t = rad(v.tilt_deg), h = rad(v.heading_deg);
    const fwd = norm(add(add(mul(bT.e, Math.sin(h) * Math.sin(t)),
                             mul(bT.n, Math.cos(h) * Math.sin(t))),
                         mul(bT.u, -Math.cos(t))));
    const C = sub(T, mul(fwd, v.distance_m));
    const g = ecefToGeodetic(C);
    const bC = enuBasis(g.lon, g.lat);
    let right = sub(mul(bC.e, Math.cos(h)), mul(bC.n, Math.sin(h)));
    right = norm(sub(right, mul(fwd, dot(right, fwd))));     /* orthogonalise */
    const up = norm(cross(right, fwd));
    return { C, fwd, right, up, geodetic: g,
             f: i.focal_px, cx: i.cx, cy: i.cy, w: fr.width, h: fr.height };
  }

  const CAM = (typeof SIM_CAMERA !== 'undefined') ? buildCamera(SIM_CAMERA) : null;

  /* ---------- the two that matter ---------- */

  /** Where on the feed does this grid point draw?
   *  e, n: UTM 20N metres. elevation: metres above sea level. */
  function worldToScreen(e, n, elevation) {
    if (!CAM) return null;
    const ll = utmToLatLon(e, n);
    const P = geodeticToEcef(ll.lon, ll.lat, elevation || 0);
    const V = sub(P, CAM.C);
    const z = dot(V, CAM.fwd);
    if (z <= 1) return { x: NaN, y: NaN, range: Math.hypot(V[0], V[1], V[2]), inFront: false, inFrame: false };
    const x = CAM.cx + CAM.f * dot(V, CAM.right) / z;
    const y = CAM.cy - CAM.f * dot(V, CAM.up) / z;
    return { x, y, range: Math.hypot(V[0], V[1], V[2]), inFront: true,
             inFrame: x >= 0 && x <= CAM.w && y >= 0 && y <= CAM.h };
  }

  /** What grid is under this pixel, if the ground there is at `elevation`?
   *  Iterates because the target surface is an ellipsoid, not a plane. */
  function screenToWorld(x, y, elevation) {
    if (!CAM) return null;
    const alt = elevation || 0;
    const d = norm(add(add(mul(CAM.right, x - CAM.cx), mul(CAM.up, CAM.cy - y)), mul(CAM.fwd, CAM.f)));
    /* first guess: intersect the tangent plane at the camera */
    const bC = enuBasis(CAM.geodetic.lon, CAM.geodetic.lat);
    const vert = dot(d, bC.u);
    if (vert >= -1e-9) return null;                       /* at or above the horizon */
    let s = (alt - CAM.geodetic.alt) / vert;
    for (let k = 0; k < 8; k++) {                         /* Newton onto the ellipsoid */
      const P = add(CAM.C, mul(d, s));
      const g = ecefToGeodetic(P);
      const err = g.alt - alt;
      if (Math.abs(err) < 1e-4) break;
      const up = enuBasis(g.lon, g.lat).u;
      const rate = dot(d, up);
      if (Math.abs(rate) < 1e-9) break;
      s -= err / rate;
      if (s <= 0) return null;
    }
    const g = ecefToGeodetic(add(CAM.C, mul(d, s)));
    const u = latLonToUtm(g.lat, g.lon);
    return { e: u.e, n: u.n, range: s };
  }

  /** Metres of ground per pixel at a point on the feed: `across` is left-right,
   *  `into` is along the line of sight. `into` is the big one and the reason
   *  range errors are visually forgiving while deflection errors are not. */
  function groundScaleAt(x, y, elevation) {
    const o = screenToWorld(x, y, elevation);
    if (!o) return null;
    const ax = screenToWorld(x + 1, y, elevation);
    const ay = screenToWorld(x, y + 1, elevation);
    if (!ax || !ay) return null;
    return { across: Math.hypot(ax.e - o.e, ax.n - o.n),
             into:   Math.hypot(ay.e - o.e, ay.n - o.n),
             range: o.range };
  }

  return { worldToScreen, screenToWorld, groundScaleAt,
           mgrsToUtm, utmToMgrs, utmToLatLon, latLonToUtm, camera: CAM };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SIM_PROJ;

/* ---------------------------------------------------------
   ON ELEVATION, because it is the thing that will bite.

   screenToWorld needs to be told how high the ground is. Get it wrong and the
   answer slides along the line of sight by roughly 3 m for every metre of
   height error at mid-field, and about 5.6 m per metre out by the marina.

   Safe at 0: the water, the beach, the golf course, the coastal road — the
   whole 0-8 m plain where the engagement happens.

   NOT safe at 0: the residential switchbacks up the hillside on the right.
   Those are tens of metres up. A vehicle placed there with elevation 0 lands
   over 100 m from where it should be, and it will look wrong.

   So: carry an elevation on every enemy waypoint and every target. Google
   Earth's info popup gives it to 1 m. The automatic route would be a terrain
   height lookup, which we do not have — the KML probe attempt that was meant
   to produce one is written up in the project doc under "what did not work".
   --------------------------------------------------------- */
