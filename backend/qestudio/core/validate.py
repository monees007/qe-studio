"""Static checks for QE input files (schema + physics/consistency rules).

Severity levels:
  error   - QE will stop (or the run cannot be prepared)
  warning - very likely a mistake or a poor choice
  info    - hint
"""

from __future__ import annotations

import difflib
import re
from collections.abc import Iterable
from typing import Any

from . import schema as SC
from .namelist import NAMELIST_ORDER, QEInput, QEInputError, parse

Issue = dict[str, Any]


def _issue(sev: str, msg: str, line: int | None = None, namelist: str | None = None, key: str | None = None) -> Issue:
    return {"severity": sev, "message": msg, "line": line, "namelist": namelist, "key": key}


# aliases documented for character options (accepted by QE but not in the canonical list)
_ALIASES = {
    "smearing": {"gauss", "m-p", "mp", "m-v", "mv", "cold", "f-d", "fd"},
    "diagonalization": {"david", "cg", "ppcg", "paro", "rmm-davidson", "rmm-paro"},
    "mixing_mode": {"plain", "TF", "local-TF", "tf", "local-tf"},
    "ion_dynamics": {"bfgs", "damp", "fire", "verlet", "langevin", "langevin-smc", "beeman"},
    "cell_dynamics": {"none", "sd", "damp-pr", "damp-w", "bfgs", "pr", "w"},
    "cell_dofree": {
        "all",
        "ibrav",
        "a",
        "b",
        "c",
        "fixa",
        "fixb",
        "fixc",
        "x",
        "y",
        "z",
        "xy",
        "xz",
        "yz",
        "xyz",
        "shape",
        "volume",
        "2Dxy",
        "2Dshape",
        "epitaxial_ab",
        "epitaxial_ac",
        "epitaxial_bc",
    },
    "verbosity": {"high", "low", "debug", "medium", "default", "minimal"},
    "disk_io": {"high", "medium", "low", "nowf", "minimal", "none"},
    "vdw_corr": {
        "grimme-d2",
        "Grimme-D2",
        "DFT-D",
        "dft-d",
        "grimme-d3",
        "Grimme-D3",
        "DFT-D3",
        "dft-d3",
        "ts",
        "ts-vdw",
        "ts-vdW",
        "tkatchenko-scheffler",
        "mbd",
        "many-body dispersion",
        "mbd_vdw",
        "xdm",
        "XDM",
        "none",
    },
    "assume_isolated": {"none", "makov-payne", "m-p", "mp", "martyna-tuckerman", "m-t", "mt", "esm", "2D"},
    "occupations": {"smearing", "tetrahedra", "tetrahedra_lin", "tetrahedra_opt", "fixed", "from_input"},
    "restart_mode": {"from_scratch", "restart"},
}


def _type_ok(t: str, v: Any) -> bool:
    if isinstance(v, list):
        return all(_type_ok(t, x) for x in v)
    if t == "real":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if t == "logical":
        return isinstance(v, bool)
    if t == "character":
        return isinstance(v, str)
    return True


