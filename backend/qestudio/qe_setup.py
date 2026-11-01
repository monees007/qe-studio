"""Getting Quantum ESPRESSO onto a connection.

* ``conda_install_script`` / ``apt_install_script``: shell scripts run as tracked install jobs
  on the target (precompiled QE from conda-forge via micromamba, or the distro package).
* ``install_archive``: "bring your own binaries" - extract a tar/zip/.conda/.deb archive
  (safely), locate ``pw.x``/``pw.exe`` and install it locally or upload it to the target.
"""

from __future__ import annotations

import asyncio
import io
import os
import re
import shutil
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from .config import get_env
from .connections import drop_executor, get_connection, get_executor, set_config_values, test_connection
from .executors.base import ExecutorError, q
from .executors.local import IS_WINDOWS

# ----------------------------------------------------------------------------- QE install (conda)
# conda-forge `qe` builds (checked with `micromamba search`, Oct 2026): every linux/osx build of
# 7.4-7.6 depends on an MPI library; Open MPI builds exist for all versions, MPICH builds
# (build string mpi_mpich_*) only from 7.6. There is no serial build; run with 1 process instead.
MPICH_MIN_VERSION = (7, 6)


def conda_spec(version: str | None, mpi: str) -> list[str]:
    """Package specs for micromamba. Naming the MPI package pins the solver to that MPI flavour
    (conda-forge's `mpi` mutex forbids mixing), so `mpirun -np N pw.x` really runs one MPI job."""
    if mpi == "mpich":
        if version and tuple(int(x) for x in version.split(".")[:2]) < MPICH_MIN_VERSION:
            raise ValueError("conda-forge provides MPICH builds of QE only from version 7.6; choose Open MPI")
        return [f"qe={version or '*'}=mpi_mpich_*", "mpich"]
    return [f"qe={version}" if version else "qe", "openmpi"]


def conda_install_script(root: str, version: str | None, mpi: str) -> str:
    specs = " ".join(q(x) for x in conda_spec(version, mpi))
    env_name = f"qe-{version or 'latest'}-{mpi}"
    return f"""set -e
ROOT={q(root)}
mkdir -p "$ROOT/bin"
cd "$ROOT"
OS=$(uname -s); ARCH=$(uname -m)
case "$OS-$ARCH" in
  Linux-x86_64) PLAT=linux-64;; Linux-aarch64|Linux-arm64) PLAT=linux-aarch64;; Linux-ppc64le) PLAT=linux-ppc64le;;
  Darwin-x86_64) PLAT=osx-64;; Darwin-arm64) PLAT=osx-arm64;;
  *) echo "unsupported platform $OS-$ARCH for conda-forge QE"; exit 2;;
esac
fetch() {{ # url dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 "$1" -o "$2";
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1";
  else python3 -c "import sys,urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" "$1" "$2"; fi
}}
if [ ! -x "$ROOT/bin/micromamba" ]; then
  echo "[qes] downloading micromamba for $PLAT"
  if ! fetch "https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-$PLAT" "$ROOT/bin/micromamba"; then
    echo "[qes] GitHub download failed; trying micro.mamba.pm"
    fetch "https://micro.mamba.pm/api/micromamba/$PLAT/latest" "$ROOT/mm.tar.bz2"
    tar -xjf "$ROOT/mm.tar.bz2" -C "$ROOT" bin/micromamba
    rm -f "$ROOT/mm.tar.bz2"
  fi
  chmod +x "$ROOT/bin/micromamba"
fi
"$ROOT/bin/micromamba" --version
export MAMBA_ROOT_PREFIX="$ROOT/mamba"
echo "[qes] creating environment {env_name} with conda-forge {specs}"
"$ROOT/bin/micromamba" create -y -p "$ROOT/envs/{env_name}" -c conda-forge {specs}
"$ROOT/bin/micromamba" clean -y -a >/dev/null 2>&1 || true
BIN="$ROOT/envs/{env_name}/bin"
echo "" | "$BIN/pw.x" 2>&1 | grep -m1 "Program PWSCF" || true
echo "QES_BIN_DIR=$BIN"
"""


