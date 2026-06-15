"""
Frame service: the "slow" tier.

Decodes a camera frame for a requested datetime and returns a JPEG suitable for
the browser. Decoded+encoded frames are kept in a small LRU cache so that
re-requesting a timestamp (scrubbing back and forth, or geolocating after a
frame is shown) is free. The underlying ``CameraData`` already caches the open
video capture per file, so the dominant cost is the H.264 seek+decode itself.
"""

from __future__ import annotations

import datetime as dt
from collections import OrderedDict
from threading import Lock
from typing import Optional, Tuple


def _round_to_resolution(when: dt.datetime, resolution_s: int = 5) -> dt.datetime:
    """Snap to the native camera cadence so nearby requests share a cache slot."""
    epoch = when.replace(microsecond=0)
    secs = epoch.hour * 3600 + epoch.minute * 60 + epoch.second
    snapped = round(secs / resolution_s) * resolution_s
    return epoch.replace(hour=0, minute=0, second=0) + dt.timedelta(seconds=snapped)


class FrameService:
    def __init__(self, registry, max_cache: int = 64):
        self.registry = registry
        self.max_cache = max_cache
        self._cache: "OrderedDict[tuple, Tuple[bytes, dict]]" = OrderedDict()
        self._lock = Lock()

    def get_jpeg(
        self,
        instrument_id: str,
        when: dt.datetime,
        max_dim: int = 1400,
        quality: int = 80,
    ) -> Tuple[bytes, dict]:
        """Return ``(jpeg_bytes, meta)`` for the frame nearest ``when``.

        ``meta`` carries the full-resolution dimensions (so the client can map a
        click back to calibration pixels) and the decoded frame's true
        timestamp. Raises ``FileNotFoundError`` if no frame is available.
        """
        key = (instrument_id, _round_to_resolution(when), max_dim, quality)
        with self._lock:
            hit = self._cache.get(key)
            if hit is not None:
                self._cache.move_to_end(key)
                return hit

        jpeg, meta = self._render(instrument_id, when, max_dim, quality)

        with self._lock:
            self._cache[key] = (jpeg, meta)
            self._cache.move_to_end(key)
            while len(self._cache) > self.max_cache:
                self._cache.popitem(last=False)
        return jpeg, meta

    def _render(self, instrument_id, when, max_dim, quality):
        import cv2
        import numpy as np

        cam = self.registry.get(instrument_id)
        img, timestamp = cam.get_data_time(when, return_timestamp=True)  # BGR uint8
        img = np.ascontiguousarray(img)
        full_h, full_w = img.shape[:2]

        scale = min(1.0, max_dim / max(full_h, full_w))
        if scale < 1.0:
            img = cv2.resize(
                img,
                (round(full_w * scale), round(full_h * scale)),
                interpolation=cv2.INTER_AREA,
            )

        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            raise RuntimeError("JPEG encoding failed")

        meta = {
            "timestamp": timestamp.isoformat(),
            "full_width": int(full_w),
            "full_height": int(full_h),
            "served_width": int(img.shape[1]),
            "served_height": int(img.shape[0]),
        }
        return buf.tobytes(), meta
