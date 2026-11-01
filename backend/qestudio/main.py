"""FastAPI application factory."""

from __future__ import annotations

import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import orjson
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from . import __version__
from .config import get_env
from .db import init_db

log = logging.getLogger("qestudio")


class FastJSON(JSONResponse):
    media_type = "application/json"

    def render(self, content: Any) -> bytes:
        return orjson.dumps(content, option=orjson.OPT_SERIALIZE_NUMPY | orjson.OPT_NON_STR_KEYS | orjson.OPT_NAIVE_UTC)


class GuardMiddleware:
    """Host-header allow-list (DNS rebinding) + per-install token on every /api request."""

    def __init__(self, app: ASGIApp, token: str, hosts: list[str], require_token: bool):
        self.app = app
        self.token = token
        self.hosts = {h.lower() for h in hosts}
        self.require_token = require_token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        host = headers.get("host", "").lower()
        hostname = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        if self.hosts and hostname not in self.hosts and "*" not in self.hosts:
            await self._deny(scope, send, 400, f"host '{hostname}' not allowed (set QES_ALLOWED_HOSTS)")
            return
        path: str = scope.get("path", "")
        if self.require_token and path.startswith("/api/") and path != "/api/health":
            tok = headers.get("x-qes-token")
            if not tok and scope["type"] == "websocket":
                # browsers cannot set headers on WebSockets: the token comes as subprotocol "token.<value>"
                for offered in headers.get("sec-websocket-protocol", "").split(","):
                    proto = offered.strip()
                    if proto.startswith("token."):
                        tok = proto[len("token.") :]
            if not tok:
                qs = parse_qs(scope.get("query_string", b"").decode())
                tok = (qs.get("token") or [None])[0]
            if not tok or not secrets.compare_digest(tok, self.token):
                await self._deny(scope, send, 401, "missing or invalid API token")
                return
        await self.app(scope, receive, send)

    async def _deny(self, scope: Scope, send: Send, code: int, msg: str) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4000 + code})
            return
        body = orjson.dumps({"detail": msg})
        await send(
            {
                "type": "http.response.start",
                "status": code,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})


def _static_dir() -> Path | None:
    env = get_env()
    cands = [env.static_dir] if env.static_dir else []
    here = Path(__file__).resolve()
    cands += [here.parent / "static", here.parents[2] / "frontend" / "dist"]
    for c in cands:
        if c and (Path(c) / "index.html").exists():
            return Path(c)
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .connections import close_all, ensure_local_connection, init_pool
    from .jobs.manager import manager

    init_db()
    init_pool()
    ensure_local_connection()
    await manager.start()
    log.info("QE Studio %s ready (data: %s)", __version__, get_env().home)
    try:
        yield
    finally:
        await manager.stop()
        await close_all()


def create_app() -> FastAPI:
    env = get_env()
    token = env.api_token()
    app = FastAPI(
        title="QE Studio API",
        version=__version__,
        lifespan=lifespan,
        default_response_class=FastJSON,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )

    from .api import ai, analysis, connections, documents, jobs, meta, pseudos, qe, structures, tasks

    for r in (
        meta.router,
        structures.router,
        qe.router,
        documents.router,
        pseudos.router,
        connections.router,
        jobs.router,
        analysis.router,
        ai.router,
        tasks.router,
    ):
        app.include_router(r)

    @app.exception_handler(RequestValidationError)
    async def _val(_req: Request, exc: RequestValidationError):
        errs = exc.errors()
        msg = "; ".join(f"{'.'.join(str(x) for x in e.get('loc', [])[1:])}: {e.get('msg')}" for e in errs[:5])
        return FastJSON({"detail": msg or "invalid request", "errors": errs[:20]}, status_code=422)

    static = _static_dir()
    if static is not None:
        if (static / "assets").exists():
            app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

        def _index() -> HTMLResponse:
            # read per request (a few kB): a rebuilt UI is picked up without restarting the backend
            html = (static / "index.html").read_text().replace("__QES_TOKEN__", token)
            return HTMLResponse(
                html,
                headers={
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Referrer-Policy": "no-referrer",
                },
            )

        @app.get("/", include_in_schema=False)
        async def root() -> HTMLResponse:
            return _index()

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str) -> Response:
            if path.startswith("api/"):
                return FastJSON({"detail": "not found"}, status_code=404)
            f = (static / path).resolve()
            if f.is_file() and str(f).startswith(str(static.resolve())):
                return FileResponse(f)
            return _index()
    else:

        @app.get("/", include_in_schema=False)
        async def no_ui() -> HTMLResponse:
            return HTMLResponse(
                "<h3>QE Studio API is running.</h3><p>The web UI is not built. Run "
                "<code>npm run build</code> in <code>frontend/</code> or use the dev server.</p>"
                "<p>API docs: <a href='/api/docs'>/api/docs</a></p>"
            )

    app.add_middleware(GuardMiddleware, token=token, hosts=env.hosts(), require_token=env.auth)
    return app


def factory() -> FastAPI:
    """uvicorn --factory qestudio.main:factory"""
    return create_app()
