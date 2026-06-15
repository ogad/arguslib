"""Entry point: ``python -m arguslib.viewer``."""

import argparse

from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="arguslib interactive viewer")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    create_app().run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
