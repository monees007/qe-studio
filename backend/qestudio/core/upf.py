"""Read the header of UPF pseudopotential files (v1 and v2)."""

from __future__ import annotations

import re
from typing import Any

_ATTR = re.compile(r'([A-Za-z_]+)\s*=\s*"([^"]*)"')


def _bool(v: str | None) -> bool:
    return str(v).strip().upper() in ("T", "TRUE", ".TRUE.", "1")


def parse_upf_header(text: str) -> dict[str, Any]:
    """Return element, pseudo type, functional, z_valence, suggested cutoffs, etc."""
    head = text[:200_000]
    info: dict[str, Any] = {"format": None}
    m = re.search(r"<PP_HEADER\b(.*?)/?>", head, re.S)
    if m and "=" in m.group(1):
        attrs = dict(_ATTR.findall(m.group(1)))
        info["format"] = "UPFv2"
        info["element"] = attrs.get("element", "").strip() or None
        ptype = attrs.get("pseudo_type", "").strip().upper()
        if _bool(attrs.get("is_paw")):
            ptype = "PAW"
        elif _bool(attrs.get("is_ultrasoft")):
            ptype = "US"
        info["type"] = ptype or None
        info["functional"] = " ".join(attrs.get("functional", "").split()) or None
        info["relativistic"] = attrs.get("relativistic", "").strip() or None
        info["has_so"] = _bool(attrs.get("has_so"))
        info["nlcc"] = _bool(attrs.get("core_correction"))
        try:
            info["z_valence"] = float(attrs.get("z_valence", "nan"))
        except ValueError:
            info["z_valence"] = None
        for key, name in (("wfc_cutoff", "suggested_ecutwfc"), ("rho_cutoff", "suggested_ecutrho")):
            try:
                v = float(attrs.get(key, "0"))
                info[name] = v if v > 0 else None
            except ValueError:
                info[name] = None
    elif "<PP_HEADER>" in head:
        info["format"] = "UPFv1"
        block = head.split("<PP_HEADER>", 1)[1].split("</PP_HEADER>", 1)[0]
        lines = [ln.strip() for ln in block.strip().splitlines()]
        try:
            info["element"] = lines[1].split()[0]
            t = lines[2].split()[0].upper()
            info["type"] = {"NC": "NC", "US": "US", "PAW": "PAW", "SL": "NC"}.get(t, t)
            info["nlcc"] = _bool(lines[3].split()[0])
            info["functional"] = " ".join(lines[4].split()[:4])
            info["z_valence"] = float(lines[5].split()[0])
            cut = lines[7].split()
            info["suggested_ecutwfc"] = float(cut[0]) or None
            info["suggested_ecutrho"] = float(cut[1]) or None
        except (IndexError, ValueError):
            pass
    else:
        raise ValueError("not a UPF file (no PP_HEADER)")
    # PP_INFO "Suggested minimum cutoff" (ld1.x) when header values are zero
    if not info.get("suggested_ecutwfc"):
        m = re.search(r"Suggested minimum cutoff for wavefunctions:\s*([\d.]+)", head)
        if m and float(m.group(1)) > 0:
            info["suggested_ecutwfc"] = float(m.group(1))
    if not info.get("suggested_ecutrho"):
        m = re.search(r"Suggested minimum cutoff for charge density:\s*([\d.]+)", head)
        if m and float(m.group(1)) > 0:
            info["suggested_ecutrho"] = float(m.group(1))
    if info.get("element"):
        el = info["element"]
        info["element"] = el[:1].upper() + el[1:].lower()
    return info
