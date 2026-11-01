import pytest

from qestudio import pseudos as PS
from qestudio.core import generate as G
from qestudio.core import structure as ST
from qestudio.core.namelist import parse
from qestudio.core.validate import validate


@pytest.fixture()
def si_input(qes_home, data_dir):
    PS.add_files([("Si.pbe-tm-test.UPF", (data_dir / "Si.header-only.UPF").read_bytes())])
    si = ST.build("bulk", {"formula": "Si", "crystalstructure": "diamond", "a": 5.43})
    return G._r(G.pw_input(si, "scf", {"prefix": "si", "ecutwfc": 30, "kmesh": [4, 4, 4], "occupations": "fixed"}))


def test_generated_scf_is_valid(si_input):
    res = validate(si_input, "pw", PS.known_filenames())
    assert res["ok"], res["issues"]
    qi = parse(si_input)
    assert qi.get("SYSTEM", "ecutrho") == 120.0  # 4x for NC pseudopotentials
    assert qi.card("ATOMIC_SPECIES").lines[0].split()[2] == "Si.pbe-tm-test.UPF"


@pytest.mark.parametrize(
    "kind,args,nsteps",
    [
        ("bands", {"npoints": 40}, 3),
        ("dos", {}, 4),
        ("phonon", {"nq": [2, 2, 2], "npoints": 30}, 5),
        ("density", {}, 2),
        ("convergence", {"parameter": "ecutwfc", "values": [20, 30, 40]}, 3),
        ("eos", {"npoints": 5}, 5),
    ],
)
def test_workflows_produce_valid_steps(si_input, kind, args, nsteps):
    fn = {
        "bands": G.wf_bands,
        "dos": G.wf_dos,
        "phonon": G.wf_phonon,
        "density": G.wf_density,
        "convergence": G.wf_convergence,
        "eos": G.wf_eos,
    }[kind]
    wf = fn(si_input, **args)
    assert len(wf["steps"]) == nsteps and wf["workflow"]["kind"] == kind
    prog = {
        "pw.x": "pw",
        "ph.x": "ph",
        "pp.x": "pp",
        "dos.x": "dos",
        "projwfc.x": "projwfc",
        "bands.x": "bands",
        "q2r.x": "q2r",
        "matdyn.x": "matdyn",
    }
    for st in wf["steps"]:
        res = validate(st["input"], prog[st["program"]], PS.known_filenames())
        assert res["ok"], (st["label"], res["issues"])


def test_phonon_workflow_uses_tetrahedron_dos(si_input):
    wf = G.wf_phonon(si_input, nq=[2, 2, 2])
    dos_step = parse(wf["steps"][-1]["input"], "matdyn")
    assert dos_step.get("INPUT", "dos") is True
    assert dos_step.get("INPUT", "degauss") is None  # tetrahedra: normalised to 3*nat
    assert wf["workflow"]["dos_freq_file"] == "si.dos.freq"  # grid used to validate / replace the DOS


def test_nscf_band_count(si_input):
    wf = G.wf_dos(si_input)
    nscf = parse(wf["steps"][1]["input"])
    assert nscf.get("SYSTEM", "nbnd") == 8  # 8 valence electrons -> 4 occupied, +4 empty
    assert nscf.get("SYSTEM", "occupations") == "tetrahedra_opt"
