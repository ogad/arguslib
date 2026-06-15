"""
Interactive viewer for arguslib.

A lightweight Flask + JS-canvas web app for browsing registered instruments,
scrubbing to a datetime, and clicking on the image to geolocate features.

Design principle: the only slow operations are unavoidable file reads (MP4
seek/decode). Everything interactive -- in particular pixel -> lon/lat
geolocation -- is pure numpy and touches no files, so clicks feel instant.

Run with::

    python -m arguslib.viewer            # serves on http://127.0.0.1:5000

or programmatically::

    from arguslib.viewer import create_app
    create_app().run()
"""

from .server import create_app

__all__ = ["create_app"]
