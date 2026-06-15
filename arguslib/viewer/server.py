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


def _parse_dt(raw: str) -> dt.datetime:
    try:
        return dt.datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        abort(400, f"Invalid datetime: {raw!r}")


def create_app() -> Flask:
    app = Flask(__name__)
    registry = InstrumentRegistry()
    frames = FrameService(registry)

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/api/instruments")
    def instruments():
        return jsonify(registry.list_instruments())

    @app.route("/api/instruments/<path:instrument_id>/timeindex")
    def timeindex(instrument_id):
        date = _parse_dt(request.args.get("date") + "T00:00:00").date()
        cam = registry.get(instrument_id)
        return jsonify(day_index(cam, date))

    @app.route("/api/frame")
    def frame():
        instrument_id = request.args.get("id")
        when = _parse_dt(request.args.get("t"))
        max_dim = int(request.args.get("max_dim", 1400))
        try:
            jpeg, meta = frames.get_jpeg(instrument_id, when, max_dim=max_dim)
        except FileNotFoundError as exc:
            abort(404, str(exc))
        resp = send_file(io.BytesIO(jpeg), mimetype="image/jpeg")
        resp.headers["X-Timestamp"] = meta["timestamp"]
        resp.headers["X-Full-Width"] = str(meta["full_width"])
        resp.headers["X-Full-Height"] = str(meta["full_height"])
        resp.headers["Access-Control-Expose-Headers"] = (
            "X-Timestamp, X-Full-Width, X-Full-Height"
        )
        return resp

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
