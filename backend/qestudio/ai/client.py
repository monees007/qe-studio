"""Claude (Anthropic API) integration: optional, user-key based, globally switchable."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from ..secrets_store import get_secret
from ..settings import ai_available, load_settings

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are an expert in density-functional theory and the Quantum ESPRESSO (QE) suite \
(pw.x, ph.x, pp.x, dos.x, projwfc.x, bands.x, q2r.x, matdyn.x), embedded in "QE Studio", a desktop \
workbench. The user is a researcher. Give a careful second opinion.

Rules:
- Be scientifically precise. Name QE input variables exactly (e.g. ecutwfc, degauss, conv_thr) and \
give units (Ry, eV, Bohr, Angstrom, kbar).
- Distinguish clearly between what the provided files show, what is standard practice, and what is \
your judgement. Say when something cannot be determined from the context.
- Never invent numerical results, references or QE variables. If you are unsure whether a variable or \
option exists in the user's QE version, say so and suggest checking INPUT_PW documentation.
- Prefer actionable advice: what to change, why, and how to verify it (convergence tests, checking \
forces/stress, symmetry, magnetic states, pseudopotential choice).
- DFT+U: since QE 7.1 the Hubbard parameters go in the HUBBARD card (Doc/Hubbard_input.pdf); \
lda_plus_u / Hubbard_U in &SYSTEM are not part of the current input description.
- Format answers in concise Markdown. Put suggested input snippets in fenced code blocks."""

MAX_ITEM_CHARS = 60_000
MAX_TOTAL_CHARS = 180_000


class AIError(RuntimeError):
    pass


def _trim(text: str, kind: str) -> str:
    if len(text) <= MAX_ITEM_CHARS:
        return text
    if kind == "output":
        head, tail = 8_000, MAX_ITEM_CHARS - 8_000
        return text[:head] + f"\n\n[... {len(text) - head - tail} characters omitted ...]\n\n" + text[-tail:]
    return text[:MAX_ITEM_CHARS] + f"\n[... truncated, {len(text) - MAX_ITEM_CHARS} characters omitted ...]"


def build_messages(question: str, context: list[dict[str, Any]], history: list[dict[str, str]]) -> list[dict[str, Any]]:
    s = load_settings()
    blocks = []
    total = 0
    for item in context:
        kind = item.get("kind", "text")
        if kind == "output" and not s.ai_send_outputs:
            continue
        content = _trim(str(item.get("content", "")), kind)
        if total + len(content) > MAX_TOTAL_CHARS:
            content = content[: max(0, MAX_TOTAL_CHARS - total)] + "\n[... context budget exhausted ...]"
        total += len(content)
        title = item.get("title") or kind
        blocks.append(f'<context kind="{kind}" title="{title}">\n{content}\n</context>')
        if total >= MAX_TOTAL_CHARS:
            break
    msgs: list[dict[str, Any]] = []
    for h in history[-10:]:
        if h.get("role") in ("user", "assistant") and h.get("content"):
            msgs.append({"role": h["role"], "content": str(h["content"])[:20_000]})
    user = ("\n\n".join(blocks) + "\n\n" if blocks else "") + f"Question: {question}"
    msgs.append({"role": "user", "content": user})
    # the API requires alternating roles starting with user
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


def _client():
    if not ai_available():
        raise AIError("AI features are turned off")
    key = get_secret("anthropic_api_key")
    if not key:
        raise AIError("no Claude API key configured (Settings > AI)")
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover
        raise AIError("the 'anthropic' package is not installed") from exc
    return anthropic.AsyncAnthropic(api_key=key, max_retries=2, timeout=300)


async def stream_answer(
    question: str, context: list[dict[str, Any]], history: list[dict[str, str]], model: str | None = None
) -> AsyncIterator[dict[str, Any]]:
    import anthropic

    s = load_settings()
    cli = _client()
    msgs = build_messages(question, context, history)
    try:
        async with cli.messages.stream(
            model=model or s.ai_model, max_tokens=s.ai_max_tokens, system=SYSTEM_PROMPT, messages=msgs
        ) as stream:
            async for text in stream.text_stream:
                if not ai_available():  # switched off mid-stream
                    yield {"type": "error", "message": "AI was turned off"}
                    return
                yield {"type": "delta", "text": text}
            final = await stream.get_final_message()
            usage = getattr(final, "usage", None)
            yield {
                "type": "done",
                "model": getattr(final, "model", None),
                "stop_reason": final.stop_reason,
                "usage": {
                    "input_tokens": getattr(usage, "input_tokens", None),
                    "output_tokens": getattr(usage, "output_tokens", None),
                }
                if usage
                else None,
            }
    except anthropic.AuthenticationError as exc:
        yield {"type": "error", "message": "the Claude API key was rejected (401)"}
        log.info("AI auth error: %s", exc)
    except anthropic.NotFoundError:
        yield {"type": "error", "message": f"model '{model or s.ai_model}' not found; pick another in Settings"}
    except anthropic.RateLimitError:
        yield {"type": "error", "message": "rate limited by the Claude API; try again shortly"}
    except anthropic.APIConnectionError as exc:
        yield {"type": "error", "message": f"cannot reach the Claude API: {exc}"}
    except anthropic.APIStatusError as exc:
        yield {"type": "error", "message": f"Claude API error {exc.status_code}: {getattr(exc, 'message', exc)}"}
    finally:
        await cli.close()


async def list_models() -> list[dict[str, Any]]:
    cli = _client()
    try:
        out = []
        page = await cli.models.list(limit=100)
        for m in page.data:
            out.append({"id": m.id, "display_name": getattr(m, "display_name", m.id)})
        return out
    finally:
        await cli.close()
