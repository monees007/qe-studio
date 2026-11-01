"""AI assistant endpoints. Every endpoint refuses when AI is switched off."""

from __future__ import annotations

from typing import Any

import orjson
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..ai.client import AIError, list_models, stream_answer
from ..secrets_store import has_secret
from ..settings import ai_available, load_settings
from .common import bad

router = APIRouter(prefix="/api/ai", tags=["ai"])


def require_ai() -> None:
    if not ai_available():
        raise bad("AI features are turned off", 403)


@router.get("/status")
async def status() -> dict[str, Any]:
    s = load_settings()
    return {"available": ai_available(s), "configured": has_secret("anthropic_api_key"), "model": s.ai_model}


class ContextItem(BaseModel):
    kind: str = "text"
    title: str = ""
    content: str = Field("", max_length=5_000_000)


class HistoryItem(BaseModel):
    role: str
    content: str


class AskIn(BaseModel):
    question: str = Field(..., min_length=1, max_length=20_000)
    context: list[ContextItem] = Field(default_factory=list)
    history: list[HistoryItem] = Field(default_factory=list)
    model: str | None = None


@router.post("/ask", dependencies=[Depends(require_ai)])
async def ask(body: AskIn) -> StreamingResponse:
    if not has_secret("anthropic_api_key"):
        raise bad("no Claude API key configured (Settings > AI)")

    async def gen():
        try:
            async for ev in stream_answer(
                body.question,
                [c.model_dump() for c in body.context],
                [h.model_dump() for h in body.history],
                body.model,
            ):
                yield b"data: " + orjson.dumps(ev) + b"\n\n"
        except AIError as exc:
            yield b"data: " + orjson.dumps({"type": "error", "message": str(exc)}) + b"\n\n"

    return StreamingResponse(
        gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@router.get("/models", dependencies=[Depends(require_ai)])
async def models() -> dict[str, Any]:
    try:
        return {"models": await list_models()}
    except AIError as exc:
        raise bad(str(exc)) from exc
    except Exception as exc:
        raise bad(f"could not list models: {exc}") from exc
