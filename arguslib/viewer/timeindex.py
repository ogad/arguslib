"""
Time index: which datetimes have data, for the scrubber.

Globs the day's video directory (via the camera's csat2 locator) and parses the
nominal timestamps out of the filenames -- a cheap directory listing, with no
frame decoding. Degrades gracefully to an empty index when the data store is
not reachable, so the UI still loads.
"""

from __future__ import annotations

import datetime as dt
import os
import re
from typing import List

_FILENAME_TIME = re.compile(r"_(\d{8})_(\d{6})_")


def day_index(cam, date: dt.date) -> dict:
    """Return ``{"date", "nominal_times": [...iso...]}`` for ``date``.

    ``nominal_times`` are the per-file start times advertised by the filenames,
    sorted. Empty if the data store can't be reached or has no data that day.
    """
    times: List[dt.datetime] = []
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
        files = []

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
            times.append(dt.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S"))
        except ValueError:
            continue

    times.sort()
    return {
        "date": date.isoformat(),
        "nominal_times": [t.isoformat() for t in times],
    }
