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
    drawCanvas();
    setStatus(`frame @ ${ts} UTC`);
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
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawCanvas() {
  if (!state.img) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  canvas.width = state.img.width;
  canvas.height = state.img.height;
  ctx.drawImage(state.img, 0, 0);
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

canvas.addEventListener("click", (ev) => {
  if (!state.img) return;
  const rect = canvas.getBoundingClientRect();
  // CSS pixels -> canvas pixels -> full-res calibration pixels.
  const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const fullX = cx * (state.full.w / canvas.width);
  const fullY = cy * (state.full.h / canvas.height);
  state.marker = { x: fullX, y: fullY };
  drawCanvas();
  geolocateAt(fullX, fullY);
});

$("copy").addEventListener("click", () => {
  const lon = $("r-lon").textContent, lat = $("r-lat").textContent;
  if (lon !== "—") navigator.clipboard.writeText(`${lon},${lat}`);
});

$("instrument").addEventListener("change", () => scheduleFrame(0));
$("date").addEventListener("change", () => scheduleFrame(0));
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
  currentDatetime();
  loadFrame();
})();
