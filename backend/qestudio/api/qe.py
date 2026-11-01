"""QE input schema, parsing/rendering, validation, generation and workflow previews."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import pseudos as PS
from ..core import generate as G
from ..core import structure as ST
from ..core.namelist import PROGRAM_EXE, QEInput, QEInputError, detect_program, parse, render
from ..core.schema import load_schema, program_schema, schema_order
from ..core.validate import validate
from .common import bad

router = APIRouter(prefix="/api/qe", tags=["qe"])


@router.get("/schema")
async def schema_all() -> dict[str, Any]:
    return load_schema()


@router.get("/schema/{program}")
async def schema(program: str) -> dict[str, Any]:
    return program_schema(program)


class TextIn(BaseModel):
    text: str = Field(..., max_length=20_000_000)
    program: str | None = None


@router.post("/parse")
async def parse_input(body: TextIn) -> dict[str, Any]:
    try:
        qi = parse(body.text, body.program)
    except QEInputError as exc:
        raise bad(str(exc)) from exc
    out: dict[str, Any] = {"doc": qi.to_dict(), "program": qi.program, "executable": PROGRAM_EXE.get(qi.program)}
    if qi.program == "pw":
        try:
            out["structure"] = ST.from_pw_input(qi)
        except ST.StructureError as exc:
            out["structure_error"] = str(exc)
    return out


class RenderIn(BaseModel):
    doc: dict[str, Any]
    sort_keys: bool = False


@router.post("/render")
async def render_doc(body: RenderIn) -> dict[str, Any]:
    try:
        qi = QEInput.from_dict(body.doc)
        return {"text": render(qi, body.sort_keys, schema_order(qi.program))}
    except (QEInputError, KeyError, TypeError, ValueError) as exc:
        raise bad(f"cannot render: {exc}") from exc


@router.post("/validate")
async def validate_input(body: TextIn) -> dict[str, Any]:
    return await asyncio.to_thread(validate, body.text, body.program, PS.known_filenames())


@router.post("/detect")
async def detect(body: TextIn) -> dict[str, Any]:
    p = detect_program(body.text)
    return {"program": p, "executable": PROGRAM_EXE.get(p)}


class ApplyStructureIn(BaseModel):
    text: str
    structure: dict[str, Any]
    update_kpoints: bool = False
    kspacing: float = 0.2


@router.post("/apply-structure")
async def apply_structure(body: ApplyStructureIn) -> dict[str, Any]:
    try:
        qi = parse(body.text, "pw")
        st = ST.normalize(body.structure)
        pmap = G._pseudo_map(st, None)
        for lab, fn in pmap.items():
            if not st["species"][lab].get("pseudo"):
                # keep pseudo assignments already present in the input
                sp = qi.card("ATOMIC_SPECIES")
                prev = {ln.split()[0]: ln.split()[2] for ln in (sp.lines if sp else []) if len(ln.split()) >= 3}
                st["species"][lab]["pseudo"] = prev.get(lab) or fn
        ST.apply_to_pw_input(qi, st)
        if body.update_kpoints:
            from ..core.namelist import Card

            mesh = ST.kmesh(st, body.kspacing)
            qi.set_card(Card("K_POINTS", "automatic", [" ".join(map(str, [*mesh, 0, 0, 0]))]))
            G._sort_cards(qi)
        return {"text": render(qi)}
    except (QEInputError, ST.StructureError) as exc:
        raise bad(str(exc)) from exc


class GenerateIn(BaseModel):
    structure: dict[str, Any]
    calculation: Literal["scf", "nscf", "bands", "relax", "vc-relax", "md", "vc-md"] = "scf"
    options: dict[str, Any] = Field(default_factory=dict)


@router.post("/generate")
async def generate(body: GenerateIn) -> dict[str, Any]:
    try:
        qi = await asyncio.to_thread(G.pw_input, body.structure, body.calculation, body.options)
        text = G._r(qi)
    except (G.GenerateError, ST.StructureError, QEInputError, ValueError) as exc:
        raise bad(str(exc)) from exc
    st = ST.normalize(body.structure)
    pmap = G._pseudo_map(st, body.options.get("pseudos"))
    cut = PS.suggested_cutoffs(list(set(pmap.values())))
    notes = []
    if cut["missing"]:
        notes.append("missing pseudopotentials: " + ", ".join(cut["missing"]))
    if not cut["ecutwfc"] and not body.options.get("ecutwfc"):
        notes.append("no recommended cutoff found in the pseudopotentials; using 45 Ry — run a convergence test")
    return {
        "text": text,
        "pseudos": pmap,
        "cutoffs": cut,
        "notes": notes,
        "validation": validate(text, "pw", PS.known_filenames()),
    }


class WorkflowIn(BaseModel):
    kind: Literal["single", "bands", "dos", "phonon", "density", "convergence", "eos"]
    scf_text: str
    params: dict[str, Any] = Field(default_factory=dict)


@router.post("/workflow")
async def workflow(body: WorkflowIn) -> dict[str, Any]:
    p = body.params
    try:
        if body.kind == "single":
            wf = G.wf_single(body.scf_text)
        elif body.kind == "bands":
            wf = G.wf_bands(
                body.scf_text,
                int(p.get("npoints", 120)),
                p.get("path") or None,
                int(p["nbnd"]) if p.get("nbnd") else None,
                bool(p.get("projwfc", False)),
            )
        elif body.kind == "dos":
            wf = G.wf_dos(
                body.scf_text,
                float(p.get("kmesh_factor", 2.0)),
                int(p["nbnd"]) if p.get("nbnd") else None,
                p.get("emin"),
                p.get("emax"),
                float(p.get("delta_e", 0.01)),
                bool(p.get("pdos", True)),
                p.get("occupations", "tetrahedra_opt"),
            )
        elif body.kind == "phonon":
            wf = G.wf_phonon(
                body.scf_text,
                p.get("nq"),
                int(p.get("npoints", 100)),
                p.get("path") or None,
                float(p.get("tr2_ph", 1e-14)),
                p.get("asr", "crystal"),
                p.get("dos_mesh"),
                bool(p.get("epsil", False)),
            )
        elif body.kind == "density":
            wf = G.wf_density(body.scf_text, int(p.get("plot_num", 0)), int(p.get("output_format", 6)), p.get("extra"))
        elif body.kind == "convergence":
            wf = G.wf_convergence(
                body.scf_text, p.get("parameter", "ecutwfc"), list(p.get("values") or []), p.get("dual")
            )
        else:
            wf = G.wf_eos(
                body.scf_text,
                int(p.get("npoints", 7)),
                float(p.get("max_strain", 0.06)),
                bool(p.get("relax_ions", False)),
            )
    except (G.GenerateError, ST.StructureError, QEInputError, ValueError, KeyError, TypeError) as exc:
        raise bad(f"{body.kind}: {exc}") from exc
    for st in wf["steps"]:
        key = {v: k for k, v in PROGRAM_EXE.items()}.get(st["program"])
        st["validation"] = validate(st["input"], key, PS.known_filenames()) if key else None
    return wf


class TemplateIn(BaseModel):
    program: Literal["dos", "projwfc", "bands", "pp", "ph", "q2r", "matdyn"]
    prefix: str = "pwscf"
    outdir: str = "./tmp/"


@router.post("/template")
async def template(body: TemplateIn) -> dict[str, Any]:
    try:
        return {"text": G.post_input(body.program, body.prefix, body.outdir)}
    except G.GenerateError as exc:
        raise bad(str(exc)) from exc
