/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   Fire Mission Sim — POV camera calibration. v2, 2026-09-19.

   DATA ONLY. No logic.

   Solved from 139 constraints spanning three height surfaces, 0 to 80 m:
   111 markers written into fireslab-calibration-targets-v3.kml and detected by
   colour, plus the bottom edge of each sea-level billboard, which sits at
   exactly 0 m. Residual 1.46 px RMS, max 7.8 px. Ground error, back-projecting
   each constraint, median 0.7 m under 1500 m and 3.3 m beyond 2500 m.

   Work all geometry in ECEF with a local ENU basis. Do NOT use UTM as the
   projection frame: Earth's heading is a true azimuth, and grid convergence
   here is -0.87 deg.

   ---------------------------------------------------------
   THE TRAP THAT COST v1 A 250 m ERROR — do not undo this.

   `view.target.alt_m` is NOT a free parameter, and must never be fitted.

   A common vertical translation of the camera and the entire scene is exactly
   unobservable: every marker moves with it, so the residual is bit-identical
   across at least +-60 m of it. No arrangement of markers can break that, and
   more height surfaces do not help — it was measured, at 0-80 m, and the
   residual stayed flat to three decimals while ground points moved ~100 m.

   v1 hid the problem by fitting only the intrinsics against markers that were
   all at one altitude, reaching 2.65 px at 80 m while being ~250 m long at
   ground level. Letting the attitude AND the target altitude float instead
   just lets the fit roam that degenerate direction: it wandered to a target
   altitude of 86 m and a tilt of 71.4 deg, fitting equally well and predicting
   ground positions ~100 m away.

   The fix is to hold the target altitude at the value Google Earth states in
   its own URL, which is the same datum the KML altitudes are in, and fit the
   rest. That is what these numbers are.
   ---------------------------------------------------------

   CROSS-CHECK, independent of the fit: Earth's status bar read "Camera: 788 m"
   for this view. The derived camera lands at 784.8 m, 3.2 m off it. That is a
   check, not an input — it is in the same datum as everything else, so it
   cannot be used to pin the vertical.
   ========================================================= */

const SIM_CAMERA = {
  frame: { file: 'img/sim-pov.jpg', width: 1860, height: 707 },

  /* Google Earth web view this frame was captured from. `target.alt_m`,
     `heading_deg` and `tilt_deg` below are the FITTED values; the URL's own
     figures are in `captured_from`. Only target.alt_m is held fixed. */
  view: {
    url: 'earth.google.com/web/@18.08674006,-65.79801894,5.34986202a,' +
         '2222.44382011d,30.00000003y,124.26773779h,69.39438738t,0r',
    target: { lat: 18.08674006, lon: -65.79801894, alt_m: 5.34986202 },
    distance_m: 2218.32028,      /* fitted; URL said 2222.44382 */
    heading_deg: 124.14387,      /* fitted; URL said 124.26774. True azimuth. */
    tilt_deg:     69.43845,      /* fitted; URL said  69.39439. 0 = straight down. */
    roll_deg:      0
  },

  /* exactly what Earth's URL stated, before fitting */
  captured_from: { distance_m: 2222.44382011, fov_deg: 30.00000003,
                   heading_deg: 124.26773779, tilt_deg: 69.39438738,
                   status_bar_camera_m: 788 },

  /* derived from the view above, not fitted directly */
  camera: { lat: 18.09727069, lon: -65.81425732, alt_m: 784.79 },

  /* pinhole, in pixels of the frame above.
     The initial focal came from the FOV: a 30 deg vertical field over the
     1014 px Earth canvas gives 1892 px, and the fit moved it 24 px. The same
     derivation reproduced v1's solved focal to 0.1%, so it is a good prior. */
  intrinsics: { focal_px: 1867.66292, cx: 901.25010, cy: 369.62960 },

  /* provenance: a crop of the full browser screenshot, no retouching.
     The clean frame and the marker frame are the same capture, shot seconds
     apart with the KML hidden between them — Earth paints its UI onto the same
     canvas, so hiding a project does not move the 3D view. */
  crop: { from: '1918x1198 screenshot', x0: 58, y0: 260, x1: 1918, y1: 967,
          excluded: 'search bar above, side tab at the left edge, minimap and controls below',
          /* The top edge was lowered from 390 to 320 on request, for more sea.
             Moving the TOP edge is cheap and exact: it shifts cy by the number
             of rows added and shifts every observed_px in the fixture by the
             same amount. Nothing is re-solved and the residual is unchanged.
             Moving the BOTTOM edge is cheaper still — it changes nothing but
             frame.height and the CSS aspect ratio. It is only the camera's own
             parameters that must never be re-fitted casually. */
          note: 'top lowered 390 -> 320 -> 260, cy shifted +130 in total, no refit' },

  /* slant range to sea level down the centre column, at rows 0, h/3, h/2, h */
  coverage_m: { top_edge: 4823, upper_third: 2769, centre: 2286, bottom_edge: 1532 },

  /* median ground error by slant range, measured by back-projecting every
     constraint and comparing to its known position */
  accuracy_m: { '0-1500': 0.71, '1500-2000': 1.59, '2000-2500': 2.79, '2500+': 3.30 }
};
