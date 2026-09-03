/* The Fires Lab — Copyright (c) 2026 Catherine Lake Creations LLC. All rights reserved.
   Build reference: CLC-RG-7F61363DDFE5 */
/* =========================================================
   The Fires Lab — Operation RIVER GATE situation map
   =========================================================

   WHAT CHANGED
   This module used to draw a schematic sketch of the ground. It now
   draws the enemy laydown on top of an imagery base (img/kordan-map.jpg,
   exported from Kordan Brige.pptx). Terrain is carried by the photograph
   and its grid; this file supplies only the symbols, the badges and the
   focus behaviour.

   WHY THIS IS JAVASCRIPT AND NOT INLINE SVG
   The map appears on five pages. Inlining it would mean five copies to
   keep in step. This module is the single source of truth; each page
   calls D3A_MAP.render() with the markers it wants emphasised.

   WHY THERE IS NO TEXT IN THE SVG
   tools/tag-i18n.js has 'svg' in its SKIP_TAGS, so anything written
   inside the map can never receive a translation key. The map is
   therefore pure geometry: doctrinal symbols (language-neutral by
   design), numbered badges for enemy elements, and lettered badges for
   terrain. Every word lives in the HTML key table beside the map,
   where the tagger handles it like any other content. Do not add
   <text> to this file — it will silently fail to translate. The two
   glyph icons below (the engineer 'E' and the command post 'HQ') are
   drawn as strokes for exactly this reason: they are geometry, not text.

   THREE LOCATION STATES, AND THE DISTINCTION IS THE LESSON.
   The S-2 brief now separates what we have found from what we have not,
   and the map has to carry that or it contradicts the page:
     located ..... solid frame, plotted where it is
     templated ... dashed frame, plotted where we assess he WILL be
     unlocated ... not on the map at all. Drawn in a separate strip
                   beside it (renderUnlocated), so the student can see the
                   element exists without being handed a grid he has not
                   earned. This is what the Detect phase is for.
   Move an element between states by changing its `state` in UNITS. An
   element with state 'unlocated' must have no x / y — the strip lays them
   out itself — and the reverse for the other two.

   THIS MAP SHOWS THE ENEMY, PLUS ONE CONTROL MEASURE — DELIBERATE.
   No friendly symbols and no forward line of own troops. The single
   exception is the restricted fire area around the bridge (badge G): it is the
   commander's restriction, the Deliver phase turns on it, and it has to
   be visible.

   SYMBOLOGY — APP-6 / MIL-STD-2525, as drawn in the source deck
   Every element is a hostile ground unit: red diamond frame.
   The icon geometry below was measured out of the PowerPoint shapes,
   normalised against each diamond's half-height, and redrawn here at a
   single uniform frame size.

   *** UNVERIFIED — FLAGGED FOR SME REVIEW ***
   The icons carried over from the deck are drawn from best
   understanding, not from a confirmed APP-6 plate. Confirm before the
   course is delivered:
     antiTank ..... shaft with double chevron head, two bars, splayed base
     engineer ..... letter E
     ammunition ... rimmed box with snipped top corners
     kitchen ...... bar over a filled block
     transport .... spoked wheel
     mortar ....... shaft with chevron head, two bars, ball base
   ========================================================= */

