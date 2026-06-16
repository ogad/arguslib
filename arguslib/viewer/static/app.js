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
      clearFix();
      setStatus(body.error || `no frame (HTTP ${resp.status})`);
      return;
    }
    state.full.w = parseInt(resp.headers.get("X-Full-Width"), 10);
    state.full.h = parseInt(resp.headers.get("X-Full-Height"), 10);
    const ts = resp.headers.get("X-Timestamp");
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    if (token !== frameToken) return;
    state.img = bitmap;
    state.marker = null;
    state.frameTs = ts;
    drawCanvas();
    setStatus(`frame @ ${ts} UTC`);
    loadTracks(); // overlay aircraft for this frame's true timestamp, if enabled
  } catch (err) {
    if (err.name === "AbortError") return; // superseded; not an error
    setStatus(`error: ${err}`);
  }
}

const READOUT_CELLS = ["r-lon", "r-lat", "r-alt", "r-elev", "r-azim", "r-range", "r-err"];

// Clear the geolocated point: marker, readout cells and any warning.
function clearFix() {
  state.marker = null;
  for (const id of READOUT_CELLS) $(id).textContent = "—";
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

// Aircraft tracks are stored in full-res pixels; scale them to canvas pixels.
function drawTracks() {
  const sx = canvas.width / state.full.w;
  const sy = canvas.height / state.full.h;
  for (const ac of state.tracks) {
    const selected = ac.icao === state.selectedIcao;
    const color = "#" + ac.icao; // ICAO24 hex doubles as a stable colour
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.globalAlpha = selected ? 1 : 0.8;
    for (const seg of ac.segments) {
      ctx.beginPath();
      seg.forEach((p, i) => {
        const x = p[0] * sx, y = p[1] * sy;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    if (ac.current) {
      ctx.beginPath();
      ctx.arc(ac.current[0] * sx, ac.current[1] * sy, selected ? 5 : 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawCanvas() {
  if (!state.img) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  canvas.width = state.img.width;
  canvas.height = state.img.height;
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
    clearFix();
    setStatus(r.reason || "geolocation failed");
    return;
  }
  $("warn").textContent = "";
  $("r-lon").textContent = r.lon.toFixed(5);
  $("r-lat").textContent = r.lat.toFixed(5);
  $("r-alt").textContent = r.alt_km.toFixed(2) + " km";
  $("r-elev").textContent = r.elevation_deg.toFixed(2) + "°";
  $("r-azim").textContent = r.azimuth_deg.toFixed(2) + "°";
  $("r-range").textContent = r.distance_km.toFixed(2) + " km";
  $("r-err").textContent = r.pixel_error.toFixed(2) + " px";
  if (!r.calibration_frame_ok) {
    $("warn").textContent =
      "⚠ this camera applies image flips/rotations; click mapping is not yet corrected for it.";
  }
  setStatus("");
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

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Nearest aircraft whose track passes within `threshold` full-res px of (fx,fy).
function hitTestTracks(fx, fy, threshold) {
  let best = null, bestD = threshold;
  for (const ac of state.tracks) {
    for (const seg of ac.segments) {
      if (seg.length === 1) {
        const d = Math.hypot(fx - seg[0][0], fy - seg[0][1]);
        if (d < bestD) { bestD = d; best = ac; }
        continue;
      }
      for (let i = 0; i < seg.length - 1; i++) {
        const d = distToSegment(fx, fy, seg[i][0], seg[i][1], seg[i + 1][0], seg[i + 1][1]);
        if (d < bestD) { bestD = d; best = ac; }
      }
    }
  }
  return best;
}

const INFO_FIELDS = [
  ["atype", "type", (v) => v],
  ["alt_geom", "alt", (v) => v.toFixed(0) + " ft"],
  ["gs", "g/s", (v) => v.toFixed(0) + " kt"],
  ["track", "track", (v) => v.toFixed(0) + "°"],
  ["oat", "OAT", (v) => v.toFixed(1) + " °C"],
];
function showAircraft(ac) {
  const info = ac.info || {};
  const rows = [`<tr><th>icao</th><td class="mono">${ac.icao}</td></tr>`];
  for (const [key, label, fmt] of INFO_FIELDS) {
    const v = info[key];
    if (v === undefined || v === null || v === "") continue;
    rows.push(`<tr><th>${label}</th><td class="mono">${typeof v === "number" ? fmt(v) : v}</td></tr>`);
  }
  $("aircraft-info").innerHTML = "<h2>Aircraft</h2><table>" + rows.join("") + "</table>";
}

canvas.addEventListener("click", (ev) => {
  if (!state.img) return;
  const rect = canvas.getBoundingClientRect();
  // CSS pixels -> canvas pixels -> full-res calibration pixels.
  const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const fullX = cx * (state.full.w / canvas.width);
  const fullY = cy * (state.full.h / canvas.height);

  // Prefer a flight-track hit (threshold ~8 CSS px in full-res units).
  if (state.tracks.length) {
    const ac = hitTestTracks(fullX, fullY, 8 * (state.full.w / rect.width));
    if (ac) {
      state.selectedIcao = ac.icao;
      state.marker = null;
      showAircraft(ac);
      drawCanvas();
      return;
    }
  }

  // Otherwise geolocate the clicked point.
  state.selectedIcao = null;
  $("aircraft-info").innerHTML = "";
  state.marker = { x: fullX, y: fullY };
  drawCanvas();
  geolocateAt(fullX, fullY);
});

$("copy").addEventListener("click", () => {
  const lon = $("r-lon").textContent, lat = $("r-lat").textContent;
  if (lon !== "—") navigator.clipboard.writeText(`${lon},${lat}`);
});

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
