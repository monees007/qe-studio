"""Parser and writer for Quantum ESPRESSO input files.

Handles Fortran namelists (&NAME ... /) with comments, quoted strings containing '/' or
'!', indexed keys (celldm(1), starting_ns_eigenvalue(1,2,1)), repeat counts (3*0.0),
d-exponents, plus the pw.x cards and free-form trailing sections used by ph.x / matdyn.x.
The parser is lossless for everything QE itself reads (comments are dropped).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

PW_CARDS = [
    "ATOMIC_SPECIES",
    "ATOMIC_POSITIONS",
    "K_POINTS",
    "ADDITIONAL_K_POINTS",
    "CELL_PARAMETERS",
    "CONSTRAINTS",
    "OCCUPATIONS",
    "ATOMIC_VELOCITIES",
    "ATOMIC_FORCES",
    "SOLVENTS",
    "HUBBARD",
    "TOTAL_CHARGE",
]
NEB_CARDS = [
    "BEGIN",
    "BEGIN_PATH_INPUT",
    "END_PATH_INPUT",
    "BEGIN_ENGINE_INPUT",
    "END_ENGINE_INPUT",
    "BEGIN_POSITIONS",
    "END_POSITIONS",
    "FIRST_IMAGE",
    "INTERMEDIATE_IMAGE",
    "LAST_IMAGE",
    "END",
    "CLIMBING_IMAGES",
]

NAMELIST_ORDER = {
    "pw": ["CONTROL", "SYSTEM", "ELECTRONS", "IONS", "CELL", "FCP", "RISM"],
    "ph": ["INPUTPH"],
    "pp": ["INPUTPP", "PLOT"],
    "dos": ["DOS"],
    "projwfc": ["PROJWFC"],
    "bands": ["BANDS"],
    "q2r": ["INPUT"],
    "matdyn": ["INPUT"],
    "hp": ["INPUTHP"],
}

# which program a namelist name implies (for auto-detection)
NAMELIST_PROGRAM = {
    "CONTROL": "pw",
    "SYSTEM": "pw",
    "ELECTRONS": "pw",
    "IONS": "pw",
    "CELL": "pw",
    "INPUTPH": "ph",
    "INPUTPP": "pp",
    "PLOT": "pp",
    "DOS": "dos",
    "PROJWFC": "projwfc",
    "BANDS": "bands",
    "INPUTHP": "hp",
}

PROGRAM_EXE = {
    "pw": "pw.x",
    "ph": "ph.x",
    "pp": "pp.x",
    "dos": "dos.x",
    "projwfc": "projwfc.x",
    "bands": "bands.x",
    "q2r": "q2r.x",
    "matdyn": "matdyn.x",
    "hp": "hp.x",
    "neb": "neb.x",
}


class QEInputError(ValueError):
    def __init__(self, message: str, line: int | None = None):
        super().__init__(message if line is None else f"line {line}: {message}")
        self.line = line
        self.raw = message


@dataclass
class Card:
    name: str
    option: str | None = None
    lines: list[str] = field(default_factory=list)
    line: int | None = None  # 1-based line number of the header

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "option": self.option, "lines": self.lines}


@dataclass
class QEInput:
    program: str = "pw"
    preamble: list[str] = field(default_factory=list)  # e.g. ph.x title line
    namelists: dict[str, dict[str, Any]] = field(default_factory=dict)
    cards: list[Card] = field(default_factory=list)
    trailing: list[str] = field(default_factory=list)  # free text after namelists (non-pw)
    key_lines: dict[str, int] = field(default_factory=dict)  # "NL.key" -> line number
    unquoted: set[str] = field(default_factory=set)  # "NL.key" whose string value had no quotes

    # ----------------------------------------------------------------- access
    def nl(self, name: str, create: bool = False) -> dict[str, Any]:
        name = name.upper()
        if name not in self.namelists:
            if not create:
                return {}
            self.namelists[name] = {}
        return self.namelists[name]

    def get(self, namelist: str, key: str, default: Any = None) -> Any:
        d = self.nl(namelist)
        lk = key.lower()
        for k, v in d.items():
            if k.lower() == lk:
                return v
        return default

    def set(self, namelist: str, key: str, value: Any) -> None:
        d = self.nl(namelist, create=True)
        lk = key.lower()
        for k in list(d):
            if k.lower() == lk:
                if value is None:
                    del d[k]
                else:
                    d[k] = value
                return
        if value is not None:
            d[key] = value

    def card(self, name: str) -> Card | None:
        for c in self.cards:
            if c.name == name.upper():
                return c
        return None

    def set_card(self, card: Card) -> None:
        for i, c in enumerate(self.cards):
            if c.name == card.name:
                self.cards[i] = card
                return
        self.cards.append(card)

    def remove_card(self, name: str) -> None:
        self.cards = [c for c in self.cards if c.name != name.upper()]

    def indexed(self, namelist: str, base: str) -> dict[str, Any]:
        """All entries 'base(...)' -> {'1': v, '2': v} (index string without parentheses)."""
        out: dict[str, Any] = {}
        pat = re.compile(rf"^{re.escape(base)}\((.+)\)$", re.I)
        for k, v in self.nl(namelist).items():
            m = pat.match(k)
            if m:
                out[m.group(1).replace(" ", "")] = v
        return out

    def to_dict(self) -> dict[str, Any]:
        return {
            "program": self.program,
            "preamble": self.preamble,
            "namelists": self.namelists,
            "cards": [c.to_dict() for c in self.cards],
            "trailing": self.trailing,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> QEInput:
        return cls(
            program=d.get("program", "pw"),
            preamble=list(d.get("preamble") or []),
            namelists={k.upper(): dict(v) for k, v in (d.get("namelists") or {}).items()},
            cards=[Card(c["name"].upper(), c.get("option"), list(c.get("lines") or [])) for c in d.get("cards") or []],
            trailing=list(d.get("trailing") or []),
        )


# ----------------------------------------------------------------------------- values
_INT = re.compile(r"^[+-]?\d+$")
_REAL = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eEdDqQ][+-]?\d+)?$")
_TRUE = {".true.", ".t.", "t", "true", ".true", "true."}
_FALSE = {".false.", ".f.", "f", "false", ".false", "false."}


def parse_scalar(tok: str) -> Any:
    t = tok.strip()
    if not t:
        return None
    if (t[0] == t[-1]) and t[0] in "'\"" and len(t) >= 2:
        q = t[0]
        return t[1:-1].replace(q * 2, q)
    low = t.lower()
    if low in _TRUE:
        return True
    if low in _FALSE:
        return False
    if _INT.match(t):
        return int(t)
    if _REAL.match(t):
        return float(re.sub(r"[dDqQ]", "e", t))
    return t  # unquoted string (QE would usually reject; validator flags it)


def _split_values(text: str) -> list[str]:
    """Split a value list on commas / whitespace outside quotes."""
    toks, buf, q = [], [], None
    for ch in text:
        if q:
            buf.append(ch)
            if ch == q:
                q = None
            continue
        if ch in "'\"":
            q = ch
            buf.append(ch)
        elif ch in ", \t\n\r":
            if buf:
                toks.append("".join(buf))
                buf = []
        else:
            buf.append(ch)
    if buf:
        toks.append("".join(buf))
    return toks


def parse_value(text: str) -> Any:
    toks = _split_values(text)
    vals: list[Any] = []
    for t in toks:
        m = re.match(r"^(\d+)\*(.+)$", t)
        if m and not (t.startswith("'") or t.startswith('"')):
            vals.extend([parse_scalar(m.group(2))] * int(m.group(1)))
        else:
            vals.append(parse_scalar(t))
    if not vals:
        return None
    return vals[0] if len(vals) == 1 else vals


def format_value(v: Any) -> str:
    if isinstance(v, bool):
        return ".true." if v else ".false."
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if not math.isfinite(v):
            raise QEInputError(f"invalid real value {v}")
        if v.is_integer() and abs(v) < 1e15:
            return f"{v:.1f}"
        r = repr(v)
        return r
    if isinstance(v, (list, tuple)):
        return ", ".join(format_value(x) for x in v)
    s = str(v)
    return "'" + s.replace("'", "''") + "'"


def normalize_key(k: str) -> str:
    k = k.strip()
    m = re.match(r"^([A-Za-z_]\w*)\s*\((.*)\)$", k)
    if m:
        return f"{m.group(1)}({m.group(2).replace(' ', '')})"
    return k


# ----------------------------------------------------------------------------- parsing
def _strip_comment(line: str) -> str:
    q = None
    for i, ch in enumerate(line):
        if q:
            if ch == q:
                q = None
        elif ch in "'\"":
            q = ch
        elif ch == "!":
            return line[:i]
    return line


def _mask_quotes(s: str) -> str:
    out, q = [], None
    for ch in s:
        if q:
            out.append(ch if ch == q else "_")
            if ch == q:
                q = None
        elif ch in "'\"":
            q = ch
            out.append(ch)
        else:
            out.append(ch)
    return "".join(out)


_ASSIGN = re.compile(r"([A-Za-z_]\w*(?:\s*\([^)=]*\))?)\s*=")


def _parse_namelist_body(
    body: str, start_line: int, name: str, key_lines: dict[str, int], unquoted: set[str] | None = None
) -> dict[str, Any]:
    masked = _mask_quotes(body)
    matches = list(_ASSIGN.finditer(masked))
    out: dict[str, Any] = {}
    if not matches and body.strip().strip(","):
        raise QEInputError(f"cannot parse namelist &{name}: '{body.strip()[:60]}'", start_line)
    pre = masked[: matches[0].start()].strip().strip(",") if matches else ""
    if pre:
        raise QEInputError(f"unexpected text in &{name}: '{pre[:60]}'", start_line)
    for i, m in enumerate(matches):
        key = normalize_key(m.group(1))
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        raw = body[m.end() : end].strip().rstrip(",").strip()
        if raw == "":
            raise QEInputError(f"missing value for '{key}' in &{name}", start_line + body[: m.start()].count("\n"))
        val = parse_value(raw)
        if isinstance(val, list):
            toks = _split_values(raw)
            bad = [t for t in toks if t[:1] not in "'\"" and isinstance(parse_scalar(t.split("*")[-1]), str)]
            if bad:
                raise QEInputError(
                    f"unexpected token '{bad[0]}' in value of '{key}' (missing '=' or comma?)",
                    start_line + body[: m.start()].count("\n"),
                )
        out[key] = val
        key_lines[f"{name}.{key.lower()}"] = start_line + body[: m.start()].count("\n")
        if unquoted is not None and isinstance(val, str) and raw[:1] not in "'\"":
            unquoted.add(f"{name}.{key.lower()}")
    return out


def detect_program(text: str) -> str:
    names = re.findall(r"^\s*&(\w+)", text, re.M)
    for n in names:
        p = NAMELIST_PROGRAM.get(n.upper())
        if p:
            return p
    if any(n.upper() == "INPUT" for n in names):
        low = text.lower()
        if (
            "flfrc" in low
            and ("asr" in low or "flfrq" in low or "q_in_band_form" in low or "dos" in low)
            and "fildyn" not in low
        ):
            return "matdyn"
        return "q2r"
    if re.search(r"BEGIN_PATH_INPUT", text, re.I):
        return "neb"
    return "pw"


def parse(text: str, program: str | None = None) -> QEInput:
    program = program or detect_program(text)
    qi = QEInput(program=program)
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i, n = 0, len(lines)
    in_nl: str | None = None
    nl_start = 0
    nl_buf: list[str] = []
    seen_namelist = False
    card_names = PW_CARDS if program == "pw" else []
    card_re = (
        re.compile(r"^\s*(" + "|".join(card_names) + r")\b\s*(?:[{(]\s*([^})]*?)\s*[})]|([A-Za-z_\-]+))?\s*$", re.I)
        if card_names
        else None
    )
    current_card: Card | None = None

    while i < n:
        raw = lines[i]
        lineno = i + 1
        i += 1
        if in_nl is not None:
            stripped = _strip_comment(raw)
            # find terminating '/' outside quotes
            q, term = None, -1
            for j, ch in enumerate(stripped):
                if q:
                    if ch == q:
                        q = None
                elif ch in "'\"":
                    q = ch
                elif ch == "/":
                    term = j
                    break
            if term >= 0 or re.match(r"^\s*&end\s*$", stripped, re.I):
                if term >= 0:
                    nl_buf.append(stripped[:term])
                body = "\n".join(nl_buf)
                vals = _parse_namelist_body(body, nl_start, in_nl, qi.key_lines, qi.unquoted)
                if in_nl in qi.namelists:
                    qi.namelists[in_nl].update(vals)
                else:
                    qi.namelists[in_nl] = vals
                in_nl = None
                nl_buf = []
                rest = stripped[term + 1 :].strip() if term >= 0 else ""
                if rest:
                    raise QEInputError(f"unexpected text after namelist terminator: '{rest}'", lineno)
            else:
                nl_buf.append(stripped)
            continue

        m = re.match(r"^\s*&(\w+)(.*)$", raw)
        if m and current_card is None:
            in_nl = m.group(1).upper()
            nl_start = lineno
            seen_namelist = True
            rest = _strip_comment(m.group(2))
            # single-line namelist: &system ibrav=2 /
            q, term = None, -1
            for j, ch in enumerate(rest):
                if q:
                    if ch == q:
                        q = None
                elif ch in "'\"":
                    q = ch
                elif ch == "/":
                    term = j
                    break
            if term >= 0:
                vals = _parse_namelist_body(rest[:term], lineno, in_nl, qi.key_lines, qi.unquoted)
                qi.namelists.setdefault(in_nl, {}).update(vals)
                in_nl = None
            else:
                nl_buf = [rest]
            continue

        if not seen_namelist:
            if raw.strip() or qi.preamble:
                qi.preamble.append(raw.rstrip())
            continue

        if card_re is not None:
            stripped = _strip_comment(raw).rstrip()
            if not stripped.strip() or stripped.strip().startswith("#"):
                continue
            cm = card_re.match(stripped)
            if cm:
                opt = cm.group(2) if cm.group(2) is not None else cm.group(3)
                current_card = Card(cm.group(1).upper(), opt.strip().lower() if opt else None, [], lineno)
                qi.cards.append(current_card)
                continue
            if current_card is None:
                raise QEInputError(f"unexpected line outside any card: '{stripped.strip()[:60]}'", lineno)
            current_card.lines.append(stripped.strip())
        elif raw.strip() or qi.trailing:
            qi.trailing.append(raw.rstrip())

    if in_nl is not None:
        raise QEInputError(f"namelist &{in_nl} is not terminated with '/'", nl_start)
    while qi.trailing and not qi.trailing[-1].strip():
        qi.trailing.pop()
    while qi.preamble and not qi.preamble[-1].strip():
        qi.preamble.pop()
    return qi


# ----------------------------------------------------------------------------- writing
def _key_sort(program: str, nl: str, keys: list[str], schema_order: dict[str, int] | None) -> list[str]:
    if not schema_order:
        return keys

    def k(key: str) -> tuple[int, str]:
        base = key.split("(", maxsplit=1)[0].lower()
        return (schema_order.get(base, 10_000), key.lower())

    return sorted(keys, key=k)


def render(qi: QEInput, sort_keys: bool = False, schema_order: dict[str, dict[str, int]] | None = None) -> str:
    out: list[str] = []
    if qi.preamble:
        out.extend(qi.preamble)
    order = NAMELIST_ORDER.get(qi.program, [])
    names = [n for n in order if n in qi.namelists] + [n for n in qi.namelists if n not in order]
    # pw.x needs CONTROL, SYSTEM, ELECTRONS (possibly empty) and IONS/CELL for some calculations
    if qi.program == "pw":
        calc = str(qi.get("CONTROL", "calculation", "scf")).lower()
        required = ["CONTROL", "SYSTEM", "ELECTRONS"]
        if calc in ("relax", "md", "vc-relax", "vc-md"):
            required.append("IONS")
        if calc in ("vc-relax", "vc-md"):
            required.append("CELL")
        for r in required:
            if r not in names:
                names.append(r)
        names = [n for n in order if n in names] + [n for n in names if n not in order]
    for name in names:
        vals = qi.namelists.get(name, {})
        out.append(f"&{name}")
        keys = list(vals.keys())
        if sort_keys and schema_order:
            keys = _key_sort(qi.program, name, keys, schema_order.get(name))
        width = max((len(k) for k in keys), default=0)
        for k in keys:
            v = vals[k]
            if v is None:
                continue
            out.append(f"  {k.ljust(width)} = {format_value(v)}")
        out.append("/")
    for c in qi.cards:
        header = c.name + (f" {{{c.option}}}" if c.option else "")
        out.append(header)
        out.extend("  " + ln.strip() for ln in c.lines)
    if qi.trailing:
        out.extend(qi.trailing)
    return "\n".join(out) + "\n"
