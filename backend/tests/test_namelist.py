import pytest

from qestudio.core.namelist import QEInputError, detect_program, format_value, parse, parse_value, render


def test_parse_and_render_roundtrip(data_dir):
    text = (data_dir / "scf" / "si.scf.in").read_text()
    qi = parse(text)
    assert qi.program == "pw"
    assert qi.get("CONTROL", "calculation") == "scf"
    assert qi.get("SYSTEM", "celldm(1)") == pytest.approx(10.26)
    assert qi.get("system", "ECUTWFC") == 30.0  # case-insensitive access
    assert [c.name for c in qi.cards] == ["ATOMIC_SPECIES", "ATOMIC_POSITIONS", "K_POINTS"]
    again = parse(render(qi))
    assert again.namelists == qi.namelists
    assert [c.to_dict() for c in again.cards] == [c.to_dict() for c in qi.cards]


def test_values_and_comments():
    qi = parse("""&control
  outdir = './a/b/'   ! slash inside quotes and a comment / here
  prefix="it's"  , tprnfor=.TRUE., tstress = T
/
&system
  ibrav=2, celldm(1)=1.0d1, nat=1, ntyp=1, ecutwfc=2*3.0d1
  starting_magnetization( 1 ) = 0.5
/
""")
    assert qi.get("CONTROL", "outdir") == "./a/b/"
    assert qi.get("CONTROL", "prefix") == "it's"
    assert qi.get("CONTROL", "tprnfor") is True and qi.get("CONTROL", "tstress") is True
    assert qi.get("SYSTEM", "celldm(1)") == 10.0
    assert qi.get("SYSTEM", "ecutwfc") == [30.0, 30.0]
    assert qi.get("SYSTEM", "starting_magnetization(1)") == 0.5


def test_single_line_namelist_and_gamma():
    qi = parse("&control calculation='scf' /\n&system ibrav=1 /\n&electrons\n/\nK_POINTS gamma\n")
    assert qi.get("SYSTEM", "ibrav") == 1
    assert qi.card("K_POINTS").option == "gamma"


@pytest.mark.parametrize(
    "text,msg",
    [
        ("&control\n calculation='scf'\n", "not terminated"),
        ("&control\n ecutwf = 3\n tpr calculation = 'scf'\n/\n", "unexpected token"),
        ("&system\n nat =\n/\n", "missing value"),
        ("&control\n/\nrandom line\n", "outside any card"),
    ],
)
def test_syntax_errors(text, msg):
    with pytest.raises(QEInputError, match=msg):
        parse(text, "pw")


def test_ph_title_and_matdyn_trailing():
    ph = parse("phonons of Si\n&inputph\n prefix='si', ldisp=.true., nq1=2,nq2=2,nq3=2\n/\n")
    assert ph.program == "ph" and ph.preamble == ["phonons of Si"]
    md = parse("&input\n flfrc='si.fc', asr='crystal', q_in_band_form=.true.\n/\n2\n0 0 0 10\n0.5 0 0.5 1\n")
    assert md.program == "matdyn"
    assert md.trailing[0].strip() == "2"
    assert render(md).rstrip().endswith("0.5 0 0.5 1")


def test_detect_program():
    assert detect_program("&inputpp\n/\n") == "pp"
    assert detect_program("&dos\n/\n") == "dos"
    assert detect_program("&input\n fildyn='a', flfrc='b'\n/\n") == "q2r"


def test_format_value():
    assert format_value(True) == ".true."
    assert format_value(30.0) == "30.0"
    assert format_value(1e-10) == "1e-10"
    assert format_value("it's") == "'it''s'"
    assert parse_value("3*0.5") == [0.5, 0.5, 0.5]


def test_render_adds_required_namelists():
    qi = parse(
        "&control\n calculation='vc-relax'\n/\n&system\n ibrav=1, celldm(1)=10, nat=1, ntyp=1, ecutwfc=30\n/\n"
        "ATOMIC_SPECIES\n Si 28 Si.upf\nATOMIC_POSITIONS crystal\n Si 0 0 0\nK_POINTS gamma\n"
    )
    out = render(qi)
    for nl in ("&ELECTRONS", "&IONS", "&CELL"):
        assert nl in out