def _check_schema(qi: QEInput, program: str) -> Iterable[Issue]:
    idx = SC.var_index(program)
    allv = SC.all_vars(program)
    known_nls = set(idx) | set(NAMELIST_ORDER.get(program, []))
    for nl, vals in qi.namelists.items():
        if known_nls and nl not in known_nls:
            sugg = difflib.get_close_matches(nl, list(known_nls), n=1)
            yield _issue(
                "error",
                f"unknown namelist &{nl} for {program}.x" + (f" (did you mean &{sugg[0]}?)" if sugg else ""),
                namelist=nl,
            )
            continue
        nl_idx = idx.get(nl, {})
        for key, v in vals.items():
            base = key.split("(")[0].lower()
            line = qi.key_lines.get(f"{nl}.{key.lower()}")
            var = nl_idx.get(base)
            if var is None:
                if base in allv:
                    other = allv[base][0]
                    yield _issue("error", f"'{key}' belongs to &{other}, not &{nl}", line, nl, key)
                else:
                    sugg = difflib.get_close_matches(base, list(nl_idx), n=1, cutoff=0.75)
                    if (
                        base
                        in (
                            "lda_plus_u",
                            "lda_plus_u_kind",
                            "hubbard_u",
                            "hubbard_j0",
                            "hubbard_v",
                            "u_projection_type",
                        )
                        and program == "pw"
                    ):
                        # QE 7.1 release notes, "Incompatible changes": new DFT+Hubbard input syntax
                        # (Doc/Hubbard_input.pdf); these &SYSTEM variables are not in INPUT_PW any more
                        yield _issue(
                            "error",
                            f"'{key}' belongs to the DFT+U input replaced in QE 7.1; use the HUBBARD card",
                            line,
                            nl,
                            key,
                        )
                    else:
                        yield _issue(
                            "warning",
                            f"unknown variable '{key}' in &{nl}"
                            + (f" — did you mean '{sugg[0]}'?" if sugg else " (not in QE Studio's schema)"),
                            line,
                            nl,
                            key,
                        )
                continue
            if "(" in key and not var.get("dimension"):
                yield _issue("warning", f"'{var['name']}' is not an array variable", line, nl, key)
            if "(" not in key and var.get("dimension") and base not in ("celldm",) and not isinstance(v, list):
                yield _issue("warning", f"'{var['name']}' is indexed, e.g. {var['name']}(1)", line, nl, key)
            t = var.get("type", "character")
            if not _type_ok(t, v):
                if t == "real" and isinstance(v, str):
                    msg = f"'{key}' expects a real number, got '{v}'"
                else:
                    msg = f"'{key}' expects {t}, got {type(v).__name__} ({v!r})"
                yield _issue("error", msg, line, nl, key)
                continue
            if t == "character" and f"{nl}.{key.lower()}" in qi.unquoted:
                yield _issue("error", f"string value of '{key}' must be quoted: {key} = '{v}'", line, nl, key)
            opts = var.get("options")
            if opts and t == "character" and isinstance(v, str):
                allowed = {o.lower() for o in opts} | {a.lower() for a in _ALIASES.get(base, set())}
                if v.lower() not in allowed:
                    yield _issue(
                        "warning", f"'{key}' = '{v}' is not a documented option ({', '.join(opts)})", line, nl, key
                    )


def _int_tokens(line: str) -> list[int] | None:
    try:
        return [int(t) for t in line.split()]
    except ValueError:
        return None


