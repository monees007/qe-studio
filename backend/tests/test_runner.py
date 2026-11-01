"""The generated runner scripts (bash and the portable Python flavour used on Windows)."""

import subprocess
import sys

import pytest

from qestudio.jobs.runner import build_runner_py, build_runner_sh

STEP = {
    "label": "scf",
    "program": "pw.x",
    "input_name": "scf.in",
    "input": "&control\n/\n",
    "output_name": "scf.out",
    "cwd": ".",
    "np": None,
    "args": "",
    "save_xml": None,
}


def job(tmp_path, **resources):
    return {
        "id": "abc123",
        "name": "test job",
        "remote_dir": str(tmp_path),
        "steps": [STEP],
        "resources": {"np": 4, "nthreads": 2, **resources},
        "scheduler": resources.pop("scheduler", "direct"),
    }


def test_bash_runner_contents(tmp_path):
    text = build_runner_sh(
        job(tmp_path, npool=2),
        {"qe_bin_dir": "/opt/qe/bin", "mpi_command": "mpirun -np {np}", "env_setup": "module load qe"},
    )
    assert text.startswith("#!/bin/bash")
    assert "module load qe" in text and "export OMP_NUM_THREADS=2" in text
    assert "mpirun -np 4 /opt/qe/bin/pw.x -nk 2 -in scf.in" in text
    assert "finish 0 done" in text and "trap on_term TERM INT HUP" in text


def test_slurm_header(tmp_path):
    j = job(tmp_path, partition="debug", walltime="00:10:00", account="proj1")
    j["scheduler"] = "slurm"
    text = build_runner_sh(j, {"kind": "ssh", "login_shell": True})
    for line in (
        "#!/bin/bash -l",
        "#SBATCH --ntasks=4",
        "#SBATCH --cpus-per-task=2",
        "#SBATCH --partition=debug",
        "#SBATCH --time=00:10:00",
        "#SBATCH --account=proj1",
    ):
        assert line in text
    assert "srun " in text  # default launcher inside SLURM allocations


def test_serial_programs_skip_mpi(tmp_path):
    j = job(tmp_path)
    j["steps"] = [{**STEP, "program": "matdyn.x", "input_name": "md.in", "output_name": "md.out"}]
    text = build_runner_sh(j, {"mpi_command": "mpirun -np {np}"})
    assert "mpirun" not in text.split("# ---------------- steps")[1]


def test_python_runner_executes(tmp_path, fake_qe):
    (tmp_path / "scf.in").write_text("&control\n/\n")
    script = build_runner_py(job(tmp_path), {"qe_bin_dir": str(fake_qe), "mpi_command": ""})
    (tmp_path / "run.py").write_text(script)
    subprocess.run([sys.executable, "run.py"], cwd=tmp_path, check=True, timeout=60)
    assert (tmp_path / ".qes" / "state").read_text().strip() == "done"
    assert (tmp_path / ".qes" / "exit_code").read_text().strip() == "0"
    assert "JOB DONE" in (tmp_path / "scf.out").read_text()


def test_python_runner_reports_failure(tmp_path, fake_qe):
    (tmp_path / "scf.in").write_text("&control\n prefix='FAIL_ME'\n/\n")
    (tmp_path / "run.py").write_text(build_runner_py(job(tmp_path), {"qe_bin_dir": str(fake_qe), "mpi_command": ""}))
    subprocess.run([sys.executable, "run.py"], cwd=tmp_path, check=False, timeout=60)
    assert (tmp_path / ".qes" / "state").read_text().strip() == "failed"
    assert (tmp_path / ".qes" / "exit_code").read_text().strip() == "3"


def test_conda_spec_pins_the_mpi_flavour():
    from qestudio.qe_setup import conda_install_script, conda_spec

    assert conda_spec("7.6", "openmpi") == ["qe=7.6", "openmpi"]
    assert conda_spec(None, "openmpi") == ["qe", "openmpi"]
    assert conda_spec("7.6", "mpich") == ["qe=7.6=mpi_mpich_*", "mpich"]
    assert conda_spec(None, "mpich") == ["qe=*=mpi_mpich_*", "mpich"]
    with pytest.raises(ValueError, match=r"from version 7\.6"):
        conda_spec("7.5", "mpich")
    script = conda_install_script("/opt/qe", "7.6", "mpich")
    assert "-c conda-forge 'qe=7.6=mpi_mpich_*' mpich" in script
    assert "QES_BIN_DIR=" in script


def test_archive_extraction_rejects_escapes(tmp_path):
    import io
    import tarfile
    import zipfile

    from qestudio.qe_setup import _check_tar_members, extract_archive

    def tar_with(member: tarfile.TarInfo, data: bytes = b"") -> bytes:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            member.size = len(data)
            tf.addfile(member, io.BytesIO(data) if data else None)
        return buf.getvalue()

    with pytest.raises(ValueError):
        extract_archive(tar_with(tarfile.TarInfo("../evil"), b"x"), "a.tar.gz", tmp_path / "a")
    link = tarfile.TarInfo("bin/pw.x")
    link.type, link.linkname = tarfile.SYMTYPE, "../../../etc/passwd"
    with tarfile.open(fileobj=io.BytesIO(tar_with(link)), mode="r:gz") as tf, pytest.raises(ValueError):
        _check_tar_members(tf, tmp_path / "b")  # the pre-PEP 706 code path
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, "w") as zf:
        zf.writestr("../evil", "x")
    with pytest.raises(ValueError, match="unsafe path"):
        extract_archive(zbuf.getvalue(), "a.zip", tmp_path / "c")
    ok = tarfile.TarInfo("qe/bin/pw.x")
    extract_archive(tar_with(ok, b"#!/bin/sh\n"), "ok.tar.gz", tmp_path / "d")
    assert (tmp_path / "d" / "qe" / "bin" / "pw.x").read_bytes() == b"#!/bin/sh\n"
