import math

import numpy as np
import pytest

from qestudio.core import structure as ST
from qestudio.core.namelist import QEInput, parse, render

BOHR = 0.529177210903


@pytest.mark.parametrize(
    "system,volume_bohr3",
    [
        ({"ibrav": 1, "celldm(1)": 10.0}, 1000.0),
        ({"ibrav": 2, "celldm(1)": 10.0}, 250.0),
        ({"ibrav": 3, "celldm(1)": 10.0}, 500.0),
        ({"ibrav": -3, "celldm(1)": 10.0}, 500.0),
        ({"ibrav": 4, "celldm(1)": 10.0, "celldm(3)": 1.5}, 1000 * 1.5 * math.sqrt(3) / 2),
        ({"ibrav": 6, "celldm(1)": 10.0, "celldm(3)": 1.2}, 1200.0),
        ({"ibrav": 7, "celldm(1)": 10.0, "celldm(3)": 1.2}, 600.0),
        ({"ibrav": 8, "celldm(1)": 10.0, "celldm(2)": 1.1, "celldm(3)": 1.2}, 1320.0),
        ({"ibrav": 9, "celldm(1)": 10.0, "celldm(2)": 1.1, "celldm(3)": 1.2}, 660.0),
        ({"ibrav": 10, "celldm(1)": 10.0, "celldm(2)": 1.1, "celldm(3)": 1.2}, 330.0),
        ({"ibrav": 11, "celldm(1)": 10.0, "celldm(2)": 1.1, "celldm(3)": 1.2}, 660.0),
    ],
)
def test_ibrav_volumes(system, volume_bohr3):
    alat, cell = ST.ibrav_to_cell(system)
    assert alat == pytest.approx(10.0 * BOHR, rel=1e-6)
    assert abs(np.linalg.det(cell)) == pytest.approx(volume_bohr3 * BOHR**3, rel=1e-6)


def test_ibrav_A_form_equals_celldm():
    _, c1 = ST.ibrav_to_cell({"ibrav": 4, "A": 3.0, "C": 4.5})
    _, c2 = ST.ibrav_to_cell({"ibrav": 4, "celldm(1)": 3.0 / BOHR, "celldm(3)": 1.5})
    assert np.allclose(c1, c2, atol=1e-6)


def test_pw_roundtrip(data_dir):
    qi = parse((data_dir / "scf" / "si.scf.in").read_text())
    s = ST.from_pw_input(qi)
    assert len(s["sites"]) == 2 and s["species"]["Si"]["pseudo"] == "Si.pbe-tm-test.UPF"
    out = QEInput()
    ST.apply_to_pw_input(out, s)
    s2 = ST.from_pw_input(parse(render(out)))
    assert np.allclose(s2["cell"], s["cell"], atol=1e-8)
    assert np.allclose([x["xyz"] for x in s2["sites"]], [x["xyz"] for x in s["sites"]], atol=1e-8)


def test_symmetry_and_standardisation():
    si = ST.build("bulk", {"formula": "Si", "crystalstructure": "diamond", "a": 5.43})
    info = ST.analyze(si)
    assert info["symmetry"]["international"] == "Fd-3m" and info["symmetry"]["number"] == 227
    conv = ST.transform(si, "conventional", {})
    assert len(conv["sites"]) == 8
    assert ST.analyze(conv)["lattice"]["a"] == pytest.approx(5.43, abs=1e-6)
    assert len(ST.transform(conv, "primitive", {})["sites"]) == 2


def test_magnetic_labels_lower_symmetry():
    fe = ST.build("bulk", {"formula": "Fe", "crystalstructure": "bcc", "a": 2.87, "cubic": True})
    afm = ST.transform(fe, "substitute", {"indices": [1], "species": "Fe2"})
    assert set(afm["species"]) == {"Fe", "Fe2"}
    assert ST.analyze(afm)["symmetry"]["international"] == "Pm-3m"


def test_kpath_and_kmesh():
    si = ST.build("bulk", {"formula": "Si", "crystalstructure": "diamond", "a": 5.43})
    kp = ST.kpath(si, 60)
    assert kp["labels"][0] == "G" and kp["path"].startswith("GX")
    assert kp["lines"][-1].endswith(" 1")
    assert ST.kmesh(si, 0.2) == [11, 11, 11]


@pytest.mark.parametrize("fmt", ["cif", "poscar", "xyz", "xsf", "json", "pw-in"])
def test_export_import(fmt):
    si = ST.build("bulk", {"formula": "Si", "crystalstructure": "diamond", "a": 5.43})
    text, name = ST.write_any(si, fmt)
    frames = ST.read_any(text.encode(), "POSCAR" if fmt == "poscar" else name)
    assert len(frames[0]["sites"]) == 2


def test_label_to_element():
    for label, el in [("Fe1", "Fe"), ("Fe_up", "Fe"), ("O", "O"), ("SI", "Si"), ("C1", "C"), ("co", "Co")]:
        assert ST.label_to_element(label) == el
    with pytest.raises(ST.StructureError):
        ST.label_to_element("1x")


def test_relax_output_frames(data_dir):
    frames = ST.read_any((data_dir / "relax" / "relax.out").read_bytes(), "relax.out")
    assert len(frames) > 1