def _check_pw(qi: QEInput) -> Iterable[Issue]:
    g = qi.get
    calc = str(g("CONTROL", "calculation", "scf")).lower()
    for nl in ("CONTROL", "SYSTEM", "ELECTRONS"):
        if nl not in qi.namelists and nl != "CONTROL":
            yield _issue("info", f"&{nl} namelist absent; it will be written (empty) automatically", namelist=nl)
    if "SYSTEM" not in qi.namelists:
        yield _issue("error", "&SYSTEM namelist is required")
        return
    ibrav = g("SYSTEM", "ibrav")
    if ibrav is None and g("SYSTEM", "space_group") is None:
        yield _issue("error", "ibrav is required in &SYSTEM", namelist="SYSTEM", key="ibrav")
    for req in ("nat", "ntyp", "ecutwfc"):
        if g("SYSTEM", req) is None:
            yield _issue("error", f"'{req}' is required in &SYSTEM", namelist="SYSTEM", key=req)
    has_celldm = g("SYSTEM", "celldm(1)") is not None
    has_A = g("SYSTEM", "A") is not None
    if has_celldm and has_A:
        yield _issue("error", "specify either celldm(1..6) or A,B,C,cosAB,... — not both", namelist="SYSTEM")
    if ibrav not in (None, 0) and not (has_celldm or has_A):
        yield _issue("error", f"ibrav={ibrav} needs celldm(1) or A", namelist="SYSTEM", key="ibrav")
    if ibrav == 0 and qi.card("CELL_PARAMETERS") is None:
        yield _issue("error", "ibrav=0 requires the CELL_PARAMETERS card", namelist="SYSTEM", key="ibrav")
    if ibrav not in (None, 0) and qi.card("CELL_PARAMETERS") is not None:
        yield _issue(
            "warning",
            f"CELL_PARAMETERS given but ibrav={ibrav}; QE stops unless ibrav=0",
            qi.card("CELL_PARAMETERS").line,
        )
    cp = qi.card("CELL_PARAMETERS")
    if cp is not None and (cp.option in (None, "alat")) and not (has_celldm or has_A):
        yield _issue("error", "CELL_PARAMETERS in alat units requires celldm(1) or A", cp.line)

    # species / positions
    sp = qi.card("ATOMIC_SPECIES")
    labels: list[str] = []
    if sp is None:
        yield _issue("error", "ATOMIC_SPECIES card is missing")
    else:
        for ln in sp.lines:
            tok = ln.split()
            if len(tok) < 3:
                yield _issue("error", f"ATOMIC_SPECIES line must be 'label mass pseudo_file': '{ln}'", sp.line)
                continue
            labels.append(tok[0])
            if not re.search(r"\.(upf|UPF|psp8|vdb|van|RRKJ3|rrkj3|pz-vbc|xml)$|upf", tok[2], re.I):
                yield _issue("warning", f"pseudopotential '{tok[2]}' does not look like a UPF file", sp.line)
        ntyp = g("SYSTEM", "ntyp")
        if isinstance(ntyp, int) and ntyp != len(labels):
            yield _issue(
                "error",
                f"ntyp={ntyp} but ATOMIC_SPECIES lists {len(labels)} species",
                qi.key_lines.get("SYSTEM.ntyp"),
                "SYSTEM",
                "ntyp",
            )
        if len(set(labels)) != len(labels):
            yield _issue("error", "duplicate labels in ATOMIC_SPECIES", sp.line)
    pos = qi.card("ATOMIC_POSITIONS")
    if pos is None:
        yield _issue("error", "ATOMIC_POSITIONS card is missing")
    else:
        if pos.option is None:
            yield _issue(
                "warning",
                "ATOMIC_POSITIONS without units defaults to alat (deprecated); "
                "specify {crystal}, {angstrom}, {bohr} or {alat}",
                pos.line,
            )
        elif pos.option not in ("alat", "bohr", "angstrom", "crystal", "crystal_sg"):
            yield _issue("error", f"unknown ATOMIC_POSITIONS units '{pos.option}'", pos.line)
        nat = g("SYSTEM", "nat")
        if isinstance(nat, int) and nat != len(pos.lines):
            yield _issue(
                "error",
                f"nat={nat} but ATOMIC_POSITIONS has {len(pos.lines)} lines",
                qi.key_lines.get("SYSTEM.nat"),
                "SYSTEM",
                "nat",
            )
        for ln in pos.lines:
            tok = ln.split()
            if labels and tok and tok[0] not in labels:
                yield _issue(
                    "error", f"species '{tok[0]}' in ATOMIC_POSITIONS is not defined in ATOMIC_SPECIES", pos.line
                )
            if len(tok) not in (4, 7):
                yield _issue("error", f"ATOMIC_POSITIONS line must have 4 or 7 fields: '{ln}'", pos.line)
            else:
                try:
                    [float(t.replace("d", "e").replace("D", "e")) for t in tok[1:4]]
                except ValueError:
                    yield _issue("error", f"invalid coordinates: '{ln}'", pos.line)
            if len(tok) == 7 and calc in ("scf", "nscf", "bands"):
                pass

    # k-points
    kp = qi.card("K_POINTS")
    if kp is None:
        yield _issue("warning", "K_POINTS card missing (QE defaults to Gamma only, in tpiba units)")
    else:
        opt = kp.option or "tpiba"
        if opt == "automatic":
            vals = _int_tokens(kp.lines[0]) if kp.lines else None
            if not vals or len(vals) != 6:
                yield _issue("error", "K_POINTS automatic needs one line: nk1 nk2 nk3 sk1 sk2 sk3 (integers)", kp.line)
            else:
                if any(v < 1 for v in vals[:3]):
                    yield _issue("error", "k-mesh dimensions must be >= 1", kp.line)
                if any(v not in (0, 1) for v in vals[3:]):
                    yield _issue("error", "k-mesh shifts must be 0 or 1", kp.line)
            if calc == "bands":
                yield _issue(
                    "warning", "calculation='bands' normally uses a path (K_POINTS crystal_b/tpiba_b)", kp.line
                )
        elif opt == "gamma":
            if kp.lines:
                yield _issue("warning", "K_POINTS gamma takes no further lines", kp.line)
        elif opt in ("tpiba", "crystal", "tpiba_b", "crystal_b", "tpiba_c", "crystal_c"):
            if not kp.lines:
                yield _issue("error", f"K_POINTS {opt} needs the number of points", kp.line)
            else:
                try:
                    nks = int(kp.lines[0].split()[0])
                    if len(kp.lines) - 1 != nks:
                        yield _issue("error", f"K_POINTS declares {nks} points but lists {len(kp.lines) - 1}", kp.line)
                    for ln in kp.lines[1:]:
                        if len(ln.split()) < 4 and opt not in ("tpiba_c", "crystal_c"):
                            yield _issue("error", f"k-point line needs 'kx ky kz weight': '{ln}'", kp.line)
                except ValueError:
                    yield _issue("error", "first K_POINTS line must be the number of points", kp.line)
        else:
            yield _issue("error", f"unknown K_POINTS option '{opt}'", kp.line)

    # cutoffs
    ecutwfc = g("SYSTEM", "ecutwfc")
    ecutrho = g("SYSTEM", "ecutrho")
    if isinstance(ecutwfc, (int, float)) and not isinstance(ecutwfc, bool):
        if ecutwfc <= 0:
            yield _issue("error", "ecutwfc must be positive", namelist="SYSTEM", key="ecutwfc")
        elif ecutwfc < 15:
            yield _issue(
                "warning",
                f"ecutwfc={ecutwfc} Ry is very low; converge it (typically 30-100 Ry)",
                namelist="SYSTEM",
                key="ecutwfc",
            )
        if isinstance(ecutrho, (int, float)) and not isinstance(ecutrho, bool):
            if ecutrho <= ecutwfc:
                yield _issue("error", "ecutrho must be larger than ecutwfc", namelist="SYSTEM", key="ecutrho")
            elif ecutrho < 4 * ecutwfc:
                yield _issue(
                    "warning",
                    "ecutrho < 4*ecutwfc truncates the density (aliasing); use >= 4x (NC) or 8-12x (US/PAW)",
                    namelist="SYSTEM",
                    key="ecutrho",
                )

    # occupations / smearing
    occ = str(g("SYSTEM", "occupations", "fixed")).lower()
    if occ == "smearing":
        deg = g("SYSTEM", "degauss")
        if deg in (None, 0, 0.0):
            yield _issue(
                "error",
                "occupations='smearing' requires degauss > 0 (e.g. 0.01-0.02 Ry)",
                namelist="SYSTEM",
                key="degauss",
            )
        elif isinstance(deg, (int, float)) and deg > 0.1:
            yield _issue(
                "warning",
                f"degauss={deg} Ry is large; typical values are 0.005-0.03 Ry",
                namelist="SYSTEM",
                key="degauss",
            )
    elif occ.startswith("tetrahedra") and calc in ("relax", "vc-relax", "md", "vc-md"):
        if occ != "tetrahedra_opt":
            yield _issue(
                "warning",
                "tetrahedra (Bloechl) give no forces; use smearing or tetrahedra_opt for relaxations",
                namelist="SYSTEM",
                key="occupations",
            )
    if occ.startswith("tetrahedra") and kp is not None and kp.option != "automatic":
        yield _issue(
            "error", "tetrahedra occupations require an automatic k-point mesh", namelist="SYSTEM", key="occupations"
        )

    # spin
    nspin = g("SYSTEM", "nspin", 1)
    noncolin = g("SYSTEM", "noncolin", False)
    if nspin == 2 or noncolin:
        mags = qi.indexed("SYSTEM", "starting_magnetization")
        if (
            not any(isinstance(v, (int, float)) and v != 0 for v in mags.values())
            and g("SYSTEM", "tot_magnetization") is None
        ):
            yield _issue(
                "error",
                "spin-polarized run: set a non-zero starting_magnetization(i) or tot_magnetization",
                namelist="SYSTEM",
                key="nspin",
            )
    if nspin == 4:
        yield _issue("error", "use noncolin=.true. instead of nspin=4", namelist="SYSTEM", key="nspin")
    for idx in qi.indexed("SYSTEM", "starting_magnetization"):
        try:
            i = int(idx)
            if labels and not 1 <= i <= len(labels):
                yield _issue(
                    "error", f"starting_magnetization({i}) refers to a non-existent species", namelist="SYSTEM"
                )
        except ValueError:
            pass
    if g("SYSTEM", "lspinorb") and not noncolin:
        yield _issue("error", "lspinorb=.true. requires noncolin=.true.", namelist="SYSTEM", key="lspinorb")

    # calculation-specific
    if calc in ("relax", "vc-relax", "md", "vc-md") and "IONS" not in qi.namelists:
        yield _issue("info", f"&IONS will be added (required for calculation='{calc}')")
    if calc in ("vc-relax", "vc-md") and "CELL" not in qi.namelists:
        yield _issue("info", f"&CELL will be added (required for calculation='{calc}')")
    if calc in ("nscf", "bands"):
        yield _issue(
            "info",
            f"calculation='{calc}' reads the charge density of a previous SCF run (same prefix and outdir)",
            namelist="CONTROL",
            key="calculation",
        )
        if occ == "smearing" and calc == "nscf" and g("SYSTEM", "nbnd") is None:
            yield _issue("info", "set nbnd to include empty bands for DOS/bands", namelist="SYSTEM", key="nbnd")
    if calc == "vc-relax":
        ecut = ecutwfc if isinstance(ecutwfc, (int, float)) else 0
        if g("CELL", "cell_dofree") is None and ecut and ecut < 40:
            yield _issue(
                "info",
                "vc-relax: Pulay stress is significant at low cutoff; raise ecutwfc or check the final scf pressure",
                namelist="SYSTEM",
                key="ecutwfc",
            )
    ct = g("ELECTRONS", "conv_thr")
    if isinstance(ct, (int, float)) and not isinstance(ct, bool):
        nat = g("SYSTEM", "nat", 1) or 1
        if ct > 1e-5:
            yield _issue(
                "warning",
                f"conv_thr={ct} is loose; use ~1e-8 to 1e-10 (scales with system size)",
                namelist="ELECTRONS",
                key="conv_thr",
            )
        if calc in ("relax", "vc-relax") and ct > 1e-6 * max(1, nat):
            yield _issue(
                "info",
                "tight conv_thr (<= 1e-8) gives accurate forces for relaxations",
                namelist="ELECTRONS",
                key="conv_thr",
            )
    for k in ("outdir", "pseudo_dir"):
        v = g("CONTROL", k)
        if isinstance(v, str) and (v.startswith("/") or re.match(r"^[A-Za-z]:\\", v)):
            yield _issue(
                "info",
                f"{k} is an absolute path; QE Studio rewrites it to the job directory at submission",
                namelist="CONTROL",
                key=k,
            )


