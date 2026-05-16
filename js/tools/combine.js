"use strict";

/* ═══════════════════════════════════════════════════════════════════
   OPSIN COMBINE — Pathfinder for the vector editor. Zero dependency.

   Operations (Illustrator / Vectorpea semantics):
     unite     — union of all selected closed shapes (touching or not).
     minus     — Minus Front: bottom shape minus every shape above it.
     intersect — keep only the region common to all selected shapes.
     exclude   — symmetric difference (even-odd) of all selected shapes.

   Pipeline:
     1. Flatten each shape to polygon rings. Every emitted vertex keeps
        provenance (source index, whether the arriving/leaving edge was a
        straight LINE or a CURVE, whether it is an original hard corner)
        via an identity Map keyed by the vertex array itself.
     2. Run a Martinez-Rueda polygon clipper. Original vertex arrays flow
        through by reference; brand-new arrays appear only at boolean
        crossings — so a missing Map entry === a crossing (always sharp).
     3. Reconstruct: split each result ring at forced corners (hard-corner
        anchors + boolean crossings); within a run emit straight sub-runs
        as exact line segments and curved sub-runs as Schneider-fit smooth
        béziers. Result is one path, or a compound (even-odd) path.

   Appearance: unite/intersect/exclude inherit the FRONTMOST selected
   shape; minus front inherits the BOTTOM shape. Result is placed at the
   frontmost selected shape's z-slot; originals are removed.

   Public: window.OpsinCombine
     .run(kind)        — perform op on the active shape layer's selection
     .eligible(layer)  — selected shapes that can participate
     .canCombine(layer)
     .wire()           — wire the Combine options-bar dropdown (idempotent)
     .refresh()        — enable/disable items for the current selection
   ═══════════════════════════════════════════════════════════════════ */

