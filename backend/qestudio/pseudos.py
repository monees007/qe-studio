"""Local pseudopotential library (files in QES_HOME/pseudos).

* Upload single UPF files or archives (.tar.gz/.tgz/.tar.bz2/.tar.xz/.zip) of UPFs.
* SSSP-style metadata JSON ({"Si": {"filename": ..., "cutoff_wfc": .., "cutoff_rho": ..}})
  found in an archive is merged into the library metadata and used for cutoff suggestions.
* Per-element default choice is stored in the kv table.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import tarfile
import threading
import zipfile
from pathlib import Path
from typing import Any

from .config import get_env
from .core.upf import parse_upf_header
from .db import kv_get, kv_set

_lock = threading.Lock()
_cache: dict[str, tuple[float, int, dict[str, Any]]] = {}
_SAFE = re.compile(r"^[A-Za-z0-9._+\-]+$")
MAX_UPF = 50 * 1024 * 1024


class PseudoError(ValueError):
    pass


def _dir() -> Path:
    d = get_env().pseudo_dir
    d.mkdir(parents=True, exist_ok=True)
    return d


def _meta_path() -> Path:
    return _dir() / ".qes-meta.json"


def load_meta() -> dict[str, Any]:
    p = _meta_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return {}
    return {}


def _save_meta(meta: dict[str, Any]) -> None:
    _meta_path().write_text(json.dumps(meta, indent=1))


def safe_name(name: str) -> str:
    base = Path(name.replace("\\", "/")).name
    if not base or not _SAFE.match(base) or base.startswith("."):
        raise PseudoError(f"invalid pseudopotential file name '{name}'")
    return base


def _info(path: Path) -> dict[str, Any]:
    st = path.stat()
    key = path.name
    cached = _cache.get(key)
    if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
        return cached[2]
    raw = path.read_bytes()
    try:
        hdr = parse_upf_header(raw.decode("utf-8", errors="replace"))
        err = None
    except ValueError as exc:
        hdr, err = {}, str(exc)
    meta = load_meta().get("files", {}).get(path.name, {})
    info = {
        "filename": path.name,
        "size": st.st_size,
        "md5": hashlib.md5(raw).hexdigest(),
        **hdr,
        "family": meta.get("family"),
        "recommended_ecutwfc": meta.get("cutoff_wfc"),
        "recommended_ecutrho": meta.get("cutoff_rho"),
        "error": err,
    }
    if info.get("element") is None:
        m = re.match(r"^([A-Za-z]{1,2})[._\-]", path.name)
        if m:
            info["element"] = m.group(1)[:1].upper() + m.group(1)[1:].lower()
    _cache[key] = (st.st_mtime, st.st_size, info)
    return info


def list_pseudos() -> list[dict[str, Any]]:
    out = []
    defaults = get_defaults()
    for p in sorted(_dir().iterdir(), key=lambda x: x.name.lower()):
        if p.is_file() and not p.name.startswith("."):
            info = _info(p)
            info["is_default"] = defaults.get(info.get("element") or "") == p.name
            out.append(info)
    return out


def known_filenames() -> set[str]:
    return {p.name for p in _dir().iterdir() if p.is_file() and not p.name.startswith(".")}


def path_of(filename: str) -> Path:
    p = _dir() / safe_name(filename)
    if not p.exists():
        raise PseudoError(f"pseudopotential '{filename}' not found in the library")
    return p


def get_defaults() -> dict[str, str]:
    return dict(kv_get("pseudo_defaults", {}) or {})


def set_default(element: str, filename: str | None) -> None:
    d = get_defaults()
    if filename:
        path_of(filename)
        d[element] = filename
    else:
        d.pop(element, None)
    kv_set("pseudo_defaults", d)


def pick_for_element(element: str) -> dict[str, Any] | None:
    """Default for an element, else the only/first matching file."""
    d = get_defaults()
    items = [x for x in list_pseudos() if (x.get("element") or "").lower() == element.lower()]
    if element in d:
        for x in items:
            if x["filename"] == d[element]:
                return x
    return items[0] if items else None


def _store(name: str, data: bytes, family: str | None, added: list[str], meta_files: dict[str, Any]) -> None:
    base = safe_name(name)
    if len(data) > MAX_UPF:
        raise PseudoError(f"{base}: file too large")
    text = data[:200_000].decode("utf-8", errors="replace")
    try:
        hdr = parse_upf_header(text)
    except ValueError as exc:
        raise PseudoError(f"{base}: {exc}") from exc
    (_dir() / base).write_bytes(data)
    added.append(base)
    if family:
        meta_files.setdefault(base, {})["family"] = family
    el = hdr.get("element")
    if el and el not in get_defaults():
        set_default(el, base)


def _apply_sssp_json(js: dict[str, Any], family: str | None, meta_files: dict[str, Any]) -> int:
    n = 0
    for el, v in js.items():
        if isinstance(v, dict) and "filename" in v:
            fn = Path(str(v["filename"])).name
            m = meta_files.setdefault(fn, {})
            if "cutoff_wfc" in v or "cutoff" in v:
                m["cutoff_wfc"] = float(v.get("cutoff_wfc", v.get("cutoff")))
            if "cutoff_rho" in v or "dual" in v:
                m["cutoff_rho"] = float(v.get("cutoff_rho", float(v.get("dual", 4)) * m.get("cutoff_wfc", 0)))
            m["element"] = el
            if family:
                m["family"] = family
            n += 1
    return n


def add_files(files: list[tuple[str, bytes]], family: str | None = None, make_default: bool = False) -> dict[str, Any]:
    """Add UPF files and/or archives. Returns {'added': [...], 'errors': [...]}."""
    added: list[str] = []
    errors: list[str] = []
    with _lock:
        meta = load_meta()
        meta_files = meta.setdefault("files", {})
        for name, data in files:
            low = name.lower()
            try:
                if low.endswith((".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar")):
                    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tf:
                        for m in tf.getmembers():
                            if not m.isfile():
                                continue
                            mlow = m.name.lower()
                            fh = tf.extractfile(m)
                            if fh is None:
                                continue
                            if mlow.endswith(".json"):
                                try:
                                    _apply_sssp_json(json.loads(fh.read()), family, meta_files)
                                except Exception:
                                    pass
                            elif mlow.endswith(".upf") or ".upf" in mlow:
                                try:
                                    _store(m.name, fh.read(), family, added, meta_files)
                                except PseudoError as exc:
                                    errors.append(str(exc))
                elif low.endswith(".zip"):
                    with zipfile.ZipFile(io.BytesIO(data)) as zf:
                        for zi in zf.infolist():
                            if zi.is_dir():
                                continue
                            zlow = zi.filename.lower()
                            if zlow.endswith(".json"):
                                try:
                                    _apply_sssp_json(json.loads(zf.read(zi)), family, meta_files)
                                except Exception:
                                    pass
                            elif ".upf" in zlow:
                                try:
                                    _store(zi.filename, zf.read(zi), family, added, meta_files)
                                except PseudoError as exc:
                                    errors.append(str(exc))
                elif low.endswith(".json"):
                    n = _apply_sssp_json(json.loads(data), family, meta_files)
                    if not n:
                        errors.append(f"{name}: no SSSP-style entries found")
                else:
                    _store(name, data, family, added, meta_files)
            except PseudoError as exc:
                errors.append(str(exc))
            except (tarfile.TarError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
                errors.append(f"{name}: {exc}")
        _save_meta(meta)
    _cache.clear()
    if make_default:
        for fn in added:
            try:
                el = _info(_dir() / fn).get("element")
                if el:
                    set_default(el, fn)
            except Exception:
                pass
    return {"added": added, "errors": errors}


def delete(filename: str) -> None:
    p = path_of(filename)
    p.unlink()
    d = get_defaults()
    for el, fn in list(d.items()):
        if fn == filename:
            d.pop(el)
    kv_set("pseudo_defaults", d)
    _cache.pop(filename, None)


def suggested_cutoffs(filenames: list[str]) -> dict[str, Any]:
    """Max of recommended (metadata) or UPF-suggested cutoffs; dual 4 (NC) or 8 (US/PAW)."""
    wfc, rho, types, missing = 0.0, 0.0, set(), []
    for fn in filenames:
        try:
            info = _info(path_of(fn))
        except PseudoError:
            missing.append(fn)
            continue
        types.add(info.get("type") or "NC")
        w = info.get("recommended_ecutwfc") or info.get("suggested_ecutwfc")
        r = info.get("recommended_ecutrho") or info.get("suggested_ecutrho")
        if w:
            wfc = max(wfc, float(w))
        if r:
            rho = max(rho, float(r))
    dual = 8.0 if types & {"US", "PAW"} else 4.0
    return {
        "ecutwfc": wfc or None,
        "ecutrho": max(rho, wfc * dual) if wfc else (rho or None),
        "dual": dual,
        "types": sorted(types),
        "missing": missing,
        "source": "library metadata / UPF headers",
    }


def valence(filenames: dict[str, str]) -> dict[str, float | None]:
    """label -> z_valence (None if unknown)."""
    out: dict[str, float | None] = {}
    for label, fn in filenames.items():
        try:
            out[label] = _info(path_of(fn)).get("z_valence")
        except PseudoError:
            out[label] = None
    return out
