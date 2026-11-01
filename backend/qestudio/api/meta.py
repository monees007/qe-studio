"""Health, meta information and settings."""

from __future__ import annotations

import platform
import sys
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from .. import __version__
from ..config import get_env
from ..secrets_store import set_secret
from ..settings import AppSettings, load_settings, save_settings, settings_out

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "version": __version__}


@router.get("/meta")
async def meta() -> dict[str, Any]:
    s = settings_out()
    return {
        "version": __version__,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "home": str(get_env().home),
        "ai": {
            "available": s.ai_available,
            "enabled": s.ai_enabled,
            "hard_disabled": s.ai_hard_disabled,
            "configured": s.has_anthropic_key,
            "model": s.ai_model,
        },
    }


@router.get("/settings")
async def get_settings():
    return settings_out()


@router.put("/settings")
async def put_settings(body: dict[str, Any]):
    cur = load_settings().model_dump()
    cur.update({k: v for k, v in body.items() if k in AppSettings.model_fields})
    save_settings(AppSettings.model_validate(cur))
    return settings_out()


class SecretsIn(BaseModel):
    anthropic_api_key: str | None = None
    mp_api_key: str | None = None


@router.put("/settings/secrets")
async def put_secrets(body: SecretsIn):
    if body.anthropic_api_key is not None:
        set_secret("anthropic_api_key", body.anthropic_api_key.strip() or None)
    if body.mp_api_key is not None:
        set_secret("mp_api_key", body.mp_api_key.strip() or None)
    return settings_out()
