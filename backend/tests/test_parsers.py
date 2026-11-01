import json

import numpy as np
import pytest

from qestudio.analysis import analyze_job, parse_uploaded
from qestudio.core.parsers import post as P
from qestudio.core.parsers.pw_out import RY_EV, parse_pw_output
from qestudio.core.parsers.pw_xml import band_gap, parse_pw_xml
from qestudio.core.upf import parse_upf_header


def test_pw_scf_output(data_dir):
    r = parse_pw_output((data_dir / "scf" / "si.scf.out").read_text())
    assert r["status"] == "done" and r["job_done"] and r["scf_converged"]
    assert r["version"] == "7.6"
    assert r["final_energy_ry"] == pytest.approx(-20.41157462)
    assert r["final_energy_ev"] == pytest.approx(-20.41157462 * RY_EV)
    assert r["nat"] == 2 and r["nelec"] == 8.0
    step = r["ionic_steps"][0]
    assert step["n_scf"] == 5 and len(step["scf"]) == 5
    assert step["scf"][-1]["accuracy_ry"] < 1e-8
    assert step["forces"] and step["pressure_kbar"] is not None


def test_pw_relax_output(data_dir):
    r = parse_pw_output((data_dir / "relax" / "relax.out").read_text())
    assert r["relax"]["converged"] is True
    assert len(r["ionic_steps"]) == r["relax"]["scf_cycles"]
    energies = r["relax"]["energies_ev"]
    assert energies[-1] <= energies[0]