def apt_install_script() -> str:
    return """set -e
if [ "$(id -u)" = "0" ]; then SUDO=""; elif sudo -n true 2>/dev/null; then SUDO="sudo -n"; else
  echo "apt install needs root or passwordless sudo"; exit 3; fi
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -q
$SUDO apt-get install -y -q quantum-espresso
P=$(command -v pw.x)
echo "" | "$P" 2>&1 | grep -m1 "Program PWSCF" || true
echo "QES_BIN_DIR=$(dirname "$P")"
"""


# ----------------------------------------------------------------------------- precompiled archives
ARCHIVE_EXT = (".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar", ".zip", ".conda", ".deb")


def _ar_members(data: bytes) -> dict[str, bytes]:
    if not data.startswith(b"!<arch>\n"):
        raise ValueError("not an ar archive (.deb)")
    out, pos = {}, 8
    while pos + 60 <= len(data):
        hdr = data[pos : pos + 60]
        name = hdr[:16].decode().strip().rstrip("/")
        size = int(hdr[48:58].decode().strip())
        pos += 60
        out[name] = data[pos : pos + size]
        pos += size + (size % 2)
    return out


def _check_tar_members(tf: tarfile.TarFile, dest: Path) -> None:
    """Reject members that would land outside dest (paths or links) and device files."""
    root = dest.resolve()
    for m in tf.getmembers():
        target = (root / m.name).resolve()
        if not target.is_relative_to(root):
            raise ValueError(f"unsafe path in archive: {m.name}")
        if m.issym() or m.islnk():
            base = target.parent if m.issym() else root
            if os.path.isabs(m.linkname) or not (base / m.linkname).resolve().is_relative_to(root):
                raise ValueError(f"unsafe link in archive: {m.name} -> {m.linkname}")
        if m.isdev():
            raise ValueError(f"device file in archive: {m.name}")


def _safe_extract_tar(tf: tarfile.TarFile, dest: Path) -> None:
    if hasattr(tarfile, "data_filter"):  # Python >= 3.12 and security backports (PEP 706)
        try:
            tf.extractall(dest, filter="data")
        except tarfile.FilterError as exc:
            raise ValueError(f"unsafe archive member: {exc}") from exc
    else:  # pragma: no cover - old patch releases of Python 3.10/3.11
        _check_tar_members(tf, dest)
        tf.extractall(dest)


def extract_archive(data: bytes, filename: str, dest: Path) -> None:
    """Extract tar/zip/.conda/.deb archives safely into dest."""
    low = filename.lower()
    dest.mkdir(parents=True, exist_ok=True)
    if low.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            root = dest.resolve()
            for zi in zf.infolist():
                if not (root / zi.filename).resolve().is_relative_to(root):
                    raise ValueError(f"unsafe path in archive: {zi.filename}")
            zf.extractall(dest)
            # restore executable bits (zip stores unix mode in external_attr)
            for zi in zf.infolist():
                mode = (zi.external_attr >> 16) & 0o777
                if mode:
                    try:
                        os.chmod(dest / zi.filename, mode)
                    except OSError:
                        pass
    elif low.endswith(".conda"):
        import zstandard

        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            pkg = next((n for n in zf.namelist() if n.startswith("pkg-") and n.endswith(".tar.zst")), None)
            if pkg is None:
                raise ValueError(".conda package without pkg-*.tar.zst")
            raw = zstandard.ZstdDecompressor().decompressobj().decompress(zf.read(pkg))
            with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tf:
                _safe_extract_tar(tf, dest)
    elif low.endswith(".deb"):
        members = _ar_members(data)
        dname = next((n for n in members if n.startswith("data.tar")), None)
        if dname is None:
            raise ValueError(".deb without data.tar.*")
        payload = members[dname]
        if dname.endswith(".zst"):
            import zstandard

            payload = zstandard.ZstdDecompressor().decompressobj().decompress(payload)
            mode = "r:"
        else:
            mode = "r:*"
        with tarfile.open(fileobj=io.BytesIO(payload), mode=mode) as tf:
            _safe_extract_tar(tf, dest)
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tf:
            _safe_extract_tar(tf, dest)


