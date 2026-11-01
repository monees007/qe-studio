"""Which job files are downloaded, and the compact summary stored with each job."""

from __future__ import annotations

import re
from typing import Any

SKIP_DIRS = {"tmp", "pseudo", "_ph0", "__pycache__"}
SKIP_FILES = re.compile(r"(\.wfc\d*|\.hub\d*|\.mix\d*|\.igk\d*|\.save|\.bar\d*|\.dwf\d*|\.qes-tmp|\.part)$")
KEEP_STATE_FILES = {"runner.log", "scheduler.log", "state", "exit_code", "step"}


def wanted(rel_path: str) -> bool:
    """True for output files worth caching locally (skips scratch/wavefunctions)."""
    parts = rel_path.split("/")
    if any(p in SKIP_DIRS or p.endswith(".save") for p in parts[:-1]):
        return False
    if SKIP_FILES.search(parts[-1]):
        return False
    return not (parts[0] == ".qes" and parts[-1] not in KEEP_STATE_FILES)


def brief_summary(analysis: dict[str, Any]) -> dict[str, Any]:
    """Small dict shown in job lists (energy, gap, fit results, first errors)."""
    out: dict[str, Any] = {}
    pw = analysis.get("pw") or {}
    pw_summary = pw.get("summary") or {}
    for key in (
        "final_energy_ev",
        "fermi_energy_ev",
        "homo_ev",
        "lumo_ev",
        "total_magnetization",
        "wall_time_s",
        "status",
        "version",
    ):
        if pw_summary.get(key) is not None:
            out[key] = pw_summary[key]
    if pw.get("gap"):
        out["gap_ev"] = pw["gap"].get("gap_ev")
    if (analysis.get("bands") or {}).get("gap"):
        out["gap_ev"] = analysis["bands"]["gap"].get("gap_ev")
    if (analysis.get("eos") or {}).get("fit"):
        fit = analysis["eos"]["fit"]
        out["eos"] = {"v0": fit["v0"], "B0_GPa": fit["B0_GPa"]}
    if (analysis.get("convergence") or {}).get("recommended"):
        out["recommended"] = analysis["convergence"]["recommended"]["label"]
    if (analysis.get("phonon") or {}).get("dispersion"):
        out["min_phonon_cm1"] = analysis["phonon"]["dispersion"]["min_freq_cm1"]
    errors = [e for st in analysis.get("steps", []) for e in (st.get("errors") or [])]
    if errors:
        out["errors"] = errors[:5]
    if analysis.get("error"):
        out["analysis_error"] = analysis["error"]
    return out
