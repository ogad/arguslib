"""
Time index: which datetimes have data, for the scrubber.

Globs the day's video directory (via the camera's csat2 locator) and parses the
nominal timestamps out of the filenames -- a cheap directory listing. To bound
the slider it then decodes just the first frame of the earliest file and the
last frame of the latest file (via ``get_video_time_bounds``) to get the true
first/last image times, in the same UTC frame the slider and frame-fetch use.

Degrades gracefully (empty index, null bounds) when the data store is not
reachable, so the UI still loads.
"""

from __future__ import annotations

import datetime as dt
import os
import re
from contextlib import nullcontext
from typing import List, Tuple

_FILENAME_TIME = re.compile(r"_(\d{8})_(\d{6})_")


def _day_files(cam, date: dt.date) -> List[Tuple[dt.datetime, str]]:
    """Return sorted ``(nominal_dt, path)`` for non-empty videos on ``date``."""
    try:
        if cam.data_loader is None:
            cam.initialise_data_loader()
        loader = cam.data_loader
        files = loader.locator.search(
            "ARGUS",
            "video",
            campaign=loader.campaign,
            camstr=loader.camstr,
            year=date.year,
            mon=date.month,
            day=date.day,
            hour="**",
            min="**",
            second="**",
        )
    except Exception:
        return []

    entries: List[Tuple[dt.datetime, str]] = []
    for path in files:
        try:
            if os.path.getsize(path) <= 1000:  # skip the known ~258-byte empties
                continue
        except OSError:
            continue
        m = _FILENAME_TIME.search(os.path.basename(path))
        if not m:
            continue
        try:
            nominal = dt.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
        except ValueError:
            continue
        entries.append((nominal, path))

    entries.sort()
    return entries


def day_index(cam, date: dt.date, decode_lock=None) -> dict:
    """Return the scrubber index for ``date``.

    ``{"date", "nominal_times": [...iso...], "start": iso|None, "end": iso|None}``
    where ``start``/``end`` are the true first/last image times (UTC, naive) and
    ``nominal_times`` are the cheap per-file filename times. ``decode_lock``, if
    given, serializes the bounds probe with frame decodes for the same camera.
    """
    from ..camera.video import get_video_time_bounds

    entries = _day_files(cam, date)
    result = {
        "date": date.isoformat(),
        "nominal_times": [n.isoformat() for n, _ in entries],
        "start": None,
        "end": None,
    }
    if not entries:
        return result

    tz = getattr(cam, "timestamp_timezone", "UTC")
    first_path, last_path = entries[0][1], entries[-1][1]
    lock = decode_lock if decode_lock is not None else nullcontext()
    try:
        with lock:
            start = get_video_time_bounds(first_path, timestamp_timezone=tz)[0]
            end = get_video_time_bounds(last_path, timestamp_timezone=tz)[1]
        result["start"] = start.isoformat()
        result["end"] = end.isoformat()
    except Exception:
        # Corrupt/unreadable end files: leave bounds null; client falls back to
        # a full-day slider rather than failing.
        pass
    return result
