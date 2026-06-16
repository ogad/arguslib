"""
Aircraft track overlay: advected ADS-B trails as clickable vector geometry.

Loads a day's ADS-B fleet (once -- the Fleet caches by loaded file, and the
fleet is shared across cameras) and projects each aircraft's advected trail to
camera pixels, returning polylines + per-aircraft metadata as JSON. The
frontend draws these over the image and hit-tests clicks, so tracks stay crisp
and clickable with no matplotlib in the loop.

First version uses "aircraft" advection winds with a wind_filter of 10 and does
not load ERA5 winds, keeping it fast and dependency-light.
"""

from __future__ import annotations

import datetime as dt
from threading import Lock

import numpy as np

WIND_MODE = "aircraft"
WIND_FILTER = 10
MAX_RANGE_KM = 90
_MISSING = -9999999  # Fleet's jsonfloat sentinel for NaN


class TrackService:
    def __init__(self, registry):
        self.registry = registry
        self._ai = None  # shared AircraftInterface (holds the day's Fleet)
        self._lock = Lock()

    def tracks(self, instrument_id: str, when: dt.datetime, tlen: int = 1800) -> list:
        """Projected, advected aircraft trails visible from ``instrument_id`` at
        ``when``. ``tlen`` is the advection length in seconds.

        Raises ``FileNotFoundError`` if there's no ADS-B data for that day.
        """
        cam = self.registry.get(instrument_id)
        # Serialize: Fleet load/state isn't thread-safe, and this keeps the daily
        # file read from racing concurrent requests.
        with self._lock:
            ai = self._interface(cam)
            ai.camera = cam  # reuse the shared fleet across instruments
            ai.load_flight_data(when, load_era5_winds=False)
            trails = ai.get_trail_positions(
                when, tlen=tlen, wind_filter=WIND_FILTER, winds=WIND_MODE
            )
            fleet = ai.fleet

            out = []
            for icao, (positions, _ages) in trails.items():
                segments, current = self._project(cam, positions)
                if not segments:
                    continue
                out.append(
                    {
                        "icao": icao,
                        "segments": segments,
                        "current": current,
                        "info": self._info(fleet, icao, when),
                    }
                )
        return out

    def _interface(self, cam):
        if self._ai is None:
            from ..aircraft import AircraftInterface

            self._ai = AircraftInterface(cam)
        return self._ai

    @staticmethod
    def _project(cam, positions):
        """Project trail Positions to full-res pixels, returning contiguous
        visible polyline segments and the current-position pixel (if visible)."""
        ieads = cam.target_iead(positions)  # (N,3): elev-from-axis, azim, dist
        if ieads.ndim == 1:
            ieads = ieads.reshape(1, -1)
        pix = cam.iead_to_pix(ieads[:, 0], ieads[:, 1], ieads[:, 2])  # (N,2)
        pix = np.atleast_2d(pix)

        visible = (
            np.isfinite(pix[:, 0])
            & np.isfinite(pix[:, 1])
            & (ieads[:, 0] <= 90)  # not behind the camera
            & (ieads[:, 2] < MAX_RANGE_KM)  # within range
        )

        # Split at gaps so we don't draw a line across the image where the trail
        # dips behind the camera or out of range.
        segments, run = [], []
        for i, vis in enumerate(visible):
            if vis:
                run.append([round(float(pix[i, 0]), 1), round(float(pix[i, 1]), 1)])
            elif run:
                segments.append(run)
                run = []
        if run:
            segments.append(run)

        current = segments[-1][-1] if (len(visible) and visible[-1]) else None
        return segments, current

    @staticmethod
    def _info(fleet, icao, when):
        try:
            data = fleet.aircraft[icao].get_current(when)
        except Exception:
            return {"icao": icao}
        info = {"icao": icao}
        for k, v in data.items():
            if isinstance(v, float) and (v == _MISSING or not np.isfinite(v)):
                continue
            info[k] = v
        return info
