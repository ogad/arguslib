"""
Instrument registry for the viewer.

Enumerates selectable instruments from the existing config files and builds the
underlying ``Camera`` objects lazily, caching them so that expensive one-time
setup (e.g. undistortion remap arrays) happens only once per process.
"""

from __future__ import annotations

from threading import Lock
from typing import Dict, List, Optional

from ..config import load_config, list_cameras


def _camera_id(campaign: str, camstr: str) -> str:
    return f"{campaign}:{camstr}"


class InstrumentRegistry:
    """Lazily builds and caches instruments selectable in the viewer.

    Phase 1 exposes single cameras only (the unit that supports
    click-to-geolocate). Arrays / radar overlays are intended to slot in here
    later behind the same ``list_instruments`` / ``get`` interface.
    """

    def __init__(self):
        self._cameras: Dict[str, object] = {}
        self._lock = Lock()
        self._catalogue: Optional[List[dict]] = None

    def list_instruments(self) -> List[dict]:
        """Return metadata for every selectable instrument (no file reads)."""
        if self._catalogue is not None:
            return self._catalogue

        try:
            cameras_cfg = load_config("cameras.yml")
        except FileNotFoundError:
            cameras_cfg = {}

        catalogue: List[dict] = []
        for campaign, camstr in list_cameras():
            # Skip placeholder/template entries that aren't real instruments.
            if camstr == "default":
                continue
            cam_cfg = cameras_cfg.get(campaign, {}).get(camstr, {})
            catalogue.append(
                {
                    "id": _camera_id(campaign, camstr),
                    "kind": "camera",
                    "campaign": campaign,
                    "camstr": camstr,
                    "camera_type": cam_cfg.get("camera_type", "allsky"),
                    "label": f"{campaign} {camstr}",
                }
            )
        self._catalogue = catalogue
        return catalogue

    def get(self, instrument_id: str):
        """Return the (cached) Camera for ``instrument_id`` (e.g. 'COBALT:3-7')."""
        with self._lock:
            cam = self._cameras.get(instrument_id)
            if cam is not None:
                return cam

            from ..camera.camera import Camera

            try:
                campaign, camstr = instrument_id.split(":", 1)
            except ValueError as exc:
                raise KeyError(f"Malformed instrument id {instrument_id!r}") from exc

            cam = Camera.from_config(campaign, camstr)
            self._cameras[instrument_id] = cam
            return cam
