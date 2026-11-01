"""Command-line entry point: `qe-studio` starts the backend (and serves the built UI)."""

from __future__ import annotations

import argparse
import logging
import os
import threading
import webbrowser


def main() -> None:
    ap = argparse.ArgumentParser(prog="qe-studio", description="QE Studio — Quantum ESPRESSO workbench")
    ap.add_argument(
        "--host",
        default=os.environ.get("QES_HOST", "127.0.0.1"),
        help="bind address (default 127.0.0.1; only change this behind an authenticated proxy)",
    )
    ap.add_argument("--port", type=int, default=int(os.environ.get("QES_PORT", "8765")))
    ap.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    ap.add_argument("--log-level", default=os.environ.get("QES_LOG_LEVEL", "info"))
    ap.add_argument(
        "--disable-ai", action="store_true", help="hard-disable every AI feature (same as QES_AI_DISABLED=1)"
    )
    ap.add_argument("--print-token", action="store_true", help="print the API token (for scripts) and exit")
    args = ap.parse_args()
    if args.disable_ai:
        os.environ["QES_AI_DISABLED"] = "1"
    from .config import get_env

    env = get_env()
    if args.print_token:
        print(env.api_token())
        return
    if args.host not in ("127.0.0.1", "localhost", "::1") and not os.environ.get("QES_CONTAINER"):
        print(
            "WARNING: binding to a non-loopback address exposes the API (which can run commands on your "
            "connections) to the network. Only do this behind an authenticated reverse proxy, and add the "
            "public hostname to QES_ALLOWED_HOSTS."
        )
    import uvicorn

    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"QE Studio running at {url}  (data in {env.home})")
    uvicorn.run(
        "qestudio.main:factory",
        factory=True,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        ws_max_size=64 * 1024 * 1024,
        timeout_keep_alive=30,
    )


if __name__ == "__main__":
    main()
