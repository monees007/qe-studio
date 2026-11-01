"""Generate qestudio/data/qe_schema.json from the PWgui module definitions that ship
with Quantum ESPRESSO (share/GUI/PWgui/modules/*). Those files embed the official
INPUT_*.def documentation (GPL-2.0-or-later; PWgui (c) Anton Kokalj, docs (c) the QE developers).

Usage:  python tools/gen_schema.py <path-to-PWgui/modules> <out.json>
"""
from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path

MODULES = {
    "pw": ("pw/pw.tcl", "pw/pw-help.tcl"),
    "ph": ("ph/ph.tcl", "ph/ph-help.tcl"),
    "pp": ("pp/pp.tcl", "pp/pp-help.tcl"),
    "dos": ("dos/dos.tcl", "dos/dos-help.tcl"),
    "projwfc": ("projwfc/projwfc.tcl", "projwfc/projwfc-help.tcl"),
    "bands": ("bands/bands.tcl", "bands/bands-help.tcl"),
    "hp": ("hp/hp.tcl", "hp/hp-help.tcl"),
    "neb": ("neb/neb.tcl", "neb/neb-help.tcl"),
}


# --------------------------------------------------------------------------- Tcl
def tcl_commands(src: str) -> list[list[str]]:
    """Split a Tcl script into commands (lists of words). Braced words keep their
    raw content (without outer braces); quoted words are unquoted."""
    cmds: list[list[str]] = []
    words: list[str] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "\\" and i + 1 < n and src[i + 1] == "\n":
            i += 2
            continue
        if c in " \t\r":
            i += 1
            continue
        if c in "\n;":
            if words:
                cmds.append(words)
                words = []
            i += 1
            continue
        if c == "#" and not words:
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "{":
            depth, j = 1, i + 1
            while j < n and depth:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "{":
                    depth += 1
                elif src[j] == "}":
                    depth -= 1
                j += 1
            words.append(src[i + 1 : j - 1])
            i = j
            continue
        if c == '"':
            j = i + 1
            buf = []
            while j < n and src[j] != '"':
                if src[j] == "\\" and j + 1 < n:
                    buf.append(src[j + 1])
                    j += 2
                    continue
                buf.append(src[j])
                j += 1
            words.append("".join(buf))
            i = j + 1
            continue
        j = i
        while j < n and src[j] not in " \t\r\n;":
            if src[j] == "\\" and j + 1 < n:
                j += 2
                continue
            j += 1
        words.append(src[i:j])
        i = j
    if words:
        cmds.append(words)
    return cmds


def parse_opts(words: list[str]) -> dict[str, str]:
    """Parse '-key value' pairs (either inline or from a braced option block)."""
    if len(words) == 1 and "-" in words[0]:
        flat = [w for cmd in tcl_commands(words[0]) for w in cmd]
    else:
        flat = words
    opts: dict[str, str] = {}
    k = 0
    while k < len(flat):
        if flat[k].startswith("-") and k + 1 < len(flat):
            opts[flat[k][1:]] = flat[k + 1]
            k += 2
        else:
            k += 1
    return opts


CONTAINERS = {"module", "page", "optional", "required", "group", "line", "packwidgets",
              "frame", "notebook", "scrollframe", "section", "tabpage"}


def walk(src: str, out: dict, namelist: str | None, required: bool) -> None:
    for cmd in tcl_commands(src):
        head = cmd[0]
        if head == "namelist" and len(cmd) >= 3:
            nm_opts = parse_opts(cmd[2:-1])
            nm = nm_opts.get("name", cmd[1]).upper()
            out.setdefault(nm, {})
            walk(cmd[-1], out, nm, False)
        elif head in ("var", "dimension") and len(cmd) >= 2 and namelist:
            name = cmd[1]
            opts = parse_opts(cmd[2:])
            values = None
            if "value" in opts:
                vals = [w for c in tcl_commands(opts["value"]) for w in c]
                values = [v.strip("'\"") for v in vals if v.strip()]
            out[namelist][name] = {
                "label": re.sub(r"\s*\([^)]*\):?\s*$", "", opts.get("label", "")).rstrip(":").replace("\\[", "[").replace("\\]", "]"),
                "options": values,
                "validate": opts.get("validate"),
                "dimension": head == "dimension",
                "required_gui": required,
            }
        elif head in CONTAINERS or (len(cmd) >= 2 and "{" not in head and cmd[-1].count("\n") > 1 and head not in ("help", "proc", "if", "foreach", "tracevar", "keyword", "table", "text", "auto")):
            if head == "required":
                walk(cmd[-1], out, namelist, True)
            elif head == "optional":
                walk(cmd[-1], out, namelist, False)
            else:
                walk(cmd[-1], out, namelist, required)


