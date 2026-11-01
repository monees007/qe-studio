"""User-editable application settings (persisted in the kv table)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from .config import get_env
from .db import kv_get, kv_set
from .secrets_store import has_secret

DEFAULT_AI_MODEL = "claude-opus-5-5"


class AppSettings(BaseModel):
    # --- AI -----------------------------------------------------------------
    ai_enabled: bool = True  # master switch for every AI feature
    ai_model: str = DEFAULT_AI_MODEL
    ai_max_tokens: int = Field(4096, ge=256, le=64000)
    ai_send_outputs: bool = True  # allow attaching output excerpts to questions
    # --- General ------------------------------------------------------------
    energy_unit: Literal["eV", "Ry", "Ha"] = "eV"
    default_connection_id: str | None = None
    poll_interval_s: float = Field(3.0, ge=1.0, le=120.0)
    max_download_mb: int = Field(200, ge=1, le=10000)  # per-file cap when fetching results
    theme: Literal["auto", "light", "dark"] = "auto"


class SettingsOut(AppSettings):
    ai_hard_disabled: bool = False  # QES_AI_DISABLED env set: cannot be re-enabled from UI
    ai_available: bool = False  # enabled and not hard-disabled
    has_anthropic_key: bool = False
    has_mp_key: bool = False


def load_settings() -> AppSettings:
    raw = kv_get("settings", {}) or {}
    try:
        return AppSettings.model_validate(raw)
    except Exception:
        return AppSettings()


def save_settings(s: AppSettings) -> None:
    kv_set("settings", s.model_dump())


def ai_available(s: AppSettings | None = None) -> bool:
    s = s or load_settings()
    return s.ai_enabled and not get_env().ai_disabled


def settings_out() -> SettingsOut:
    s = load_settings()
    return SettingsOut(
        **s.model_dump(),
        ai_hard_disabled=get_env().ai_disabled,
        ai_available=ai_available(s),
        has_anthropic_key=has_secret("anthropic_api_key"),
        has_mp_key=has_secret("mp_api_key"),
    )