(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  /* Canvas matches the imagery: 766 x 685 px source, scaled up so the
     symbols can be described in comfortable whole numbers. Changing W
     or H without changing the other will stretch the photograph. */
  var W = 900, H = 805;
  var BASE_IMAGE = 'img/kordan-map.jpg';

  /* ---------- tiny SVG builder ---------- */
  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
      }
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  /* ---------- palette ----------
     Taken from the source deck. Deliberately not tied to --phase:
     hostile red is doctrinal, and recolouring it per phase would teach
     the wrong thing. Only the badges pick up the phase accent. */
  var HOSTILE_FILL = '#f2a0a0', HOSTILE_LINE = '#c00000', ICON = '#101010';

  /* Frame geometry. RX/RY are the diamond's half-width and half-height;
     RY is also the unit the icon paths below are expressed in, so an
     icon coordinate of 0.5 means "half a frame-height from centre". */
  var RX = 27, RY = 24;

  function s(v) { return v * RY; }

  /* ---------- icons ----------
     Each draws into a group whose origin is the frame centre. */
  var ICONS = {

    /* rimmed box, top corners snipped */
    ammunition: function (g, c) {
      el('path', {
        d: 'M -10.8 -9.4 L -7.7 -12.5 L 7.7 -12.5 L 10.8 -9.4 L 10.8 9.4 L -10.8 9.4 Z',
        stroke: c, 'stroke-width': 1.8, fill: 'none', 'stroke-linejoin': 'round'
      }, g);
    },

    /* shaft with a double chevron head, two bars, splayed base */
    antiTank: function (g, c) {
      el('path', {
        d: 'M 0 -16.2 L 0 8.9' +
           ' M -4.2 -12.1 L 0 -16.2 L 4.2 -12.1' +
           ' M -4.2 -7.7 L 0 -11.8 L 4.2 -7.7' +
           ' M -14.1 -2.2 L 14.1 -2.2' +
           ' M -14.1 3.0 L 14.1 3.0' +
           ' M -7.4 17.0 L 0 9.6 L 7.4 17.0',
        stroke: c, 'stroke-width': 1.8, fill: 'none',
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }, g);
    },

    /* bar over a filled block */
    kitchen: function (g, c) {
      el('rect', { x: -16.8, y: -5.3, width: 33.5, height: 3.0, fill: c }, g);
      el('rect', { x: -16.8, y: -2.3, width: 16.7, height: 11.5, fill: c }, g);
    },

    /* letter E, drawn as strokes so it can never be mistaken for text */
    engineer: function (g, c) {
      el('path', {
        d: 'M -4.5 -8 L -4.5 8 M -4.5 -8 L 5 -8 M -4.5 8 L 5 8 M -4.5 0 L 3 0',
        stroke: c, 'stroke-width': 2.2, fill: 'none', 'stroke-linecap': 'round'
      }, g);
    },

    /* letters HQ, likewise strokes and not text */
    headquarters: function (g, c) {
      el('path', {
        d: 'M -12 -7 L -12 7 M -4.5 -7 L -4.5 7 M -12 0 L -4.5 0',
        stroke: c, 'stroke-width': 2.2, fill: 'none', 'stroke-linecap': 'round'
      }, g);
      el('circle', { cx: 6, cy: 0, r: 5.6, stroke: c, 'stroke-width': 2.2, fill: 'none' }, g);
      el('path', {
        d: 'M 7.4 3.4 L 11.4 7.6', stroke: c, 'stroke-width': 2.2, 'stroke-linecap': 'round'
      }, g);
    },

    /* spoked wheel */
    transport: function (g, c) {
      el('ellipse', {
        cx: 0, cy: -0.8, rx: 14.9, ry: 15.0, stroke: c, 'stroke-width': 1.8, fill: 'none'
      }, g);
      el('path', {
        d: 'M -14.9 -0.8 L 14.9 -0.8 M 0 -15.8 L 0 14.2' +
           ' M -10.6 -11.5 L 10.6 9.8 M 10.6 -11.5 L -10.6 9.8',
        stroke: c, 'stroke-width': 1.6, fill: 'none'
      }, g);
    },

    /* shaft with a chevron head, two bars, ball base */
    mortar: function (g, c) {
      el('path', {
        d: 'M 0 -13.6 L 0 4.1' +
           ' M -3.2 -10.0 L 0 -13.6 L 3.2 -10.0' +
           ' M -10.1 -5.3 L 10.1 -5.3' +
           ' M -10.1 -0.9 L 10.1 -0.9',
        stroke: c, 'stroke-width': 1.8, fill: 'none',
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }, g);
      el('ellipse', { cx: 0, cy: 8.3, rx: 3.7, ry: 4.1, fill: c }, g);
    },

    /* crossed bandoliers */
    infantry: function (g, c) {
      el('path', {
        d: 'M -11.8 -8.6 L 11.8 8.6 M 11.8 -8.6 L -11.8 8.6',
        stroke: c, 'stroke-width': 2.2, fill: 'none'
      }, g);
    }
  };

  /* ---------- one complete unit symbol ---------- */
  function unit(parent, spec) {
    var g = el('g', {
      'class': 'map-unit is-' + (spec.state || 'located') +
               (spec.dim ? ' is-dim' : '') + (spec.hot ? ' is-hot' : ''),
      transform: 'translate(' + spec.x + ',' + spec.y + ')',
      'data-marker': spec.id
    }, parent);

    /* focus ring — the drawing sits on a photograph, so a lit marker
       needs more than a heavier badge stroke to be found. Always drawn,
       shown by CSS only when the unit is hot. */
    el('circle', { cx: 0, cy: 0, r: RX + 9, 'class': 'map-hot-ring' }, g);

    var frame = {
      d: 'M 0 ' + (-RY) + ' L ' + RX + ' 0 L 0 ' + RY + ' L ' + (-RX) + ' 0 Z',
      fill: HOSTILE_FILL, stroke: HOSTILE_LINE, 'stroke-width': 2.2,
      'stroke-linejoin': 'round', 'class': 'map-frame-shape'
    };
    /* A dashed frame is the anticipated / planned status modifier. Drawn
       from best understanding of MIL-STD-2525 — FLAGGED, confirm with an
       SME before delivery. */
    if (spec.state === 'templated') frame['stroke-dasharray'] = '7 5';
    el('path', frame, g);

    if (ICONS[spec.icon]) ICONS[spec.icon](g, ICON);

    /* badge offset defaults to upper right; a few markers carry their own
       because the default would land on a neighbour's frame or focus ring */
    if (spec.badge) badge(g, spec.badge, spec.bx === undefined ? 34 : spec.bx,
                                          spec.by === undefined ? -22 : spec.by);
    return g;
  }

  function badge(parent, label, bx, by) {
    var g = el('g', { transform: 'translate(' + bx + ',' + by + ')' }, parent);
    var isLetter = /[A-Z]/.test(label);
    if (isLetter) {
      el('rect', { x: -11, y: -11, width: 22, height: 22, rx: 3, 'class': 'map-badge-bg' }, g);
    } else {
      el('circle', { cx: 0, cy: 0, r: 12, 'class': 'map-badge-bg' }, g);
    }
    var t = el('text', {
      x: 0, y: 0, 'class': 'map-badge-label',
      'text-anchor': 'middle', 'dominant-baseline': 'central'
    }, g);
    t.appendChild(document.createTextNode(label));
    return g;
  }

  /* ---------- the scenario, as data ----------
     x / y are the frame centres, carried over from the shape positions
     in Kordan Brige.pptx and expressed in the W x H canvas above. Move a
     symbol here and it moves on all five pages.

     BADGE NUMBERS ARE DELIBERATELY SCATTERED. An earlier version numbered
     the elements 1-8 in order of importance, which meant refs 1-5 were
     exactly the five high-payoff targets — the map handed the student the
     answer to the Decide phase before he had made it. The numbers are now
     arbitrary labels and must stay that way: do not re-sort them into
     priority, depth, or any other meaningful order.

     The reconnaissance squad was removed from the scenario. Its badge (7)
     was closed up by moving the mortar platoon to 7 and the infantry
     platoon to 8, which preserves the scatter: the high-payoff targets are
     now 2, 4, 5 and 7, and the elements the commander rejects are 1, 3, 6
     and 8. Keep it that way. */
  var UNITS = [
    /* LOCATED — reconnaissance flights found these */
    { id: 'atgm',      badge: '2', state: 'located',   x: 639.1, y: 369.8, icon: 'antiTank', bx: -34, by: 24 },
    { id: 'infantry',  badge: '8', state: 'located',   x: 615.7, y: 534.0, icon: 'infantry' },

    /* TEMPLATED — not there yet. The S-2 assesses he commits the engineer
       team to the bridge within 24 h, and the bridge is the only place he
       can do it, so we know where to look and nothing is there to find. */
    { id: 'engineers', badge: '4', state: 'templated', x: 691.9, y: 325.8, icon: 'engineer', bx: -38, by: -32 },

    /* UNLOCATED — known to exist, no location. Drawn in the strip, in
       badge order, which is arbitrary with respect to priority and must
       stay that way. Give one an x / y and a state of 'located' the day
       the training finds it; nothing else has to change. */
    { id: 'asp',       badge: '1', state: 'unlocated', icon: 'ammunition' },
    { id: 'kitchen',   badge: '3', state: 'unlocated', icon: 'kitchen' },
    { id: 'cp',        badge: '5', state: 'unlocated', icon: 'headquarters' },
    { id: 'trucks',    badge: '6', state: 'unlocated', icon: 'transport' },
    { id: 'mortars',   badge: '7', state: 'unlocated', icon: 'mortar' }
  ];

  /* Terrain the tasks refer to by letter. The photograph carries the
     ground; these only point at it. */
  var TERRAIN = [
    { badge: 'A', x: 310.6, y: 310.9 },   /* Kordan River */
    { badge: 'B', x: 765.0, y: 310.9 }    /* the bridge */
  ];

  /* The commander's restricted fire area (badge G). An open circle, drawn in the
     brass accent rather than hostile red so it cannot be misread as an
     enemy graphic, and rather than the phase accent so it cannot be
     misread as a focus ring.

     THE RADIUS IS NOT A SCALED 300 m. Nothing on this imagery has been
     tied to ground distance, so the circle is sized to read, and it is
     placed to enclose the bridge and the engineer team on it while
     leaving the ATGM section outside — which is what the Deliver tasks
     require of it. Re-derive it if the imagery is ever gridded for real. */
  var RFA = { x: 710, y: 318, r: 62 };

  function drawTerrain(root) {
    var f = el('g', { 'class': 'map-furniture' }, root);

    /* drawn twice: a white halo so the line survives over dark ground,
       then the line itself */
    el('circle', {
      cx: RFA.x, cy: RFA.y, r: RFA.r, fill: 'none',
      stroke: '#ffffff', 'stroke-width': 5, opacity: 0.55
    }, f);
    el('circle', {
      cx: RFA.x, cy: RFA.y, r: RFA.r, 'class': 'map-rfa'
    }, f);

    badge(f, 'G', RFA.x, RFA.y - RFA.r - 4);

    for (var i = 0; i < TERRAIN.length; i++) {
      badge(f, TERRAIN[i].badge, TERRAIN[i].x, TERRAIN[i].y);
    }
  }

  /* ---------- public entry point ---------- */
  function render(containerId, opts) {
    var host = document.getElementById(containerId);
    if (!host) return null;
    opts = opts || {};
    var hot = opts.highlight || [];

    while (host.firstChild) host.removeChild(host.firstChild);

    var svg = el('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      width: '100%',
      role: 'img',
      'class': 'map-svg' + (hot.length ? ' has-focus' : '')
    }, host);

    var title = el('title', {}, svg);
    title.appendChild(document.createTextNode(
      opts.title || 'Operation RIVER GATE — situation map'
    ));
    var desc = el('desc', {}, svg);
    desc.appendChild(document.createTextNode(
      opts.desc || 'Imagery of the Kordan River valley with a grid overlay. The river runs ' +
      'north to south through the right of the picture; the bridge is marked B and the river A. ' +
      'Eight numbered enemy elements are plotted across the valley, and an open circle marked G ' +
      'shows the restricted fire area around the bridge. Every marker is named in the key table below.'
    ));

    /* the imagery base */
    var img = el('image', {
      x: 0, y: 0, width: W, height: H,
      preserveAspectRatio: 'none',
      'class': 'map-base'
    }, svg);
    /* href for modern renderers, xlink:href for older ones */
    img.setAttribute('href', BASE_IMAGE);
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', BASE_IMAGE);

    drawTerrain(svg);

    var layer = el('g', { 'class': 'map-units' }, svg);
    for (var i = 0; i < UNITS.length; i++) {
      var u = UNITS[i];
      if (u.state === 'unlocated') continue;   /* the strip draws these */
      unit(layer, specFor(u, hot));
    }
    return svg;
  }

  /* ---------- the unlocated strip ----------
     A second, separate SVG. It is not a map: there is no ground under it
     and no position implied. It exists so a student can see that an
     element is on the high-value target list without being told where it
     is — the gap between the two is the Detect phase.

     Its heading lives in the HTML beside it, never here: the tagger skips
     <svg>, so a caption written into this file could never translate. */
  var STRIP_W = 900, STRIP_H = 118, STRIP_Y = 62;

  function renderUnlocated(containerId, opts) {
    var host = document.getElementById(containerId);
    if (!host) return null;
    opts = opts || {};
    var hot = opts.highlight || [];

    while (host.firstChild) host.removeChild(host.firstChild);

    var list = [], i;
    for (i = 0; i < UNITS.length; i++) {
      if (UNITS[i].state === 'unlocated') list.push(UNITS[i]);
    }
    if (!list.length) return null;

    var svg = el('svg', {
      viewBox: '0 0 ' + STRIP_W + ' ' + STRIP_H,
      width: '100%',
      role: 'img',
      'class': 'map-svg map-strip' + (hot.length ? ' has-focus' : '')
    }, host);

    var title = el('title', {}, svg);
    title.appendChild(document.createTextNode(
      opts.title || 'Enemy elements known to exist, location not established'
    ));
    var desc = el('desc', {}, svg);
    desc.appendChild(document.createTextNode(
      opts.desc || 'A row of enemy symbols set apart from the map. These elements are on the ' +
      'high-value target list but have not been found, so they have no position. Each is ' +
      'numbered and named in the key table.'
    ));

    var layer = el('g', { 'class': 'map-units' }, svg);
    var step = STRIP_W / list.length;
    for (i = 0; i < list.length; i++) {
      var spec = specFor(list[i], hot);
      spec.x = step * (i + 0.5);
      spec.y = STRIP_Y;
      unit(layer, spec);
    }
    return svg;
  }

  function specFor(u, hot) {
    var spec = {}, k;
    for (k in u) if (Object.prototype.hasOwnProperty.call(u, k)) spec[k] = u[k];
    spec.hot = hot.indexOf(u.id) !== -1;
    spec.dim = hot.length > 0 && !spec.hot;
    return spec;
  }

  global.D3A_MAP = {
    render: render,
    renderUnlocated: renderUnlocated,
    units: UNITS,
    width: W,
    height: H
  };

})(typeof window !== 'undefined' ? window : this);