(function (root) {

  // ── tolerances (world / image-pixel units) ────────────────
  var FLATTEN_TOL = 0.08;   // curve→polyline chord error
  var FIT_ERROR   = 0.8;    // polyline→bézier max error
  var SNAP        = 1e-4;   // input coordinate quantization
  var EPS         = 1e-7;

  function q(n) { return Math.round(n / SNAP) * SNAP; }

  /* ═════ Martinez-Rueda clipper (identity-preserving port) ═════ */

  var NORMAL = 0, NON_CONTRIBUTING = 1, SAME_TRANSITION = 2, DIFFERENT_TRANSITION = 3;
  var INTERSECTION = 0, UNION = 1, DIFFERENCE = 2, XOR = 3;

  function equals(p1, p2) { return p1[0] === p2[0] && p1[1] === p2[1]; }
  function signedArea(p0, p1, p2) {
    return (p0[0] - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (p0[1] - p2[1]);
  }

  function SweepEvent(point, left, otherEvent, isSubject, edgeType) {
    this.left = left;
    this.point = point;
    this.otherEvent = otherEvent;
    this.isSubject = isSubject;
    this.type = edgeType || NORMAL;
    this.inOut = false;
    this.otherInOut = false;
    this.prevInResult = null;
    this.resultTransition = 0;
    this.otherPos = -1;
    this.outputContourId = -1;
    this.contourId = 0;
  }
  SweepEvent.prototype.isBelow = function (p) {
    var a = this.point, b = this.otherEvent.point;
    return this.left ? signedArea(a, b, p) > 0 : signedArea(b, a, p) > 0;
  };
  SweepEvent.prototype.isAbove = function (p) { return !this.isBelow(p); };
  SweepEvent.prototype.isVertical = function () {
    return this.point[0] === this.otherEvent.point[0];
  };
  SweepEvent.prototype.inResult = function () { return this.resultTransition !== 0; };

  function compareEvents(e1, e2) {
    var p1 = e1.point, p2 = e2.point;
    if (p1[0] > p2[0]) return 1;
    if (p1[0] < p2[0]) return -1;
    if (p1[1] !== p2[1]) return p1[1] > p2[1] ? 1 : -1;
    return specialCases(e1, e2, p1);
  }
  function specialCases(e1, e2, p1) {
    if (e1.left !== e2.left) return e1.left ? 1 : -1;
    if (signedArea(p1, e1.otherEvent.point, e2.otherEvent.point) !== 0) {
      return e1.isBelow(e2.otherEvent.point) ? -1 : 1;
    }
    return (!e1.isSubject && e2.isSubject) ? 1 : -1;
  }

  function Queue() { this.data = []; }
  Queue.prototype.push = function (item) {
    var d = this.data; d.push(item);
    var i = d.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (compareEvents(d[i], d[parent]) < 0) {
        var t = d[i]; d[i] = d[parent]; d[parent] = t; i = parent;
      } else break;
    }
  };
  Queue.prototype.pop = function () {
    var d = this.data;
    var top = d[0], last = d.pop();
    if (d.length) {
      d[0] = last;
      var i = 0, n = d.length;
      while (true) {
        var l = 2 * i + 1, r = l + 1, s = i;
        if (l < n && compareEvents(d[l], d[s]) < 0) s = l;
        if (r < n && compareEvents(d[r], d[s]) < 0) s = r;
        if (s === i) break;
        var t = d[i]; d[i] = d[s]; d[s] = t; i = s;
      }
    }
    return top;
  };
  Queue.prototype.size = function () { return this.data.length; };

  function compareSegments(le1, le2) {
    if (le1 === le2) return 0;
    if (signedArea(le1.point, le1.otherEvent.point, le2.point) !== 0 ||
        signedArea(le1.point, le1.otherEvent.point, le2.otherEvent.point) !== 0) {
      if (equals(le1.point, le2.point)) return le1.isBelow(le2.otherEvent.point) ? -1 : 1;
      if (le1.point[0] === le2.point[0]) return le1.point[1] < le2.point[1] ? -1 : 1;
      if (compareEvents(le1, le2) === 1) return le2.isAbove(le1.point) ? -1 : 1;
      return le1.isBelow(le2.point) ? -1 : 1;
    }
    if (le1.isSubject === le2.isSubject) {
      if (equals(le1.point, le2.point) && equals(le1.otherEvent.point, le2.otherEvent.point)) return 0;
      return le1.contourId > le2.contourId ? 1 : -1;
    }
    return le1.isSubject ? -1 : 1;
  }
  function statusInsert(status, item) {
    var lo = 0, hi = status.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (compareSegments(status[mid], item) < 0) lo = mid + 1; else hi = mid;
    }
    status.splice(lo, 0, item);
    return lo;
  }

  function processPolygon(rings, isSubject, contourId, queue, bbox) {
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      var n = ring.length;
      for (var i = 0; i < n - 1; i++) {
        var a = ring[i], b = ring[i + 1];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        var e1 = new SweepEvent(a, false, undefined, isSubject);
        var e2 = new SweepEvent(b, false, e1, isSubject);
        e1.otherEvent = e2;
        e1.contourId = e2.contourId = contourId;
        if (compareEvents(e1, e2) > 0) e2.left = true; else e1.left = true;
        if (a[0] < bbox[0]) bbox[0] = a[0];
        if (a[1] < bbox[1]) bbox[1] = a[1];
        if (a[0] > bbox[2]) bbox[2] = a[0];
        if (a[1] > bbox[3]) bbox[3] = a[1];
        queue.push(e1);
        queue.push(e2);
      }
    }
  }

  function divideSegment(se, p, queue) {
    var r = new SweepEvent(p, false, se, se.isSubject);
    var l = new SweepEvent(p, true, se.otherEvent, se.isSubject);
    r.contourId = l.contourId = se.contourId;
    if (compareEvents(l, se.otherEvent) > 0) {
      se.otherEvent.left = true;
      l.left = false;
    }
    se.otherEvent.otherEvent = l;
    se.otherEvent = r;
    queue.push(l);
    queue.push(r);
  }

  function segmentIntersection(a1, a2, b1, b2) {
    var va = [a2[0] - a1[0], a2[1] - a1[1]];
    var vb = [b2[0] - b1[0], b2[1] - b1[1]];
    var e = [b1[0] - a1[0], b1[1] - a1[1]];
    var kross = va[0] * vb[1] - va[1] * vb[0];
    var sqrKross = kross * kross;
    var sqrLenA = va[0] * va[0] + va[1] * va[1];
    if (sqrKross > 1e-12 * sqrLenA * (vb[0] * vb[0] + vb[1] * vb[1])) {
      var s = (e[0] * vb[1] - e[1] * vb[0]) / kross;
      if (s < 0 || s > 1) return null;
      var t = (e[0] * va[1] - e[1] * va[0]) / kross;
      if (t < 0 || t > 1) return null;
      if (s === 0 || s === 1) return { pts: [[a1[0] + s * va[0], a1[1] + s * va[1]]], n: 1 };
      if (t === 0 || t === 1) return { pts: [[b1[0] + t * vb[0], b1[1] + t * vb[1]]], n: 1 };
      return { pts: [[a1[0] + s * va[0], a1[1] + s * va[1]]], n: 1 };
    }
    var sqrLenE = e[0] * e[0] + e[1] * e[1];
    kross = e[0] * va[1] - e[1] * va[0];
    if (kross * kross > 1e-12 * sqrLenA * sqrLenE) return null;
    var sa = (va[0] * e[0] + va[1] * e[1]) / sqrLenA;
    var sb = sa + (va[0] * vb[0] + va[1] * vb[1]) / sqrLenA;
    var smin = Math.min(sa, sb), smax = Math.max(sa, sb);
    if (smin <= 1 && smax >= 0) {
      var p1 = smin < 0 ? a1 : [a1[0] + smin * va[0], a1[1] + smin * va[1]];
      var p2 = smax > 1 ? a2 : [a1[0] + smax * va[0], a1[1] + smax * va[1]];
      if (equals(p1, p2)) return { pts: [p1], n: 1 };
      return { pts: [p1, p2], n: 2 };
    }
    return null;
  }

  function possibleIntersection(se1, se2, queue) {
    var inter = segmentIntersection(
      se1.point, se1.otherEvent.point, se2.point, se2.otherEvent.point);
    var nintersections = inter ? inter.n : 0;
    if (nintersections === 0) return 0;
    if (nintersections === 1 &&
        (equals(se1.point, se2.point) ||
         equals(se1.otherEvent.point, se2.otherEvent.point))) return 0;
    if (nintersections === 2 && se1.isSubject === se2.isSubject) return 0;

    if (nintersections === 1) {
      if (!equals(se1.point, inter.pts[0]) && !equals(se1.otherEvent.point, inter.pts[0])) {
        divideSegment(se1, inter.pts[0], queue);
      }
      if (!equals(se2.point, inter.pts[0]) && !equals(se2.otherEvent.point, inter.pts[0])) {
        divideSegment(se2, inter.pts[0], queue);
      }
      return 1;
    }

    var events = [];
    var leftCoincide = equals(se1.point, se2.point);
    var rightCoincide = equals(se1.otherEvent.point, se2.otherEvent.point);
    if (!leftCoincide) {
      if (compareEvents(se1, se2) > 0) events.push(se2, se1); else events.push(se1, se2);
    }
    if (!rightCoincide) {
      if (compareEvents(se1.otherEvent, se2.otherEvent) > 0) {
        events.push(se2.otherEvent, se1.otherEvent);
      } else { events.push(se1.otherEvent, se2.otherEvent); }
    }
    if ((leftCoincide && rightCoincide) || leftCoincide) {
      se2.type = NON_CONTRIBUTING;
      se1.type = (se2.inOut === se1.inOut) ? SAME_TRANSITION : DIFFERENT_TRANSITION;
      if (leftCoincide && !rightCoincide) {
        divideSegment(events[1].otherEvent, events[0].point, queue);
      }
      return 3;
    }
    if (rightCoincide) {
      divideSegment(events[0], events[1].point, queue);
      return 3;
    }
    if (events[0] !== events[3].otherEvent) {
      divideSegment(events[0], events[1].point, queue);
      divideSegment(events[1], events[2].point, queue);
      return 3;
    }
    divideSegment(events[0], events[1].point, queue);
    divideSegment(events[3].otherEvent, events[2].point, queue);
    return 3;
  }

  function inResult(event, operation) {
    switch (event.type) {
      case NORMAL:
        switch (operation) {
          case INTERSECTION: return !event.otherInOut;
          case UNION:        return event.otherInOut;
          case DIFFERENCE:
            return (event.isSubject && event.otherInOut) ||
                   (!event.isSubject && !event.otherInOut);
          case XOR: return true;
        }
        return false;
      case SAME_TRANSITION:
        return operation === INTERSECTION || operation === UNION;
      case DIFFERENT_TRANSITION:
        return operation === DIFFERENCE;
      case NON_CONTRIBUTING:
        return false;
    }
    return false;
  }
  function determineResultTransition(event, operation) {
    var thisIn = !event.inOut, thatIn = !event.otherInOut, isIn;
    switch (operation) {
      case INTERSECTION: isIn = thisIn && thatIn; break;
      case UNION:        isIn = thisIn || thatIn; break;
      case XOR:          isIn = thisIn ? !thatIn : thatIn; break;
      case DIFFERENCE:
        isIn = event.isSubject ? (thisIn && !thatIn) : (thatIn && !thisIn);
        break;
      default: isIn = false;
    }
    return isIn ? 1 : -1;
  }
  function computeFields(event, prev, operation) {
    if (prev === null) {
      event.inOut = false;
      event.otherInOut = true;
    } else if (event.isSubject === prev.isSubject) {
      event.inOut = !prev.inOut;
      event.otherInOut = prev.otherInOut;
    } else {
      event.inOut = !prev.otherInOut;
      event.otherInOut = prev.isVertical() ? !prev.inOut : prev.inOut;
    }
    if (prev) {
      event.prevInResult = (!inResult(prev, operation) || prev.isVertical())
        ? prev.prevInResult : prev;
    }
    var isInResult = inResult(event, operation);
    event.resultTransition = isInResult ? determineResultTransition(event, operation) : 0;
  }

  function subdivide(queue, operation) {
    var status = [];
    var sortedEvents = [];
    while (queue.size()) {
      var event = queue.pop();
      sortedEvents.push(event);
      if (event.left) {
        var pos = statusInsert(status, event);
        var prev = pos > 0 ? status[pos - 1] : null;
        var next = pos < status.length - 1 ? status[pos + 1] : null;
        computeFields(event, prev, operation);
        if (next && possibleIntersection(event, next, queue) === 2) {
          computeFields(event, prev, operation);
          computeFields(next, event, operation);
        }
        if (prev && possibleIntersection(prev, event, queue) === 2) {
          var pp = null;
          var pidx = status.indexOf(prev);
          if (pidx > 0) pp = status[pidx - 1];
          computeFields(prev, pp, operation);
          computeFields(event, prev, operation);
        }
      } else {
        event = event.otherEvent;
        var idx = status.indexOf(event);
        if (idx !== -1) {
          var sprev = idx > 0 ? status[idx - 1] : null;
          var snext = idx < status.length - 1 ? status[idx + 1] : null;
          status.splice(idx, 1);
          if (sprev && snext) possibleIntersection(sprev, snext, queue);
        }
      }
    }
    return sortedEvents;
  }

  function orderEvents(sortedEvents) {
    var resultEvents = [], i, event;
    for (i = 0; i < sortedEvents.length; i++) {
      event = sortedEvents[i];
      if ((event.left && event.inResult()) ||
          (!event.left && event.otherEvent.inResult())) {
        resultEvents.push(event);
      }
    }
    var sorted = false;
    while (!sorted) {
      sorted = true;
      for (i = 0; i < resultEvents.length - 1; i++) {
        if (compareEvents(resultEvents[i], resultEvents[i + 1]) === 1) {
          var t = resultEvents[i]; resultEvents[i] = resultEvents[i + 1]; resultEvents[i + 1] = t;
          sorted = false;
        }
      }
    }
    for (i = 0; i < resultEvents.length; i++) resultEvents[i].otherPos = i;
    for (i = 0; i < resultEvents.length; i++) {
      event = resultEvents[i];
      if (!event.left) {
        var tmp = event.otherPos;
        event.otherPos = event.otherEvent.otherPos;
        event.otherEvent.otherPos = tmp;
      }
    }
    return resultEvents;
  }
  function nextPos(pos, resultEvents, processed, origIndex) {
    var newPos = pos + 1;
    var length = resultEvents.length;
    var p = resultEvents[pos].point;
    var p1 = newPos < length ? resultEvents[newPos].point : null;
    while (newPos < length && p1 && equals(p1, p)) {
      if (!processed[newPos]) return newPos;
      newPos++;
      p1 = newPos < length ? resultEvents[newPos].point : null;
    }
    newPos = pos - 1;
    while (newPos >= origIndex && processed[newPos]) newPos--;
    return newPos;
  }
  function connectEdges(sortedEvents) {
    var resultEvents = orderEvents(sortedEvents);
    var processed = {};
    var rings = [];
    for (var i = 0; i < resultEvents.length; i++) {
      if (processed[i]) continue;
      var ring = [];
      var pos = i;
      var origIndex = i;
      ring.push(resultEvents[i].point);
      while (pos >= origIndex) {
        processed[pos] = true;
        if (resultEvents[pos].left) {
          resultEvents[pos].outputContourId = rings.length;
        } else {
          resultEvents[pos].otherEvent.outputContourId = rings.length;
        }
        pos = resultEvents[pos].otherPos;
        processed[pos] = true;
        ring.push(resultEvents[pos].point);
        pos = nextPos(pos, resultEvents, processed, origIndex);
      }
      if (ring.length >= 3) {
        // Close by reusing the first vertex's identity (no copy → provenance
        // Map lookups still resolve on the closing vertex).
        if (!equals(ring[0], ring[ring.length - 1])) ring.push(ring[0]);
        rings.push(ring);
      }
    }
    return rings;
  }

  function bboxOverlap(b1, b2) {
    return !(b2[0] > b1[2] || b1[0] > b2[2] || b2[1] > b1[3] || b1[1] > b2[3]);
  }
  // Ensure each ring is closed WITHOUT copying its vertex arrays, so the
  // identity-keyed provenance Map keeps resolving after clipping.
  function closeRings(poly) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      var r = poly[i];
      if (r.length && !equals(r[0], r[r.length - 1])) {
        r = r.slice();          // shallow: keeps element (vertex) identity
        r.push(r[0]);
      }
      if (r.length >= 4) out.push(r);
    }
    return out;
  }
  function flattenPolys(polys) {
    var out = [];
    for (var i = 0; i < polys.length; i++) {
      for (var j = 0; j < polys[i].length; j++) out.push(polys[i][j]);
    }
    return out;
  }

  // subjectPolys / clipPolys: array of polygons; polygon = array of rings;
  // ring = array of [x,y] vertex arrays. Returns array of rings (even-odd).
  function clip(subjectPolys, clipPolys, operation) {
    var sEmpty = !subjectPolys || subjectPolys.length === 0;
    var cEmpty = !clipPolys || clipPolys.length === 0;
    if (sEmpty && cEmpty) return [];
    if (sEmpty || cEmpty) {
      if (operation === INTERSECTION) return [];
      if (operation === DIFFERENCE) return sEmpty ? [] : flattenPolys(subjectPolys);
      return flattenPolys(sEmpty ? clipPolys : subjectPolys);
    }
    var queue = new Queue();
    var sbb = [Infinity, Infinity, -Infinity, -Infinity];
    var cbb = [Infinity, Infinity, -Infinity, -Infinity];
    var cid = 0, k;
    for (k = 0; k < subjectPolys.length; k++) {
      processPolygon(closeRings(subjectPolys[k]), true, cid++, queue, sbb);
    }
    for (k = 0; k < clipPolys.length; k++) {
      processPolygon(closeRings(clipPolys[k]), false, cid++, queue, cbb);
    }
    if (!bboxOverlap(sbb, cbb)) {
      if (operation === INTERSECTION) return [];
      if (operation === DIFFERENCE) return flattenPolys(subjectPolys);
      return flattenPolys(subjectPolys).concat(flattenPolys(clipPolys));
    }
    var sortedEvents = subdivide(queue, operation);
    return connectEdges(sortedEvents);
  }

  function ringArea(r) {
    var a = 0;
    for (var i = 0, n = r.length, j = n - 1; i < n; j = i++) {
      a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
    }
    return a / 2;
  }
  function pointInRing(pt, r) {
    var inside = false, x = pt[0], y = pt[1];
    for (var i = 0, n = r.length, j = n - 1; i < n; j = i++) {
      var xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }
  // Group flat rings into polygons (outer + holes) by containment.
  function ringsToPolygons(rings) {
    var meta = [];
    for (var i = 0; i < rings.length; i++) {
      var ar = Math.abs(ringArea(rings[i]));
      if (ar >= 1e-9) meta.push({ ring: rings[i], area: ar });
    }
    meta.sort(function (a, b) { return b.area - a.area; });
    var polys = [];
    for (var m = 0; m < meta.length; m++) {
      var r = meta[m].ring;
      var test = r[0];
      var host = null;
      for (var p = 0; p < polys.length; p++) {
        if (pointInRing(test, polys[p][0])) {
          var inHole = false;
          for (var h = 1; h < polys[p].length; h++) {
            if (pointInRing(test, polys[p][h])) { inHole = true; break; }
          }
          if (!inHole) host = polys[p];
        }
      }
      if (host) host.push(r); else polys.push([r]);
    }
    return polys;
  }

  /* ═════ Provenance-tagged flatten ═════ */

  // meta: identity Map  vertexArray → { src, inT, outT, hard, anchor }
  //   src    source index (0..n-1) the vertex belongs to
  //   inT    'L' | 'C'  type of the edge ARRIVING at this vertex
  //   outT   'L' | 'C'  type of the edge LEAVING this vertex
  //   hard   true if an original hard-corner anchor (sharp)
  //   anchor true if an original path anchor (vs interpolated curve sample)

  function _flattenCubic(p0, c1, c2, p1, tol, out, depth) {
    if (depth > 18) { out.push([p1[0], p1[1]]); return; }
    var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    var d1 = Math.abs((c1[0] - p1[0]) * dy - (c1[1] - p1[1]) * dx);
    var d2 = Math.abs((c2[0] - p1[0]) * dy - (c2[1] - p1[1]) * dx);
    if ((d1 + d2) * (d1 + d2) < tol * (dx * dx + dy * dy)) {
      out.push([p1[0], p1[1]]); return;
    }
    var p01 = [(p0[0] + c1[0]) / 2, (p0[1] + c1[1]) / 2];
    var pc  = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
    var p12 = [(c2[0] + p1[0]) / 2, (c2[1] + p1[1]) / 2];
    var p012 = [(p01[0] + pc[0]) / 2, (p01[1] + pc[1]) / 2];
    var p123 = [(pc[0] + p12[0]) / 2, (pc[1] + p12[1]) / 2];
    var m = [(p012[0] + p123[0]) / 2, (p012[1] + p123[1]) / 2];
    _flattenCubic(p0, p01, p012, m, tol, out, depth + 1);
    _flattenCubic(m, p123, p12, p1, tol, out, depth + 1);
  }

  function _rotatePt(x, y, cx, cy, r) {
    if (!r) return [x, y];
    var c = Math.cos(r), s = Math.sin(r);
    var dx = x - cx, dy = y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }

  function _vec(ax, ay, bx, by) {
    var x = bx - ax, y = by - ay, l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  }

  // Anchor list → { contour:[ [x,y] arrays ], spec:[ per-anchor seg info ] }
  // Each entry of spec: { hard:bool, inT, outT }. Builds the closed ring with
  // curve samples and tags every vertex array into `meta`.
  function _emitPathContour(pts, closed, src, meta) {
    var n = pts.length;
    if (n < 2) return null;
    var lim = closed ? n : n - 1;

    function isLine(a, b) {
      var c1x = a.ohx !== undefined ? a.ohx : a.x;
      var c1y = a.ohy !== undefined ? a.ohy : a.y;
      var c2x = b.ihx !== undefined ? b.ihx : b.x;
      var c2y = b.ihy !== undefined ? b.ihy : b.y;
      return c1x === a.x && c1y === a.y && c2x === b.x && c2y === b.y;
    }
    function segType(i) { return isLine(pts[i], pts[(i + 1) % n]) ? 'L' : 'C'; }

    // Hard-corner test for anchor i: explicit type, a missing handle on a
    // curve side, or a tangent break between the in/out directions.
    function hardAt(i) {
      var a = pts[i];
      if (a.type === 'corner') return true;
      var prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      var inT = segType((i - 1 + n) % n), outT = segType(i);
      var tin, tout;
      if (inT === 'L') tin = _vec(prev.x, prev.y, a.x, a.y);
      else {
        var ihx = a.ihx !== undefined ? a.ihx : a.x;
        var ihy = a.ihy !== undefined ? a.ihy : a.y;
        tin = (ihx === a.x && ihy === a.y)
          ? _vec(prev.x, prev.y, a.x, a.y) : _vec(ihx, ihy, a.x, a.y);
      }
      if (outT === 'L') tout = _vec(a.x, a.y, next.x, next.y);
      else {
        var ohx = a.ohx !== undefined ? a.ohx : a.x;
        var ohy = a.ohy !== undefined ? a.ohy : a.y;
        tout = (ohx === a.x && ohy === a.y)
          ? _vec(a.x, a.y, next.x, next.y) : _vec(a.x, a.y, ohx, ohy);
      }
      var dotv = tin[0] * tout[0] + tin[1] * tout[1];
      return dotv < 0.99985;          // > ~1° tangent break ⇒ corner
    }

    var contour = [];
    // Per original anchor: its (rounded) coordinate + classification.
    var anchorRec = [];
    for (var i = 0; i < n; i++) {
      anchorRec.push({
        x: pts[i].x, y: pts[i].y,
        inT: segType((i - 1 + n) % n),
        outT: segType(i % n),
        hard: hardAt(i)
      });
    }

    // Start vertex.
    var v0 = [q(pts[0].x), q(pts[0].y)];
    meta.set(v0, { src: src, inT: anchorRec[0].inT, outT: anchorRec[0].outT,
                   hard: anchorRec[0].hard, anchor: true });
    contour.push(v0);

    for (var s = 0; s < lim; s++) {
      var a = pts[s], b = pts[(s + 1) % n];
      var t = segType(s);
      if (t === 'L') {
        if (s < lim - 1 || !closed) {
          var vb = [q(b.x), q(b.y)];
          var br = anchorRec[(s + 1) % n];
          meta.set(vb, { src: src, inT: br.inT, outT: br.outT,
                         hard: br.hard, anchor: true });
          contour.push(vb);
        }
      } else {
        var c1x = a.ohx !== undefined ? a.ohx : a.x;
        var c1y = a.ohy !== undefined ? a.ohy : a.y;
        var c2x = b.ihx !== undefined ? b.ihx : b.x;
        var c2y = b.ihy !== undefined ? b.ihy : b.y;
        var raw = [];
        _flattenCubic([a.x, a.y], [c1x, c1y], [c2x, c2y], [b.x, b.y],
                      FLATTEN_TOL, raw, 0);
        for (var r = 0; r < raw.length; r++) {
          var last = (r === raw.length - 1);
          if (last && (s === lim - 1) && closed) break; // closes onto v0
          var vp = [q(raw[r][0]), q(raw[r][1])];
          if (last) {
            var ar = anchorRec[(s + 1) % n];
            meta.set(vp, { src: src, inT: ar.inT, outT: ar.outT,
                           hard: ar.hard, anchor: true });
          } else {
            meta.set(vp, { src: src, inT: 'C', outT: 'C',
                           hard: false, anchor: false });
          }
          contour.push(vp);
        }
      }
    }
    return contour;
  }

  // Build [{points,closed}] subpaths for any shape (world space).
  function _shapeContours(s) {
    if (!s || s.type === 'line') return [];
    if (s.type === 'rect') {
      var rot = s.rotation || 0;
      var cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      var rad = Math.max(0, Math.min(s.cornerRadius || 0, Math.min(s.w, s.h) / 2));
      var x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      var P = function (x, y) { var p = _rotatePt(x, y, cx, cy, rot); return { x: p[0], y: p[1] }; };
      if (rad <= 0) {
        return [{ points: [
          P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)
        ].map(function (p) { return { x: p.x, y: p.y, type: 'corner' }; }), closed: true }];
      }
      // Rounded rect: straight sides + quarter-arc béziers (kappa). Tangent
      // points are NOT hard corners (smooth line↔arc joins).
      var K = 0.5522847498307936 * rad;
      function arc(cxr, cyr, a0) {
        // quarter circle from angle a0 → a0+90°, as a cubic bézier
        var ax = cxr + Math.cos(a0) * rad, ay = cyr + Math.sin(a0) * rad;
        var bx = cxr + Math.cos(a0 + Math.PI / 2) * rad, by = cyr + Math.sin(a0 + Math.PI / 2) * rad;
        var t0x = -Math.sin(a0), t0y = Math.cos(a0);
        var t1x = -Math.sin(a0 + Math.PI / 2), t1y = Math.cos(a0 + Math.PI / 2);
        return {
          a: P(ax, ay), b: P(bx, by),
          oh: P(ax + t0x * K, ay + t0y * K),
          ih: P(bx - t1x * K, by - t1y * K)
        };
      }
      var aTL = arc(x0 + rad, y0 + rad, Math.PI);            // top-left
      var aTR = arc(x1 - rad, y0 + rad, -Math.PI / 2);       // top-right
      var aBR = arc(x1 - rad, y1 - rad, 0);                  // bottom-right
      var aBL = arc(x0 + rad, y1 - rad, Math.PI / 2);        // bottom-left
      function curveAnchor(start, ctlOut) {
        return { x: start.x, y: start.y, ohx: ctlOut.x, ohy: ctlOut.y };
      }
      function endAnchor(p, ctlIn) {
        return { x: p.x, y: p.y, ihx: ctlIn.x, ihy: ctlIn.y };
      }
      // Walk: TL.a →(arc)→ TL.b →line→ TR.a →(arc)→ TR.b →line→ BR.a ...
      var pts = [];
      function pushArc(A) {
        pts.push({ x: A.a.x, y: A.a.y, ohx: A.oh.x, ohy: A.oh.y });
        pts.push({ x: A.b.x, y: A.b.y, ihx: A.ih.x, ihy: A.ih.y });
      }
      // To express as one anchor list we merge the line join: each arc end
      // anchor also carries the straight run to the next arc start (line
      // segment is implicit because next anchor has no in-handle).
      pushArc(aTL); pushArc(aTR); pushArc(aBR); pushArc(aBL);
      return [{ points: pts, closed: true }];
    }
    if (s.type === 'ellipse') {
      var ecx = s.x + s.w / 2, ecy = s.y + s.h / 2, er = s.rotation || 0;
      var rx = Math.abs(s.w / 2), ry = Math.abs(s.h / 2);
      var kx = 0.5522847498307936 * rx, ky = 0.5522847498307936 * ry;
      function ept(px, py) { var p = _rotatePt(px, py, ecx, ecy, er); return { x: p[0], y: p[1] }; }
      var E = ept(ecx + rx, ecy), Sp = ept(ecx, ecy + ry),
          W = ept(ecx - rx, ecy), N = ept(ecx, ecy - ry);
      var eh = function (px, py) { return ept(px, py); };
      var pe = [
        { x: E.x, y: E.y, ihx: eh(ecx + rx, ecy - ky).x, ihy: eh(ecx + rx, ecy - ky).y,
                          ohx: eh(ecx + rx, ecy + ky).x, ohy: eh(ecx + rx, ecy + ky).y },
        { x: Sp.x, y: Sp.y, ihx: eh(ecx + kx, ecy + ry).x, ihy: eh(ecx + kx, ecy + ry).y,
                            ohx: eh(ecx - kx, ecy + ry).x, ohy: eh(ecx - kx, ecy + ry).y },
        { x: W.x, y: W.y, ihx: eh(ecx - rx, ecy + ky).x, ihy: eh(ecx - rx, ecy + ky).y,
                          ohx: eh(ecx - rx, ecy - ky).x, ohy: eh(ecx - rx, ecy - ky).y },
        { x: N.x, y: N.y, ihx: eh(ecx - kx, ecy - ry).x, ihy: eh(ecx - kx, ecy - ry).y,
                          ohx: eh(ecx + kx, ecy - ry).x, ohy: eh(ecx + kx, ecy - ry).y }
      ];
      return [{ points: pe, closed: true }];
    }
    if (s.type === 'path') {
      var subs = (s.subpaths && s.subpaths.length)
        ? s.subpaths : [{ points: s.points, closed: s.closed }];
      var out = [];
      for (var i = 0; i < subs.length; i++) {
        if (subs[i].closed && subs[i].points && subs[i].points.length >= 2) {
          out.push({ points: subs[i].points, closed: true });
        }
      }
      return out;
    }
    return [];
  }

  // Shape → array of polygons (outer + holes), provenance tagged into `meta`.
  function _shapeToPolys(s, src, meta) {
    var contours = _shapeContours(s);
    var rings = [];
    for (var i = 0; i < contours.length; i++) {
      var ring = _emitPathContour(contours[i].points, true, src, meta);
      if (ring && ring.length >= 3) rings.push(ring);
    }
    return ringsToPolygons(rings);
  }

  /* ═════ Schneider curve fitting (per curved sub-run) ═════ */

  function v(a, b) { return [b[0] - a[0], b[1] - a[1]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function norm(a) { var l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; }

  function fitCurve(points, maxError) {
    if (points.length < 2) return [];
    if (points.length === 2) {
      var d = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) / 3;
      var t = norm(v(points[0], points[1]));
      return [[points[0], add(points[0], mul(t, d)),
               add(points[1], mul([-t[0], -t[1]], d)), points[1]]];
    }
    var leftT = norm(v(points[0], points[1]));
    var rightT = norm(v(points[points.length - 1], points[points.length - 2]));
    return fitCubic(points, leftT, rightT, maxError);
  }
  function fitCubic(pts, t1, t2, error) {
    if (pts.length === 2) {
      var d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / 3;
      return [[pts[0], add(pts[0], mul(t1, d)), add(pts[1], mul(t2, d)), pts[1]]];
    }
    var u = chordLengthParam(pts);
    var bez = generateBezier(pts, u, t1, t2);
    var maxIt = computeMaxError(pts, bez, u);
    if (maxIt.error < error) return [bez];
    if (maxIt.error < error * error) {
      for (var i = 0; i < 6; i++) {
        var up = reparam(bez, pts, u);
        bez = generateBezier(pts, up, t1, t2);
        maxIt = computeMaxError(pts, bez, up);
        if (maxIt.error < error) return [bez];
        u = up;
      }
    }
    var split = maxIt.index;
    if (split <= 0) split = 1;
    if (split >= pts.length - 1) split = pts.length - 2;
    var cT = norm(v(pts[split - 1], pts[split + 1]));
    var left = fitCubic(pts.slice(0, split + 1), t1, cT, error);
    var right = fitCubic(pts.slice(split), [-cT[0], -cT[1]], t2, error);
    return left.concat(right);
  }
  function chordLengthParam(pts) {
    var u = [0];
    for (var i = 1; i < pts.length; i++) {
      u[i] = u[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    var last = u[u.length - 1] || 1;
    for (var k = 0; k < u.length; k++) u[k] /= last;
    return u;
  }
  function B0(t) { var m = 1 - t; return m * m * m; }
  function B1(t) { var m = 1 - t; return 3 * m * m * t; }
  function B2(t) { var m = 1 - t; return 3 * m * t * t; }
  function B3(t) { return t * t * t; }
  function bezierPt(b, t) {
    return [
      B0(t) * b[0][0] + B1(t) * b[1][0] + B2(t) * b[2][0] + B3(t) * b[3][0],
      B0(t) * b[0][1] + B1(t) * b[1][1] + B2(t) * b[2][1] + B3(t) * b[3][1]
    ];
  }
  function generateBezier(pts, u, t1, t2) {
    var n = pts.length, p0 = pts[0], p3 = pts[n - 1];
    var C = [[0, 0], [0, 0]], X = [0, 0];
    for (var i = 0; i < n; i++) {
      var a1 = mul(t1, B1(u[i])), a2 = mul(t2, B2(u[i]));
      C[0][0] += dot(a1, a1); C[0][1] += dot(a1, a2);
      C[1][0] += dot(a1, a2); C[1][1] += dot(a2, a2);
      var tmp = v(add(mul(p0, B0(u[i]) + B1(u[i])), mul(p3, B2(u[i]) + B3(u[i]))), pts[i]);
      X[0] += dot(a1, tmp); X[1] += dot(a2, tmp);
    }
    var det = C[0][0] * C[1][1] - C[1][0] * C[0][1];
    var aL, aR;
    if (Math.abs(det) < 1e-12) {
      var segL = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / 3;
      aL = aR = segL;
    } else {
      aL = (X[0] * C[1][1] - X[1] * C[0][1]) / det;
      aR = (C[0][0] * X[1] - C[1][0] * X[0]) / det;
    }
    var seg = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    if (aL < seg * 1e-3 || aR < seg * 1e-3) { aL = aR = seg / 3; }
    return [p0, add(p0, mul(t1, aL)), add(p3, mul(t2, aR)), p3];
  }
  function computeMaxError(pts, bez, u) {
    var maxD = 0, idx = Math.floor(pts.length / 2);
    for (var i = 1; i < pts.length - 1; i++) {
      var pt = bezierPt(bez, u[i]);
      var d = (pt[0] - pts[i][0]) * (pt[0] - pts[i][0]) +
              (pt[1] - pts[i][1]) * (pt[1] - pts[i][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    return { error: maxD, index: idx };
  }
  function reparam(bez, pts, u) {
    var out = [];
    for (var i = 0; i < pts.length; i++) out[i] = newtonRoot(bez, pts[i], u[i]);
    return out;
  }
  function newtonRoot(bez, p, t) {
    var d = [v(bez[0], bez[1]), v(bez[1], bez[2]), v(bez[2], bez[3])];
    var qp = bezierPt(bez, t);
    var qd = [
      (1 - t) * (1 - t) * 3 * d[0][0] + 2 * (1 - t) * t * 3 * d[1][0] + t * t * 3 * d[2][0],
      (1 - t) * (1 - t) * 3 * d[0][1] + 2 * (1 - t) * t * 3 * d[1][1] + t * t * 3 * d[2][1]
    ];
    var qdd = [
      6 * (1 - t) * (d[1][0] - d[0][0]) + 6 * t * (d[2][0] - d[1][0]),
      6 * (1 - t) * (d[1][1] - d[0][1]) + 6 * t * (d[2][1] - d[1][1])
    ];
    var num = (qp[0] - p[0]) * qd[0] + (qp[1] - p[1]) * qd[1];
    var den = qd[0] * qd[0] + qd[1] * qd[1] + (qp[0] - p[0]) * qdd[0] + (qp[1] - p[1]) * qdd[1];
    if (Math.abs(den) < 1e-12) return t;
    var nt = t - num / den;
    if (nt < 0) nt = 0; else if (nt > 1) nt = 1;
    return nt;
  }

  /* ═════ Reconstruction (Option A: corners + true curves) ═════ */

  function _almostEq(ax, ay, bx, by, e) {
    return Math.abs(ax - bx) <= e && Math.abs(ay - by) <= e;
  }

  // Append the bézier segments of a fitted curved sub-run as Opsin anchors.
  // `out` is the running anchor list; the join anchor is reused (no dup).
  function _appendCurve(out, samplePts) {
    var segs = fitCurve(samplePts, FIT_ERROR * FIT_ERROR);
    if (!segs.length) {
      var lp = samplePts[samplePts.length - 1];
      out.push({ x: lp[0], y: lp[1] });
      return;
    }
    for (var i = 0; i < segs.length; i++) {
      var b = segs[i];
      if (out.length) {
        var prev = out[out.length - 1];
        if (_almostEq(prev.x, prev.y, b[0][0], b[0][1], 1e-6)) {
          prev.ohx = b[1][0]; prev.ohy = b[1][1];
        } else {
          out.push({ x: b[0][0], y: b[0][1], ohx: b[1][0], ohy: b[1][1] });
        }
      } else {
        out.push({ x: b[0][0], y: b[0][1], ohx: b[1][0], ohy: b[1][1] });
      }
      out.push({ x: b[3][0], y: b[3][1], ihx: b[2][0], ihy: b[2][1] });
    }
  }

  function _appendLineEnd(out, pt) {
    if (out.length) {
      var prev = out[out.length - 1];
      if (_almostEq(prev.x, prev.y, pt[0], pt[1], 1e-6)) return;
    }
    out.push({ x: pt[0], y: pt[1] });
  }

  // One result ring (array of vertex arrays, cyclic, may be auto-closed) →
  // { points, closed:true } with corners preserved and curves smooth.
  function _reconstructRing(ring, meta) {
    // Drop the duplicated closing vertex if present.
    var pts = ring.slice();
    if (pts.length > 1 && equals(pts[0], pts[pts.length - 1])) pts.pop();
    var n = pts.length;
    if (n < 3) return null;

    // Per-vertex provenance + a robust per-edge (i → i+1) type/src via a
    // forward carry: original vertices set the current edge; intersection
    // vertices (no meta) inherit the edge they were cut into.
    var info = new Array(n);
    for (var i = 0; i < n; i++) info[i] = meta.get(pts[i]) || null;

    var edgeT = new Array(n), edgeS = new Array(n);
    var curT = null, curS = -1;
    // seed carry from the last original vertex before index 0
    for (var z = n - 1; z >= 0; z--) {
      if (info[z]) { curT = info[z].outT; curS = info[z].src; break; }
    }
    for (var e = 0; e < n; e++) {
      if (info[e]) { curT = info[e].outT; curS = info[e].src; }
      edgeT[e] = curT || 'L';
      edgeS[e] = curS;
    }

    // Sharp corner at vertex i: a boolean crossing (no provenance), an
    // original hard-corner anchor, or a source change with no recorded
    // crossing vertex.
    function cornerAt(i) {
      var im = info[i];
      if (!im) return true;
      if (im.anchor && im.hard) return true;
      var prevE = (i - 1 + n) % n;
      if (edgeS[prevE] !== edgeS[i] && edgeS[prevE] !== -1 && edgeS[i] !== -1) return true;
      return false;
    }
    // Fit boundary: every sharp corner PLUS every original anchor. Cutting
    // the fit at original anchors keeps the result's anchor count
    // proportional to the source geometry (an ellipse stays ~4 anchors,
    // not ~48) and keeps each fitted span within a single original edge.
    // Smooth anchors are not corners — the independently-fit spans meet
    // there with near-collinear tangents, so the join stays visually smooth.
    function boundaryAt(i) {
      if (cornerAt(i)) return true;
      var im = info[i];
      return !!(im && im.anchor);
    }

    var bnds = [];
    for (var c = 0; c < n; c++) if (boundaryAt(c)) bnds.push(c);

    var outPts;
    if (bnds.length === 0) {
      // Degenerate: no anchors/crossings at all — fit the whole loop.
      outPts = _emitRun(pts, edgeT, 0, n, true);
    } else {
      outPts = [];
      for (var k = 0; k < bnds.length; k++) {
        var a = bnds[k];
        var b = bnds[(k + 1) % bnds.length];
        var len = (b - a + n) % n; if (len === 0) len = n;
        var runOut = _emitRun(pts, edgeT, a, len, false);
        // Stitch: fold a leading anchor coincident with the previous
        // boundary into it (carrying the new out-handle) so the seam is
        // a single anchor — sharp or smooth as the geometry dictates.
        for (var ri = 0; ri < runOut.length; ri++) {
          if (ri === 0 && outPts.length) {
            var pv = outPts[outPts.length - 1], rv = runOut[0];
            if (_almostEq(pv.x, pv.y, rv.x, rv.y, 1e-6)) {
              if (rv.ohx !== undefined) { pv.ohx = rv.ohx; pv.ohy = rv.ohy; }
              continue;
            }
          }
          outPts.push(runOut[ri]);
        }
      }
      // Fold a trailing anchor equal to the first (ring is closed).
      if (outPts.length > 1) {
        var f = outPts[0], l = outPts[outPts.length - 1];
        if (_almostEq(f.x, f.y, l.x, l.y, 1e-6)) {
          if (l.ihx !== undefined) { f.ihx = l.ihx; f.ihy = l.ihy; }
          outPts.pop();
        }
      }
    }
    if (!outPts || outPts.length < 2) return null;
    return { points: outPts, closed: true };
  }

  // Emit `count` edges starting at vertex `startIdx` (cyclic). Splits the
  // span into maximal straight (L) and curved (C) sub-runs: L sub-runs
  // become exact line anchors, C sub-runs are Schneider-fit. `wholeCycle`
  // closes the loop back onto the start.
  function _emitRun(pts, edgeT, startIdx, count, wholeCycle) {
    var n = pts.length;
    var out = [];
    var i = 0;
    while (i < count) {
      var ei = (startIdx + i) % n;
      var type = edgeT[ei];
      var j = i;
      while (j < count && edgeT[(startIdx + j) % n] === type) j++;
      // sub-run covers edges [i, j) → vertices startIdx+i .. startIdx+j
      var vStart = (startIdx + i) % n;
      var vEnd = (startIdx + j) % n;
      if (type === 'L') {
        if (out.length === 0) {
          var sp = pts[vStart];
          out.push({ x: sp[0], y: sp[1] });
        }
        // collapse collinear interior vertices, keep direction changes
        var px = pts[vStart][0], py = pts[vStart][1];
        for (var kk = i + 1; kk <= j; kk++) {
          var vi = (startIdx + kk) % n;
          if (kk === j) { _appendLineEnd(out, pts[vEnd]); break; }
          var aPt = pts[vi];
          var prevA = out[out.length - 1];
          var d1 = _vec(prevA.x, prevA.y, aPt[0], aPt[1]);
          var nxt = pts[(startIdx + kk + 1) % n];
          var d2 = _vec(aPt[0], aPt[1], nxt[0], nxt[1]);
          if (d1[0] * d2[0] + d1[1] * d2[1] < 0.99995) _appendLineEnd(out, aPt);
        }
      } else {
        var sample = [];
        for (var m = i; m <= j; m++) {
          var vm = (startIdx + m) % n;
          sample.push([pts[vm][0], pts[vm][1]]);
        }
        if (out.length === 0) {
          out.push({ x: sample[0][0], y: sample[0][1] });
        }
        _appendCurve(out, sample);
      }
      i = j;
    }
    if (wholeCycle && out.length > 1) {
      // close the smooth loop onto the first anchor
      var f = out[0], l = out[out.length - 1];
      if (_almostEq(f.x, f.y, l.x, l.y, 1e-6)) {
        if (l.ihx !== undefined) { f.ihx = l.ihx; f.ihy = l.ihy; }
        out.pop();
      }
    }
    return out;
  }

  /* ═════ Orchestration ═════ */

  function _selectedShapes(layer) {
    if (!layer || !layer.shapeModel) return [];
    var ids = layer.shapeModel.selectedIds;
    if (!ids || !(ids instanceof Set)) return [];
    return layer.shapeModel.shapes.filter(function (s) { return ids.has(s.id); });
  }

  function _isClosedShape(s) {
    if (!s) return false;
    if (s.type === 'rect' || s.type === 'ellipse') return true;
    if (s.type === 'path') {
      if (s.subpaths && s.subpaths.length) {
        return s.subpaths.some(function (sp) { return sp.closed && sp.points && sp.points.length >= 2; });
      }
      return !!s.closed && s.points && s.points.length >= 2;
    }
    return false;
  }

  function eligible(layer) {
    return _selectedShapes(layer).filter(_isClosedShape);
  }
  function canCombine(layer) { return eligible(layer).length >= 2; }

  function _activeLayer() {
    var ST = root.ShapeTool;
    return (ST && typeof ST.getActiveLayer === 'function') ? ST.getActiveLayer() : null;
  }

  function _cloneStyle(src) {
    var st = src.stroke
      ? { type: src.stroke.type, color: src.stroke.color, width: src.stroke.width,
          cap: src.stroke.cap, join: src.stroke.join, align: src.stroke.align,
          dashPattern: src.stroke.dashPattern ? src.stroke.dashPattern.slice() : null,
          dashOffset: src.stroke.dashOffset || 0 }
      : { type: 'none' };
    var fl = src.fill ? { type: src.fill.type, color: src.fill.color }
                      : { type: 'solid', color: '#000' };
    return { fill: fl, stroke: st, opacity: src.opacity == null ? 1 : src.opacity };
  }

  function run(kind) {
    var layer = _activeLayer();
    if (!layer || !layer.shapeModel) return;
    var elig = eligible(layer);
    if (elig.length < 2) return;

    var arr = layer.shapeModel.shapes;
    var selSet = {};
    for (var i = 0; i < elig.length; i++) selSet[elig[i].id] = true;
    var ordered = arr.filter(function (s) { return selSet[s.id]; }); // back → front
    var frontmost = ordered[ordered.length - 1];
    var backmost = ordered[0];

    var meta = new Map();
    function polysOf(s, idx) { return _shapeToPolys(s, idx, meta); }

    var acc, styleSrc, op;
    if (kind === 'minus') {
      styleSrc = backmost;
      acc = polysOf(ordered[0], 0);
      for (var d = 1; d < ordered.length; d++) {
        acc = ringsToPolygons(clip(acc, polysOf(ordered[d], d), DIFFERENCE));
        if (!acc.length) break;
      }
    } else {
      op = (kind === 'unite') ? UNION
         : (kind === 'intersect') ? INTERSECTION
         : (kind === 'exclude') ? XOR : null;
      if (op === null) return;
      styleSrc = frontmost;
      acc = polysOf(ordered[0], 0);
      for (var u = 1; u < ordered.length; u++) {
        acc = ringsToPolygons(clip(acc, polysOf(ordered[u], u), op));
        if (!acc.length) break;
      }
    }

    // Reconstruct every result ring → subpaths (Option A).
    var subpaths = [];
    for (var p = 0; p < acc.length; p++) {
      for (var rr = 0; rr < acc[p].length; rr++) {
        var rec = _reconstructRing(acc[p][rr], meta);
        if (rec && rec.points.length >= 2) subpaths.push(rec);
      }
    }

    if (!subpaths.length) {
      // Empty geometry (e.g. intersect of disjoint shapes) — leave the
      // originals untouched rather than destroying the user's work.
      refresh();
      return;
    }

    // Illustrator-accurate placement: result takes the frontmost selected
    // shape's z-slot; originals are removed.
    var insertAt = 0;
    var frontIdx = arr.indexOf(frontmost);
    for (var fi = 0; fi < frontIdx; fi++) if (!selSet[arr[fi].id]) insertAt++;

    var style = _cloneStyle(styleSrc);
    var result = {
      id: layer.shapeModel.nextId++,
      type: 'path', rotation: 0,
      fill: style.fill, stroke: style.stroke, opacity: style.opacity,
      closed: true,
      points: subpaths[0].points
    };
    if (subpaths.length > 1) {
      result.subpaths = subpaths.map(function (sp) {
        return { points: sp.points, closed: true };
      });
    }

    layer.shapeModel.shapes = arr.filter(function (s) { return !selSet[s.id]; });
    layer.shapeModel.shapes.splice(insertAt, 0, result);

    var ST = root.ShapeTool;
    if (ST && typeof ST.selectShapes === 'function') {
      ST.selectShapes(layer, [result.id]);
    } else if (layer.shapeModel.selectedIds instanceof Set) {
      layer.shapeModel.selectedIds = new Set([result.id]);
    }

    if (typeof root.renderShapeLayer === 'function') root.renderShapeLayer(layer);
    if (typeof root.compositeAll === 'function') root.compositeAll();
    if (typeof root.updateLayerPanel === 'function') root.updateLayerPanel();
    refresh();
    if (typeof root.pushUndo === 'function') {
      var lbl = { unite: 'Unite', minus: 'Minus Front',
                  intersect: 'Intersect', exclude: 'Exclude' };
      root.pushUndo(lbl[kind] || 'Combine');
    }
  }

  /* ═════ Combine dropdown UI ═════ */

  var _wired = false;

  function refresh() {
    var menu = document.getElementById('shCombineMenu');
    if (!menu) return;
    var layer = _activeLayer();
    var dis = !canCombine(layer);
    var items = menu.querySelectorAll('[data-combine]');
    for (var i = 0; i < items.length; i++) {
      items[i].disabled = dis;
      items[i].classList.toggle('is-disabled', dis);
    }
  }

  function wire() {
    if (_wired) { refresh(); return; }
    var btn = document.getElementById('shCombineBtn');
    var menu = document.getElementById('shCombineMenu');
    if (!btn || !menu) return;
    _wired = true;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('is-open');
      if (menu.classList.contains('is-open')) refresh();
    });
    var items = menu.querySelectorAll('[data-combine]');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function (e) {
        e.stopPropagation();
        if (this.disabled) return;
        run(this.dataset.combine);
        menu.classList.remove('is-open');
      });
    }
    document.addEventListener('mousedown', function (e) {
      if (menu.classList.contains('is-open') &&
          !menu.contains(e.target) && e.target !== btn) {
        menu.classList.remove('is-open');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') menu.classList.remove('is-open');
    });
    refresh();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wire);
    } else {
      wire();
    }
  }

  root.OpsinCombine = {
    run: run,
    eligible: eligible,
    canCombine: canCombine,
    wire: wire,
    refresh: refresh
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      UNION: UNION, INTERSECTION: INTERSECTION,
      DIFFERENCE: DIFFERENCE, XOR: XOR,
      clip: clip, ringsToPolygons: ringsToPolygons, ringArea: ringArea,
      shapeToPolys: _shapeToPolys, reconstructRing: _reconstructRing
    };
  }

})(typeof window !== 'undefined' ? window : this);