def find_bin_dir(root: Path) -> Path | None:
    """Directory containing pw.x (or pw.exe); prefers .../bin."""
    cands = [p.parent for p in root.rglob("pw.x")] + [p.parent for p in root.rglob("pw.exe")]
    if not cands:
        return None
    cands.sort(key=lambda p: (p.name != "bin", len(p.parts)))
    return cands[0]


async def install_archive(conn_id: str, data: bytes, filename: str, task) -> dict[str, Any]:
    conn = get_connection(conn_id)
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(filename).name)
    for ext in ARCHIVE_EXT:
        if name.lower().endswith(ext):
            name = name[: -len(ext)]
            break
    with tempfile.TemporaryDirectory(dir=get_env().tmp_dir) as td:
        tdir = Path(td) / "x"
        task.log(f"extracting {filename} ({len(data) / 1e6:.1f} MB)")
        await asyncio.to_thread(extract_archive, data, filename, tdir)
        bindir = find_bin_dir(tdir)
        if bindir is None:
            raise ValueError("no pw.x / pw.exe found inside the archive")
        rel_bin = bindir.relative_to(tdir)
        progs = sorted(p.name for p in bindir.iterdir() if p.name.endswith((".x", ".exe")))
        task.log(
            f"found {len(progs)} executables in {rel_bin}: {', '.join(progs[:12])}{' ...' if len(progs) > 12 else ''}"
        )
        if not any(p.startswith("pw.") for p in progs):
            raise ValueError("pw.x missing")
        if conn["kind"] == "local":
            dest = get_env().qe_dir / name
            if dest.exists():
                shutil.rmtree(dest)
            shutil.move(str(tdir), str(dest))
            final_bin = dest / rel_bin
            if not IS_WINDOWS:
                for p in final_bin.iterdir():
                    if p.is_file():
                        p.chmod(p.stat().st_mode | 0o755)
            bin_str = str(final_bin)
        else:
            ex = await get_executor(conn_id)
            root = await ex.expand(conn["config"]["work_root"])
            dest = f"{root}/qe-bin/{name}"
            buf = io.BytesIO()
            task.log("re-packing for upload")
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                tf.add(str(tdir), arcname=".")
            payload = buf.getvalue()
            task.log(f"uploading {len(payload) / 1e6:.1f} MB to {conn['name']}:{dest}")
            await ex.mkdir(dest)
            await ex.write_file(f"{dest}/pkg.tar.gz", payload)
            r = await ex.run_marked(
                f"cd {q(dest)} && tar -xzf pkg.tar.gz && rm -f pkg.tar.gz && chmod -R u+x {q(str(rel_bin))}", 600
            )
            if not r.ok:
                raise ExecutorError(f"remote extraction failed: {r.stderr or r.stdout}")
            bin_str = f"{dest}/{rel_bin}".rstrip("/.")
        set_config_values(conn_id, {"qe_bin_dir": bin_str})
        task.log(f"qe_bin_dir set to {bin_str}")
    await drop_executor(conn_id)
    res = await test_connection(conn_id)
    info = res.get("info") or {}
    if info.get("missing_libs"):
        task.log(
            "WARNING: missing shared libraries: "
            + ", ".join(info["missing_libs"])
            + " — precompiled binaries need their runtime libraries (MPI, BLAS, FFTW, gfortran). "
            "Prefer the conda-forge installer or load the matching modules in 'environment setup'."
        )
    task.log(f"QE version detected: {info.get('qe_version') or 'unknown'}")
    return {"bin_dir": bin_str, "probe": info}