def _check_ph(qi: QEInput) -> Iterable[Issue]:
    if not qi.preamble:
        yield _issue("error", "ph.x requires a title line before &INPUTPH")
    if "INPUTPH" not in qi.namelists:
        yield _issue("error", "&INPUTPH namelist is required")
        return
    if qi.get("INPUTPH", "ldisp"):
        for k in ("nq1", "nq2", "nq3"):
            v = qi.get("INPUTPH", k)
            if not isinstance(v, int) or v < 1:
                yield _issue("error", f"ldisp=.true. requires {k} >= 1", namelist="INPUTPH", key=k)
    elif not qi.get("INPUTPH", "qplot") and not qi.trailing:
        yield _issue("error", "without ldisp, give the q-point (xq(1) xq(2) xq(3)) after the namelist")
    tr = qi.get("INPUTPH", "tr2_ph")
    if isinstance(tr, float) and tr > 1e-12:
        yield _issue("warning", f"tr2_ph={tr} is loose; 1e-14 to 1e-16 is typical", namelist="INPUTPH", key="tr2_ph")


def _check_matdyn(qi: QEInput) -> Iterable[Issue]:
    if qi.get("INPUT", "flfrc") is None:
        yield _issue("error", "flfrc (force-constant file from q2r.x) is required", namelist="INPUT", key="flfrc")
    if not qi.get("INPUT", "dos"):
        lines = [ln for ln in qi.trailing if ln.strip()]
        if not lines:
            yield _issue("error", "matdyn.x without dos=.true. needs the list of q-points after the namelist")
        else:
            try:
                nq = int(lines[0].split()[0])
                if len(lines) - 1 < nq:
                    yield _issue("error", f"q-point list declares {nq} points but gives {len(lines) - 1}")
            except ValueError:
                yield _issue("error", "first line after &INPUT must be the number of q-points")
    else:
        for k in ("nk1", "nk2", "nk3"):
            if not isinstance(qi.get("INPUT", k), int) or qi.get("INPUT", k) < 1:
                yield _issue("error", f"dos=.true. needs {k} >= 1", namelist="INPUT", key=k)


