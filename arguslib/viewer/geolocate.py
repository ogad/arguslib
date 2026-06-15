"""
Stateless pixel -> lon/lat geolocation for the viewer.

This is the "instant" tier: given a camera, a pixel, and an assumed altitude (or
slant distance), return a geographic Position. It performs no file I/O -- only
the vectorized numpy projection math in ``Camera.pix_to_iead`` /
``Instrument.iead_to_lla`` -- so it is safe to call on every click.
"""

from __future__ import annotations

from typing import Optional

import numpy as np


def _loader_transform_is_identity(cam) -> bool:
    """True if the served frame is in the camera's calibration pixel frame.

    ``CameraData`` may apply ``invert_axes`` / ``manual_rotations`` to the loaded
    image, which would move the displayed pixels out of the frame that
    ``intrinsic`` is calibrated in. When that happens a raw click can't be fed
    straight into ``pix_to_iead`` without first inverting those transforms (not
    yet implemented), so we flag it rather than return a silently-wrong fix.
    """
    invert = getattr(cam, "_invert_axes", [False, False])
    rot = getattr(cam, "_manual_rotation_90degs", 0)
    return not (invert[0] or invert[1]) and rot == 0


def geolocate_pixel(
    cam,
    px: float,
    py: float,
    altitude_km: Optional[float] = None,
    distance_km: Optional[float] = None,
) -> dict:
    """Geolocate a full-resolution pixel ``(px, py)`` on camera ``cam``.

    Exactly one of ``altitude_km`` (assume the feature sits at this height) or
    ``distance_km`` (assume this slant range) must be given.

    Returns a dict with the resulting lon/lat/alt, the instrument-relative
    elevation/azimuth/distance, and the back-projected pixel error (a cheap
    self-consistency check that should be sub-pixel for a valid fix).
    """
    if (altitude_km is None) == (distance_km is None):
        raise ValueError("Specify exactly one of altitude_km or distance_km")

    ead = cam.pix_to_iead(
        float(px), float(py), altitude=altitude_km, distance=distance_km
    )

    elevation, azimuth, dist = (float(v) for v in ead)
    if not np.all(np.isfinite(ead)):
        # e.g. a ray that never reaches the requested altitude (points at/above
        # the horizon for a finite cloud height).
        return {
            "ok": False,
            "reason": "pixel does not intersect the requested surface",
            "px": px,
            "py": py,
        }

    pos = cam.iead_to_lla(elevation, azimuth, dist)

    # Self-consistency: project the fix back to a pixel; should land on the click.
    back = cam.target_pix(pos)
    pixel_error = float(np.hypot(back[0] - px, back[1] - py))

    return {
        "ok": True,
        "lon": float(pos.lon),
        "lat": float(pos.lat),
        "alt_km": float(pos.alt),
        "elevation_deg": elevation,
        "azimuth_deg": azimuth % 360.0,
        "distance_km": dist,
        "pixel_error": pixel_error,
        "calibration_frame_ok": _loader_transform_is_identity(cam),
    }
