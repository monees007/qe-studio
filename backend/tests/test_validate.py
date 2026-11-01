from qestudio.core.validate import validate


def messages(text, program=None):
    return [(i["severity"], i["message"]) for i in validate(text, program)["issues"]]


def test_valid_input_has_no_issues(data_dir):
    res = validate((data_dir / "scf" / "si.scf.in").read_text())
    assert res["ok"], res["issues"]
    assert res["issues"] == []


def test_common_mistakes_are_reported():
    bad = """&control
  calculation = scf
/
&system
  ibrav=2, celldm(1)=10.2, nat=3, ntyp=1, ecutwfc=30, ecutrho=60, occupations='smearing', nspin=2, ecutwf=3
  conv_thr=1e-6
/
&electrons
/
ATOMIC_SPECIES
 Si 28 Si.upf
ATOMIC_POSITIONS crystal
 Si 0 0 0
 Ge 0.25 0.25 0.25
K_POINTS automatic
 4 4 4 0 0 2
"""
    found = " | ".join(m for _, m in messages(bad))
    for expected in (
        "must be quoted",
        "nat=3 but ATOMIC_POSITIONS has 2",
        "belongs to &ELECTRONS",
        "'Ge' in ATOMIC_POSITIONS is not defined",
        "shifts must be 0 or 1",
        "requires degauss",
        "starting_magnetization",
        "did you mean 'ecutwfc'",
        "ecutrho < 4*ecutwfc",
    ):
        assert expected in found, expected
    assert not validate(bad)["ok"]


def test_removed_lda_plus_u_is_an_error():
    text = (
        "&control\n/\n&system\n ibrav=1, celldm(1)=10, nat=1, ntyp=1, ecutwfc=30, lda_plus_u=.true.\n/\n"
        "&electrons\n/\nATOMIC_SPECIES\n Fe 55.8 Fe.upf\nATOMIC_POSITIONS crystal\n Fe 0 0 0\nK_POINTS gamma\n"
    )
    assert any("HUBBARD card" in m for _, m in messages(text))


def test_ph_requires_title_and_qmesh():
    msgs = " | ".join(m for _, m in messages("&inputph\n ldisp=.true.\n/\n", "ph"))
    assert "title line" in msgs and "nq1" in msgs


def test_parse_error_reported_with_line():
    res = validate("&control\n calculation='scf'\n")
    assert not res["ok"] and res["issues"][0]["line"] == 1
