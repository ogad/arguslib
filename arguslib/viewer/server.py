"""
Flask app wiring the viewer together.

Routes:
    GET  /                               -> the single-page UI
    GET  /api/instruments                -> selectable instruments
    GET  /api/instruments/<id>/timeindex -> nominal times with data on a date
    GET  /api/frame                      -> JPEG of the frame nearest a datetime
    POST /api/geolocate                  -> lon/lat for a clicked pixel
"""

from __future__ import annotations

# Force a headless backend before arguslib pulls matplotlib in. This also dodges
# a broken interactive backend in the user's matplotlibrc.
import matplotlib

matplotlib.use("Agg")

import datetime as dt

from flask import Flask, abort, jsonify, request, send_file, render_template
import io

from .registry import InstrumentRegistry
from .frames import FrameService
from .geolocate import geolocate_pixel
from .timeindex import day_index
from .tracks import TrackService


def _parse_dt(raw: str) -> dt.datetime:
    try:
        return dt.datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        abort(400, f"Invalid datetime: {raw!r}")


def north_up_angle(cam) -> float:
    """Degrees to rotate the canvas clockwise to bring geographic north to the
    top, from where a due-north point projects relative to the image centre.
    Handedness-proof (uses the actual projection); 0.0 if it can't be computed.
    """
    import numpy as np

    try:
        w, h = float(cam.image_size_px[0]), float(cam.image_size_px[1])
        north = cam.position.ead_to_lla(45.0, 0.0, 10.0)  # a point due north
        px = np.asarray(cam.target_pix(north)).ravel()
        dx, dy = px[0] - w / 2.0, px[1] - h / 2.0
        ang = np.degrees(np.arctan2(dx, -dy))  # north's screen angle, CW from up
        return round(-float(ang), 2)  # rotate content by -ang to bring N to top
    except Exception:
        return 0.0


def create_app() -> Flask:
    app = Flask(__name__)
    registry = InstrumentRegistry()
    frames = FrameService(registry)
    track_service = TrackService(registry)

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/api/instruments")
    def instruments():
        return jsonify(registry.list_instruments())

    timeindex_cache = {}

    @app.route("/api/instruments/<path:instrument_id>/timeindex")
    def timeindex(instrument_id):
        date = _parse_dt(request.args.get("date") + "T00:00:00").date()
        key = (instrument_id, date.isoformat())
        cached = timeindex_cache.get(key)
        if cached is None:
            cam = registry.get(instrument_id)
            cached = day_index(
                cam, date, decode_lock=frames.decode_lock(instrument_id)
            )
            timeindex_cache[key] = cached
        return jsonify(cached)

    @app.route("/api/frame")
    def frame():
        instrument_id = request.args.get("id")
        when = _parse_dt(request.args.get("t"))
        max_dim = int(request.args.get("max_dim", 1400))
        try:
            jpeg, meta = frames.get_jpeg(instrument_id, when, max_dim=max_dim)
        except FileNotFoundError as exc:
            # JSON (not Flask's HTML error page) so the client can show a clean
            # message instead of dumping raw markup into the status bar.
            return jsonify({"ok": False, "error": str(exc)}), 404
        resp = send_file(io.BytesIO(jpeg), mimetype="image/jpeg")
        resp.headers["X-Timestamp"] = meta["timestamp"]
        resp.headers["X-Full-Width"] = str(meta["full_width"])
        resp.headers["X-Full-Height"] = str(meta["full_height"])
        resp.headers["X-North-Up-Deg"] = str(north_up_angle(registry.get(instrument_id)))
        resp.headers["Access-Control-Expose-Headers"] = (
            "X-Timestamp, X-Full-Width, X-Full-Height, X-North-Up-Deg"
        )
        return resp

    @app.route("/api/tracks")
    def tracks():
        instrument_id = request.args.get("id")
        when = _parse_dt(request.args.get("t"))
        tlen = int(request.args.get("tlen", 1800))
        try:
            aircraft = track_service.tracks(instrument_id, when, tlen=tlen)
        except FileNotFoundError as exc:
            return jsonify({"ok": False, "error": str(exc), "aircraft": []}), 404
        return jsonify({"ok": True, "aircraft": aircraft})

    @app.route("/api/geolocate", methods=["POST"])
    def geolocate():
        body = request.get_json(force=True)
        cam = registry.get(body["id"])
        result = geolocate_pixel(
            cam,
            px=float(body["px"]),
            py=float(body["py"]),
            altitude_km=body.get("altitude_km"),
            distance_km=body.get("distance_km"),
        )
        return jsonify(result)

    return app
