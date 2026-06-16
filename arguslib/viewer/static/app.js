"use strict";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");

// Current frame state. `full` are the calibration-pixel dimensions; clicks are
// mapped from canvas space back into them before being sent to the server.
const state = {
  img: null,
  full: { w: 0, h: 0 },
  marker: null, // {x, y} in full-res pixels
  frameTs: null, // true timestamp of the displayed frame
  tracks: [], // aircraft track overlay (full-res pixel polylines)
  selectedIcao: null,
  copyLatLon: null, // [lon, lat] backing the Copy button
  northUpDeg: 0, // canvas rotation (deg, CW) to put north at the top
  // Persisted selection (world position), re-projected across camera/image
  // changes: {kind:'point'|'flight', lon, lat, alt, icao?, type?, age?}.
  persist: null,
};

function setStatus(msg) { $("status").textContent = msg || ""; }

async function loadInstruments() {
  const resp = await fetch("/api/instruments");
  const list = await resp.json();
  const sel = $("instrument");
  sel.innerHTML = "";
  for (const inst of list) {
    const opt = document.createElement("option");
    opt.value = inst.id;
    opt.textContent = `${inst.label} (${inst.camera_type})`;
    sel.appendChild(opt);
  }
}

function currentDatetime() {
  const date = $("date").value;            // YYYY-MM-DD
  const secs = parseInt($("time").value, 10);
  const hh = String(Math.floor(secs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  $("time-readout").textContent = `${hh}:${mm}:${ss}`;
  return `${date}T${hh}:${mm}:${ss}`;
}

// Debounce rapid scrubbing (e.g. holding an arrow key) into one request once
// the time settles, and abort any in-flight frame request that a newer one
// supersedes — so the server never has a backlog of stale decodes to chew on.
let frameDebounce = null;
let frameAbort = null;
function scheduleFrame(delay = 120) {
  clearTimeout(frameDebounce);
  frameDebounce = setTimeout(loadFrame, delay);
}

let frameToken = 0;
async function loadFrame() {
  const id = $("instrument").value;
  const t = currentDatetime();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test($("date").value)) return;

  if (frameAbort) frameAbort.abort();
  frameAbort = new AbortController();
  const token = ++frameToken;
  setStatus("loading frame…");
  try {
    const resp = await fetch(
      `/api/frame?id=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}`,
      { signal: frameAbort.signal }
    );
    if (token !== frameToken) return; // a newer request superseded us
    if (!resp.ok) {
      // There's no frame here, so drop the stale image and fix rather than
      // leaving something clickable that would geolocate on the wrong frame.
      const body = await resp.json().catch(() => ({}));
      clearImage();
      clearReadout();
      setStatus(body.error || `no frame (HTTP ${resp.status})`);
      return;
    }
    state.full.w = parseInt(resp.headers.get("X-Full-Width"), 10);
    state.full.h = parseInt(resp.headers.get("X-Full-Height"), 10);
    state.northUpDeg = parseFloat(resp.headers.get("X-North-Up-Deg")) || 0;
    const ts = resp.headers.get("X-Timestamp");
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    if (token !== frameToken) return;
    state.img = bitmap;
    state.frameTs = ts;
    if (!state.persist) state.marker = null;
    state.tracks = []; // clear stale trails immediately on a new image
    drawCanvas();
    setStatus(`frame @ ${ts} UTC`);
    reprojectPersist(); // re-place the persisted point/flight on the new view
    loadTracks(); // fresh trails for this frame's true timestamp, if enabled
  } catch (err) {
    if (err.name === "AbortError") return; // superseded; not an error
    setStatus(`error: ${err}`);
  }
}

const rowHtml = (k, v) => `<tr><th>${k}</th><td class="mono">${v}</td></tr>`;
const setReadout = (rows) => { $("readout").innerHTML = rows.length ? `<table>${rows.join("")}</table>` : ""; };

// Clear the shared readout (point fix or aircraft) and the geolocated marker.
function clearReadout() {
  state.marker = null;
  state.copyLatLon = null;
  state.persist = null;
  state.selectedIcao = null;
  setReadout([]);
  $("warn").textContent = "";
  drawCanvas();
}

// Drop the current frame and blank the canvas.
function clearImage() {
  state.img = null;
  state.tracks = [];
  state.selectedIcao = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// Opacity for a waypoint of the given age (s): solid at the aircraft, fading
// with age but never below AGE_MIN_ALPHA so old trail stays visible.
const AGE_MIN_ALPHA = 0.3;
function alphaForAge(age, maxAge) {
  const a = 1 - (Math.min(age, maxAge) / maxAge) * (1 - AGE_MIN_ALPHA);
  return Math.max(AGE_MIN_ALPHA, a);
}

// Aircraft tracks are stored in full-res pixels; scale them to canvas pixels.
function drawTracks() {
  if (!state.tracks.length) return;
  const sx = canvas.width / state.full.w;
  const sy = canvas.height / state.full.h;
  // The canvas is drawn at the (downscaled) image resolution then shrunk by CSS,
  // so scale line widths to canvas px per display px to get the intended weight.
  const dpx = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
  const maxAge = (parseInt($("tlen").value, 10) || 30) * 60; // age fade reference
  for (const ac of state.tracks) {
    const selected = ac.icao === state.selectedIcao;
    const color = "#" + ac.icao; // ICAO24 hex doubles as a stable colour
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (selected ? 3.5 : 2) * dpx;
    // Stroke each sub-segment with its own age-based alpha so the trail fades
    // toward its older end.
    for (const seg of ac.segments) {
      for (let i = 0; i < seg.length - 1; i++) {
        const a = seg[i], b = seg[i + 1];
        ctx.globalAlpha = alphaForAge((a[2] + b[2]) / 2, maxAge);
        ctx.beginPath();
        ctx.moveTo(a[0] * sx, a[1] * sy);
        ctx.lineTo(b[0] * sx, b[1] * sy);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1; // current position is freshest -> full opacity
    if (ac.current) {
      ctx.beginPath();
      ctx.arc(ac.current[0] * sx, ac.current[1] * sy, (selected ? 6 : 4) * dpx, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// View rotation: when "North up" is on, rotate the whole canvas (image +
// annotations) about its centre. Clicks are inverse-rotated to map back.
const viewAngleRad = () =>
  ($("northup").checked ? state.northUpDeg * Math.PI / 180 : 0);

function unrotateCanvasPoint(cx, cy) {
  const a = viewAngleRad();
  if (!a) return [cx, cy];
  const ox = canvas.width / 2, oy = canvas.height / 2;
  const c = Math.cos(-a), s = Math.sin(-a), x = cx - ox, y = cy - oy;
  return [c * x - s * y + ox, s * x + c * y + oy];
}

function drawCanvas() {
  if (!state.img) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  canvas.width = state.img.width;
  canvas.height = state.img.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  const a = viewAngleRad();
  if (a) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(a);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  }
  ctx.drawImage(state.img, 0, 0);
  drawTracks();
  if (state.marker) {
    const x = state.marker.x * (canvas.width / state.full.w);
    const y = state.marker.y * (canvas.height / state.full.h);
    ctx.strokeStyle = "#ff5252";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, 2 * Math.PI);
    ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y);
    ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14);
    ctx.stroke();
  }
  ctx.restore();
}

async function geolocateAt(fullX, fullY) {
  const id = $("instrument").value;
  const altitude_km = parseFloat($("altitude").value);
  setStatus("geolocating…");
  const resp = await fetch("/api/geolocate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, px: fullX, py: fullY, altitude_km }),
  });
  const r = await resp.json();
  if (!r.ok) {
    // e.g. a ray that never reaches the assumed altitude: clear the point.
    clearReadout();
    setStatus(r.reason || "geolocation failed");
    return;
  }
  showFix(r);
  state.persist = { kind: "point", lon: r.lon, lat: r.lat, alt: r.alt_km };
  setStatus("");
}

// Point fix -> shared readout (units in km / degrees). Works for both the
// geolocate result and the project result (which omits back-proj error).
function showFix(r) {
  state.copyLatLon = [r.lon, r.lat];
  const rows = [
    rowHtml("lon", r.lon.toFixed(5)),
    rowHtml("lat", r.lat.toFixed(5)),
    rowHtml("alt", r.alt_km.toFixed(2) + " km"),
    rowHtml("elev", r.elevation_deg.toFixed(2) + "°"),
    rowHtml("azim", r.azimuth_deg.toFixed(2) + "°"),
    rowHtml("range", r.distance_km.toFixed(2) + " km"),
  ];
  if (r.pixel_error != null) rows.push(rowHtml("back-proj err", r.pixel_error.toFixed(2) + " px"));
  setReadout(rows);
  $("warn").textContent = r.calibration_frame_ok === false
    ? "⚠ this camera applies image flips/rotations; click mapping is not yet corrected for it."
    : "";
}

const aircraftEnabled = () => $("aircraft-toggle").checked;

// Fetch + overlay advected aircraft tracks for the displayed frame's timestamp.
let tracksToken = 0;
async function loadTracks() {
  if (!aircraftEnabled() || !state.frameTs || !state.img) {
    state.tracks = [];
    drawCanvas();
    return;
  }
  const id = $("instrument").value;
  const tlen = parseInt($("tlen").value, 10) * 60;
  const token = ++tracksToken;
  try {
    const resp = await fetch(
      `/api/tracks?id=${encodeURIComponent(id)}&t=${encodeURIComponent(state.frameTs)}&tlen=${tlen}`
    );
    const j = await resp.json();
    if (token !== tracksToken) return; // superseded
    if (!j.ok) {
      state.tracks = [];
      drawCanvas();
      setStatus(j.error || "no aircraft data");
      return;
    }
    state.tracks = j.aircraft || [];
    drawCanvas();
    setStatus(`${state.tracks.length} aircraft`);
  } catch (err) {
    setStatus(`tracks error: ${err}`);
  }
}

// Distance from (px,py) to segment a-b, plus the clamped projection fraction t.
function segDistT(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { dist: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

// Nearest aircraft whose track passes within `threshold` full-res px of (fx,fy).
// Returns the closest point on the track (full-res px) plus the interpolated
// age (s) and geographic position there. Null if no hit.
const lerp = (a, b, t) => a + (b - a) * t;
function hitTestTracks(fx, fy, threshold) {
  let best = null, bestD = threshold, hit = null;
  for (const ac of state.tracks) {
    for (const seg of ac.segments) {
      if (seg.length === 1) {
        const p = seg[0];
        const d = Math.hypot(fx - p[0], fy - p[1]);
        if (d < bestD) {
          bestD = d; best = ac;
          hit = { point: [p[0], p[1]], age: p[2], geo: { lon: p[3], lat: p[4], alt: p[5] } };
        }
        continue;
      }
      for (let i = 0; i < seg.length - 1; i++) {
        const a = seg[i], b = seg[i + 1];
        const { dist, t } = segDistT(fx, fy, a[0], a[1], b[0], b[1]);
        if (dist < bestD) {
          bestD = dist; best = ac;
          hit = {
            point: [lerp(a[0], b[0], t), lerp(a[1], b[1], t)],
            age: lerp(a[2], b[2], t),
            geo: { lon: lerp(a[3], b[3], t), lat: lerp(a[4], b[4], t), alt: lerp(a[5], b[5], t) },
          };
        }
      }
    }
  }
  return best ? { ac: best, ...hit } : null;
}

// Clicked trail point -> shared readout. Everything here describes the clicked
// point: lon/lat/alt (km / degrees) and age, plus the aircraft's identity.
function showAircraft(ac, age, geo) {
  const i = ac.info || {};
  state.copyLatLon = geo ? [geo.lon, geo.lat] : null;
  const rows = [rowHtml("icao", ac.icao)];
  if (i.atype) rows.push(rowHtml("type", i.atype));
  if (geo) {
    rows.push(rowHtml("lon", geo.lon.toFixed(5)));
    rows.push(rowHtml("lat", geo.lat.toFixed(5)));
    rows.push(rowHtml("alt", geo.alt.toFixed(2) + " km"));
  }
  if (age != null) rows.push(rowHtml("age here", (age / 60).toFixed(1) + " min"));
  setReadout(rows);
  $("warn").textContent = "";
}

// Re-place the persisted selection on the current camera/image: project its
// world position to a pixel for the marker, and rebuild the readout. Keeps the
// geolocation (point or flight) across camera/image changes.
async function reprojectPersist() {
  const p = state.persist;
  if (!p) return;
  const id = $("instrument").value;
  try {
    const resp = await fetch(
      `/api/project?id=${encodeURIComponent(id)}&lon=${p.lon}&lat=${p.lat}&alt=${p.alt}`
    );
    const j = await resp.json();
    if (!j.ok) return;
    state.marker = j.in_view ? { x: j.px, y: j.py } : null;
    if (p.kind === "flight") {
      state.selectedIcao = p.icao;
      showAircraft({ icao: p.icao, info: { atype: p.type } }, p.age,
        { lon: p.lon, lat: p.lat, alt: p.alt });
    } else {
      state.selectedIcao = null;
      showFix(j); // recomputes elev/azim/range for the new camera
    }
    drawCanvas();
  } catch { /* leave the existing readout */ }
}

canvas.addEventListener("click", (ev) => {
  if (!state.img) return;
  const rect = canvas.getBoundingClientRect();
  // CSS pixels -> canvas pixels -> full-res calibration pixels.
  let cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  let cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  [cx, cy] = unrotateCanvasPoint(cx, cy); // undo any north-up rotation
  const fullX = cx * (state.full.w / canvas.width);
  const fullY = cy * (state.full.h / canvas.height);

  // Prefer a flight-track hit (threshold ~8 CSS px in full-res units).
  if (state.tracks.length) {
    const hit = hitTestTracks(fullX, fullY, 8 * (state.full.w / rect.width));
    if (hit) {
      state.selectedIcao = hit.ac.icao;
      // Snap the geolocation marker to the clicked point on the track; drawn
      // after the tracks, so it sits on top.
      state.marker = { x: hit.point[0], y: hit.point[1] };
      state.persist = {
        kind: "flight", icao: hit.ac.icao, type: (hit.ac.info || {}).atype,
        lon: hit.geo.lon, lat: hit.geo.lat, alt: hit.geo.alt, age: hit.age,
      };
      showAircraft(hit.ac, hit.age, hit.geo);
      drawCanvas();
      return;
    }
  }

  // Otherwise geolocate the clicked point.
  state.selectedIcao = null;
  state.marker = { x: fullX, y: fullY };
  drawCanvas();
  geolocateAt(fullX, fullY);
});

$("copy").addEventListener("click", () => {
  if (state.copyLatLon) navigator.clipboard.writeText(state.copyLatLon.join(","));
});

$("northup").addEventListener("change", drawCanvas);
$("aircraft-toggle").addEventListener("change", loadTracks);
let tlenDebounce = null;
$("tlen").addEventListener("input", () => {
  $("tlen-readout").textContent = `${$("tlen").value} min`;
  if (!aircraftEnabled()) return;
  clearTimeout(tlenDebounce);
  tlenDebounce = setTimeout(loadTracks, 150);
});

const FULL_DAY = { min: 1, max: 86396 };
const secOfDay = (iso) => {
  const [h, m, s] = iso.slice(11, 19).split(":").map(Number);
  return h * 3600 + m * 60 + s;
};

// Bound the time slider to the day's actual first/last image times (UTC), and
// clamp the current value into range. Falls back to a full day when bounds are
// unavailable. Runs on instrument/date change (the server caches per day).
async function updateBounds() {
  const id = $("instrument").value;
  const date = $("date").value;
  const slider = $("time");
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

  let bounds = FULL_DAY;
  setStatus("checking image times…");
  try {
    const resp = await fetch(
      `/api/instruments/${encodeURIComponent(id)}/timeindex?date=${date}`
    );
    const idx = await resp.json();
    if (idx.start && idx.end) {
      bounds = { min: Math.max(1, secOfDay(idx.start)), max: secOfDay(idx.end) };
      setStatus(`data ${idx.start.slice(11, 19)}–${idx.end.slice(11, 19)} UTC`);
    } else {
      setStatus("no image-time bounds for this day");
    }
  } catch {
    /* leave full-day bounds */
  }
  slider.min = bounds.min;
  slider.max = bounds.max;
  slider.value = Math.min(Math.max(parseInt(slider.value, 10), bounds.min), bounds.max);
  currentDatetime();
}

$("instrument").addEventListener("change", async () => { await updateBounds(); scheduleFrame(0); });
$("date").addEventListener("change", async () => { await updateBounds(); scheduleFrame(0); });

// Keep the overlaid native picker seeded from whatever is typed, and sync the
// chosen ISO value back to the text field (preserving the YYYY-MM-DD format).
$("date").addEventListener("input", () => {
  if (/^\d{4}-\d{2}-\d{2}$/.test($("date").value)) $("date-native").value = $("date").value;
});
$("date-native").addEventListener("change", async () => {
  const v = $("date-native").value;
  if (v) { $("date").value = v; await updateBounds(); scheduleFrame(0); }
});
$("time").addEventListener("input", () => { currentDatetime(); scheduleFrame(); });
$("altitude").addEventListener("input", () => {
  $("alt-readout").textContent = parseFloat($("altitude").value).toFixed(1) + " km";
  // Re-geolocate the existing marker at the new altitude (no file read).
  if (state.marker) geolocateAt(state.marker.x, state.marker.y);
});

const DEFAULTS = { instrument: "COBALT:3-7", date: "2025-05-01" }; // time set in HTML

(async function init() {
  await loadInstruments();
  if ([...$("instrument").options].some((o) => o.value === DEFAULTS.instrument)) {
    $("instrument").value = DEFAULTS.instrument;
  }
  $("date").value = DEFAULTS.date;
  $("date-native").value = DEFAULTS.date;
  await updateBounds();
  loadFrame();
})();