def strip_html(s: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"</?(dt|dd|li|p|blockquote|pre|dl|ul)[^>]*>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    lines = [ln.rstrip() for ln in s.splitlines()]
    out, blank = [], False
    for ln in lines:
        if not ln.strip():
            if not blank and out:
                out.append("")
            blank = True
        else:
            out.append(ln.strip())
            blank = False
    return "\n".join(out).strip()


def parse_help(src: str) -> dict[str, dict]:
    helps: dict[str, dict] = {}
    for cmd in tcl_commands(src):
        if cmd[0] != "help" or len(cmd) < 2:
            continue
        opts = parse_opts(cmd[2:])
        text = opts.get("helptext", "")
        info: dict[str, str] = {}
        m = re.search(r"<em>Type: </em>\s*([^<]+)", text)
        if m:
            info["type"] = m.group(1).strip()
        m = re.search(r"<em>Default: </em>(.*?)</li>", text, re.S)
        if m:
            info["default"] = strip_html(m.group(1))
        m = re.search(r"<em>Status: </em>(.*?)</li>", text, re.S)
        if m:
            info["status"] = strip_html(m.group(1))
        m = re.search(r"<em>Description:</em>(.*)</ul>", text, re.S)
        if m:
            info["description"] = strip_html(m.group(1))
        m = re.search(r"<em>Variables?: </em>(.*?)</li>", text, re.S)
        if m:
            info["variable"] = strip_html(m.group(1))
        # option list in description (<dt><tt>'scf'</tt>)
        opts_found = re.findall(r"<dt><tt>(?:<b>)?([^<]+?)(?:</b>)?</tt>", text)
        if opts_found:
            info["doc_options"] = [o.strip().strip("'\"") for o in opts_found]
        helps[cmd[1]] = info
    return helps


TYPE_MAP = {"REAL": "real", "INTEGER": "integer", "LOGICAL": "logical", "CHARACTER": "character"}


def build(mod_dir: Path) -> dict:
    schema: dict = {}
    for prog, (defs, helpf) in MODULES.items():
        dp, hp = mod_dir / defs, mod_dir / helpf
        if not dp.exists():
            continue
        nls: dict = {}
        walk(dp.read_text(errors="replace"), nls, None, False)
        helps = parse_help(hp.read_text(errors="replace")) if hp.exists() else {}
        prog_out = {}
        for nl, vars_ in nls.items():
            items = []
            for name, v in vars_.items():
                h = helps.get(name, {})
                t = TYPE_MAP.get(h.get("type", "").split()[0].upper() if h.get("type") else "", None)
                if t is None:
                    val = v.get("validate") or ""
                    t = ("real" if "real" in val else "integer" if "int" in val else
                         "logical" if v.get("options") and set(v["options"]) <= {".true.", ".false."} else "character")
                options = v.get("options")
                if options and t == "logical":
                    options = None
                if not options and h.get("doc_options") and t == "character":
                    options = [o for o in h["doc_options"] if re.fullmatch(r"[A-Za-z0-9_\-+.]+", o)] or None
                items.append({
                    "name": name,
                    "type": t,
                    "label": v.get("label") or name,
                    "default": h.get("default"),
                    "required": "REQUIRED" in (h.get("status") or "").upper(),
                    "status": h.get("status"),
                    "options": options,
                    "dimension": v.get("dimension", False) or "(" in (h.get("variable") or ""),
                    "description": h.get("description", ""),
                })
            prog_out[nl] = items
        schema[prog] = {"namelists": prog_out}
    return schema


if __name__ == "__main__":
    mod_dir = Path(sys.argv[1])
    out = Path(sys.argv[2])
    sch = build(mod_dir)
    out.write_text(json.dumps(sch, indent=1))
    for p, d in sch.items():
        print(p, {k: len(v) for k, v in d["namelists"].items()})