def _check_pp(qi: QEInput) -> Iterable[Issue]:
    if qi.get("INPUTPP", "plot_num") is None and qi.get("INPUTPP", "filplot") is None:
        yield _issue(
            "warning",
            "plot_num not set: pp.x will compute plot_num=0 (charge density)",
            namelist="INPUTPP",
            key="plot_num",
        )
    if "PLOT" in qi.namelists and qi.get("PLOT", "iflag") is None:
        yield _issue("error", "&PLOT requires iflag (3 = 3D)", namelist="PLOT", key="iflag")


def validate(text: str, program: str | None = None, known_pseudos: set[str] | None = None) -> dict[str, Any]:
    try:
        qi = parse(text, program)
    except QEInputError as exc:
        return {"program": program or "pw", "issues": [_issue("error", exc.raw, exc.line)], "ok": False}
    prog = qi.program
    issues = list(_check_schema(qi, prog))
    if prog == "pw":
        issues += list(_check_pw(qi))
        if known_pseudos is not None and qi.card("ATOMIC_SPECIES") is not None:
            for ln in qi.card("ATOMIC_SPECIES").lines:
                tok = ln.split()
                if len(tok) >= 3 and tok[2] not in known_pseudos:
                    issues.append(
                        _issue(
                            "warning",
                            f"pseudopotential '{tok[2]}' is not in your library; "
                            "upload it on the Pseudopotentials page",
                            qi.card("ATOMIC_SPECIES").line,
                        )
                    )
    elif prog == "ph":
        issues += list(_check_ph(qi))
    elif prog == "matdyn":
        issues += list(_check_matdyn(qi))
    elif prog == "pp":
        issues += list(_check_pp(qi))
    for it in issues:
        if it["line"] is None and it.get("namelist") and it.get("key"):
            it["line"] = qi.key_lines.get(f"{it['namelist']}.{it['key'].lower()}")
    order = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda x: (order[x["severity"]], x["line"] or 0))
    return {"program": prog, "issues": issues, "ok": not any(i["severity"] == "error" for i in issues)}