def test_truncated_output_is_incomplete(data_dir):
    text = (data_dir / "scf" / "si.scf.out").read_text()
    r = parse_pw_output(text[: len(text) // 2])
    assert r["status"] == "incomplete" and not r["job_done"]


def test_xml_and_gap(data_dir):
    x = parse_pw_xml((data_dir / "bands" / "bands.xml").read_bytes())
    b = x["bands"]
    assert b["nbnd"] == 8 and not b["lsda"]
    gap = band_gap(b["eigenvalues_ev"], b["homo_ev"], b["fermi_energy_ev"])
    assert gap and not gap["metal"]
    assert 0.3 < gap["gap_ev"] < 1.2  # PBE silicon (indirect)
    assert gap["direct"] is False


def test_dos_and_pdos(data_dir):
    d = P.parse_dos((data_dir / "dos" / "si.dos").read_text())
    assert d["fermi_energy_ev"] == pytest.approx(6.868)
    assert not d["spin"] and len(d["dos"]) == len(d["energy_ev"])
    # integrated DOS at the Fermi level = number of valence electrons (Si2: 2 x 4)
    assert np.interp(d["fermi_energy_ev"], d["energy_ev"], d["int_dos"]) == pytest.approx(8.0, abs=0.02)
    files = {p.name: p.read_text() for p in (data_dir / "dos").iterdir() if ".pdos_" in p.name}
    pd = P.parse_pdos_files(files)
    assert set(pd["by_element"]) == {"Si"}
    assert set(pd["by_orbital"]) == {"Si-s", "Si-p"}
    assert set(pd["by_atom"]) == {"Si1", "Si2"}


def test_matdyn_frequencies_qe76_format(data_dir):
    f = P.parse_matdyn_freq((data_dir / "phonon" / "si.freq").read_text())
    assert f["nks"] == 41 and f["nbnd"] == 6
    assert f["q_2pi_alat"][1] == pytest.approx([0.0, 0.117851, 0.0])
    gamma = f["freq_cm1"][0]
    assert max(abs(x) for x in gamma[:3]) < 1.0  # acoustic modes vanish at Gamma
    assert 450 < gamma[-1] < 600  # Si optical mode


def test_phdos_nan_is_flagged(data_dir):
    d = P.parse_phdos((data_dir / "phonon" / "si.phdos").read_text())
    assert d["has_nan"] is True  # produced by matdyn's tetrahedron DOS in this build


def test_phonon_dos_from_grid_is_normalised_to_3nat(data_dir):
    g = P.parse_matdyn_freq((data_dir / "phonon" / "si.dos.freq").read_text())
    assert sum(g["col4"]) == pytest.approx(1.0, abs=1e-4)  # q weights of the 8x8x8 grid
    d = P.phonon_dos_from_grid(np.array(g["freq_cm1"]), np.array(g["col4"]), sigma_cm1=4.0)
    assert np.trapezoid(d["dos"], d["freq_cm1"]) == pytest.approx(6.0, rel=1e-3)  # 3 * 2 atoms


def test_nan_matdyn_dos_is_replaced(data_dir):
    from qestudio.analysis import _checked_phonon_dos

    d = _checked_phonon_dos(
        P.parse_phdos((data_dir / "phonon" / "si.phdos").read_text()), data_dir / "phonon" / "si.dos.freq"
    )
    assert d["source"] == "qestudio" and "NaN" in d["note"]
    assert d["integral"] == pytest.approx(6.0, rel=1e-3)


def test_well_normalised_matdyn_dos_is_kept(data_dir):
    from qestudio.analysis import _checked_phonon_dos

    g = P.parse_matdyn_freq((data_dir / "phonon" / "si.dos.freq").read_text())
    good = P.phonon_dos_from_grid(np.array(g["freq_cm1"]), np.array(g["col4"]), sigma_cm1=2.0)
    d = _checked_phonon_dos(good, data_dir / "phonon" / "si.dos.freq")
    assert d["source"] == "matdyn" and d["integral"] == pytest.approx(6.0, rel=1e-3)
    scaled = {**good, "dos": [0.7 * v for v in good["dos"]]}  # what matdyn's Gaussian DOS gave in QE 7.6
    assert _checked_phonon_dos(scaled, data_dir / "phonon" / "si.dos.freq")["source"] == "qestudio"


def test_cube_and_isosurface(data_dir):
    c = P.parse_cube((data_dir / "density" / "si_plot0.cube").read_text())
    assert c["shape"] == [24, 24, 24]
    assert c["stats"]["integral"] == pytest.approx(8.0, abs=1e-3)  # 8 valence electrons
    iso = P.isosurface(c, P.suggest_levels(c)[1])
    assert len(iso["vertices"]) > 0 and len(iso["faces"]) % 3 == 0


def test_path_distances_with_breaks():
    k = np.array([[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [5, 5, 5], [5.5, 5, 5]], dtype=float)
    out = P.path_distances(k, ["G", "X", "K", "U"], [2, 1, 1, 1])
    assert [t["label"] for t in out["ticks"]] == ["Γ", "X|K", "U"] or out["breaks"]


def test_upf_header(data_dir):
    h = parse_upf_header((data_dir / "Si.header-only.UPF").read_text())
    assert h["element"] == "Si" and h["type"] == "NC" and h["z_valence"] == 4.0 and h["functional"] == "PBE"


@pytest.mark.parametrize("kind", ["bands", "dos", "phonon", "density"])
def test_analyze_job_kinds(data_dir, kind):
    d = data_dir / kind
    wf = json.loads((d / "workflow.json").read_text())
    programs = {
        "bands": ["pw.x", "pw.x", "bands.x"],
        "dos": ["pw.x", "pw.x", "dos.x", "projwfc.x"],
        "phonon": ["pw.x", "ph.x", "q2r.x", "matdyn.x"],
        "density": ["pw.x", "pp.x"],
    }[kind]
    names = {
        "bands": ["scf", "bands", "bandsx"],
        "dos": ["scf", "nscf", "dos", "projwfc"],
        "phonon": ["scf", "ph", "q2r", "matdyn"],
        "density": ["scf", "pp"],
    }[kind]
    steps = [
        {"program": p, "input_name": f"{n}.in", "output_name": f"{n}.out", "cwd": "."} for p, n in zip(programs, names)
    ]
    res = analyze_job(d, steps, wf)
    assert "error" not in res, res.get("error")
    assert kind in res
    if kind == "bands":
        assert res["bands"]["ticks"][0]["label"] == "Γ"
        assert not res["bands"]["gap"]["metal"]


def test_parse_uploaded_detects_formats(data_dir):
    assert parse_uploaded("si.scf.out", (data_dir / "scf" / "si.scf.out").read_text())["type"] == "pw"
    assert parse_uploaded("x.xml", (data_dir / "bands" / "scf.xml").read_text())["type"] == "xml"
    assert parse_uploaded("si.freq", (data_dir / "phonon" / "si.freq").read_text())["type"] == "phonon_freq"
    assert parse_uploaded("si.dos", (data_dir / "dos" / "si.dos").read_text())["type"] == "dos"
    with pytest.raises(ValueError):
        parse_uploaded("random.txt", "hello")


def test_units_match_quantum_espresso(data_dir):
    """QE 7.6 converted the 2.715 Angstrom cell vectors of this run with its Bohr radius:
    our constant must reproduce the value written to the XML to machine precision."""
    import re

    from qestudio.core.units import BOHR_A, EV_PER_A3_TO_GPA, HA_EV, RY_EV

    a1 = re.search(r"<a1>([^<]*)</a1>", (data_dir / "bands" / "scf.xml").read_text()).group(1).split()
    assert float(a1[1]) == pytest.approx(2.715 / BOHR_A, rel=1e-14)
    assert pytest.approx(2 * RY_EV, rel=1e-15) == HA_EV
    assert pytest.approx(1.602176634e-19 * 1e30 / 1e9, rel=1e-12) == EV_PER_A3_TO_GPA
