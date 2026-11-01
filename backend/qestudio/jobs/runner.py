"""Generate the self-contained job runner scripts.

The runner executes the job steps in order and records its state in <jobdir>/.qes/:
  pid, state (running|done|failed|cancelled), step (1-based), exit_code, started, finished
so job status survives backend restarts and network drops. Two flavours:
  * POSIX bash script (local Linux/macOS, SSH, Jupyter/Kaggle; also works as a SLURM/PBS batch script)
  * Python script (local Windows without bash)
"""

from __future__ import annotations

import posixpath
import re
from typing import Any

from ..executors.base import q

SERIAL_PROGRAMS = {"q2r.x", "matdyn.x", "bands.x", "dos.x", "dynmat.x", "plotband.x", "ev.x", "sumpdos.x"}


def _mpi_prefix(template: str, np_: int, nthreads: int) -> str:
    if np_ <= 1 or not template.strip():
        return ""
    return template.replace("{np}", str(np_)).replace("{nthreads}", str(nthreads)).strip() + " "


def _exe(program: str, bin_dir: str) -> str:
    if bin_dir:
        return q(posixpath.join(bin_dir, program))
    return q(program)


def step_np(step: dict[str, Any], resources: dict[str, Any]) -> int:
    if step.get("np"):
        return max(1, int(step["np"]))
    if step.get("program") in SERIAL_PROGRAMS:
        return 1
    return max(1, int(resources.get("np", 1)))


def scheduler_header(scheduler: str, job_name: str, res: dict[str, Any]) -> list[str]:
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", job_name)[:40] or "qes"
    lines: list[str] = []
    if scheduler == "slurm":
        lines.append(f"#SBATCH --job-name={name}")
        lines.append("#SBATCH --output=.qes/scheduler.log")
        if res.get("nodes"):
            lines.append(f"#SBATCH --nodes={int(res['nodes'])}")
        lines.append(f"#SBATCH --ntasks={int(res.get('np', 1))}")
        if int(res.get("nthreads", 1)) > 1:
            lines.append(f"#SBATCH --cpus-per-task={int(res['nthreads'])}")
        if res.get("walltime"):
            lines.append(f"#SBATCH --time={res['walltime']}")
        if res.get("partition"):
            lines.append(f"#SBATCH --partition={res['partition']}")
        if res.get("account"):
            lines.append(f"#SBATCH --account={res['account']}")
        if res.get("qos"):
            lines.append(f"#SBATCH --qos={res['qos']}")
        if res.get("memory"):
            lines.append(f"#SBATCH --mem={res['memory']}")
    elif scheduler == "pbs":
        lines.append(f"#PBS -N {name}")
        lines.append("#PBS -j oe")
        lines.append("#PBS -o .qes/scheduler.log")
        nodes = int(res.get("nodes") or 1)
        ppn = max(1, int(res.get("np", 1)) // nodes)
        lines.append(f"#PBS -l nodes={nodes}:ppn={ppn}")
        if res.get("walltime"):
            lines.append(f"#PBS -l walltime={res['walltime']}")
        if res.get("partition"):
            lines.append(f"#PBS -q {res['partition']}")
        if res.get("account"):
            lines.append(f"#PBS -A {res['account']}")
        if res.get("memory"):
            lines.append(f"#PBS -l mem={res['memory']}")
    for extra in (res.get("extra_directives") or "").splitlines():
        if extra.strip():
            lines.append(extra.strip())
    return lines


def build_runner_sh(job: dict[str, Any], conn: dict[str, Any]) -> str:
    res = job.get("resources") or {}
    scheduler = job.get("scheduler", "direct")
    nthreads = max(1, int(res.get("nthreads", 1)))
    bin_dir = (conn.get("qe_bin_dir") or "").strip()
    mpi = (
        (res.get("mpi_command") or conn.get("mpi_command") or "mpirun -np {np}")
        if scheduler == "direct"
        else (
            res.get("mpi_command")
            or conn.get("mpi_command_batch")
            or ("srun" if scheduler == "slurm" else "mpirun -np {np}")
        )
    )
    jobdir = job["remote_dir"]
    shebang = "#!/bin/bash -l" if conn.get("login_shell", conn.get("kind") == "ssh") else "#!/bin/bash"
    L: list[str] = [shebang]
    L += scheduler_header(scheduler, job.get("name", "qes"), res)
    L += [
        f"# QE Studio runner for job {job['id']} ({job.get('name', '')})",
        "# Generated file: edit the job in QE Studio instead.",
        f"cd {q(jobdir)} || exit 97",
        'QES_DIR="$PWD/.qes"',
        'mkdir -p "$QES_DIR"',
        'echo $$ > "$QES_DIR/pid"',
        '[ -n "$SLURM_JOB_ID" ] && echo "$SLURM_JOB_ID" > "$QES_DIR/sched_id"',
        '[ -n "$PBS_JOBID" ] && echo "$PBS_JOBID" > "$QES_DIR/sched_id"',
        'date +%s > "$QES_DIR/started"',
        'echo running > "$QES_DIR/state"',
        'rm -f "$QES_DIR/exit_code" "$QES_DIR/finished"',
        'finish() { echo "$1" > "$QES_DIR/exit_code"; date +%s > "$QES_DIR/finished"; echo "$2" > "$QES_DIR/state"; }',
        'CHILD=""',
        'on_term() { if [ -n "$CHILD" ]; then kill -TERM "$CHILD" 2>/dev/null; pkill -TERM -P "$CHILD" 2>/dev/null; '
        'sleep 2; kill -KILL "$CHILD" 2>/dev/null; fi; finish 143 cancelled; exit 143; }',
        "trap on_term TERM INT HUP",
        "# ---------------- environment (connection settings) ----------------",
    ]
    env_setup = (conn.get("env_setup") or "").strip()
    if env_setup:
        L.append(env_setup)
    if res.get("env_setup"):
        L.append(str(res["env_setup"]).strip())
    L += [
        f"export OMP_NUM_THREADS={nthreads}",
        'if [ "$(id -u)" = "0" ]; then export OMPI_ALLOW_RUN_AS_ROOT=1 OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1; fi',
    ]
    if bin_dir:
        L.append(f'export PATH={q(bin_dir)}:"$PATH"')
    L += [
        "run_step() {",
        '  idx="$1"; cwd="$2"; out="$3"; shift 3',
        '  echo "$idx" > "$QES_DIR/step"',
        '  ( cd "$cwd" && exec "$@" ) > "$cwd/$out" 2> "$cwd/$out.err" &',
        "  CHILD=$!",
        '  wait "$CHILD"',
        "  rc=$?",
        '  CHILD=""',
        "  return $rc",
        "}",
        "# ---------------- steps ----------------",
    ]
    for i, st in enumerate(job["steps"], start=1):
        cwd = st.get("cwd") or "."
        out = st["output_name"]
        L.append(f"# step {i}: {st.get('label', st['program'])}")
        L.append(f"mkdir -p {q(cwd)}")
        if st["program"] == "shell":
            L.append(f"run_step {i} {q(cwd)} {q(out)} bash {q(st['input_name'])} || {{ finish $? failed; exit 1; }}")
        else:
            np_ = step_np(st, res)
            prefix = _mpi_prefix(mpi, np_, nthreads)
            args = (st.get("args") or "").strip()
            pool = ""
            if st["program"] == "pw.x" and res.get("npool") and np_ > 1 and "-nk" not in args and "-npool" not in args:
                pool = f" -nk {int(res['npool'])}"
            cmd = f"{prefix}{_exe(st['program'], bin_dir)}{pool} {args} -in {q(st['input_name'])}".replace("  ", " ")
            L.append(f"run_step {i} {q(cwd)} {q(out)} {cmd} || {{ finish $? failed; exit 1; }}")
            if st.get("save_xml"):
                stem = out.rsplit(".", 1)[0]
                L.append(
                    f"cp -f {q(posixpath.join(cwd, st['save_xml']))} {q(posixpath.join(cwd, stem + '.xml'))} 2>/dev/null || true"
                )
    L.append("finish 0 done")
    L.append("exit 0")
    return "\n".join(L) + "\n"


def build_runner_py(job: dict[str, Any], conn: dict[str, Any]) -> str:
    """Portable runner (Windows local). Same .qes/ state protocol as the bash runner."""
    res = job.get("resources") or {}
    nthreads = max(1, int(res.get("nthreads", 1)))
    bin_dir = (conn.get("qe_bin_dir") or "").strip()
    mpi = res.get("mpi_command") or conn.get("mpi_command") or ""
    steps = []
    for st in job["steps"]:
        np_ = step_np(st, res)
        prog = st["program"]
        if bin_dir:
            import ntpath

            exe = ntpath.join(bin_dir, prog) if "\\" in bin_dir or ":" in bin_dir else posixpath.join(bin_dir, prog)
        else:
            exe = prog
        argv: list[str] = []
        pre = _mpi_prefix(mpi, np_, nthreads).split()
        argv += pre
        argv.append(exe)
        argv += (st.get("args") or "").split()
        argv += ["-in", st["input_name"]]
        steps.append(
            {
                "cwd": st.get("cwd") or ".",
                "out": st["output_name"],
                "argv": argv,
                "save_xml": st.get("save_xml"),
                "shell": prog == "shell",
                "input": st["input_name"],
            }
        )
    return f'''# QE Studio runner (python) for job {job["id"]}
import json, os, shutil, signal, subprocess, sys, time
os.chdir(os.path.dirname(os.path.abspath(__file__)))
Q = os.path.join(os.getcwd(), ".qes")
os.makedirs(Q, exist_ok=True)
def w(name, val):
    with open(os.path.join(Q, name), "w") as fh: fh.write(str(val) + "\\n")
w("pid", os.getpid()); w("started", int(time.time())); w("state", "running")
for f in ("exit_code", "finished"):
    try: os.remove(os.path.join(Q, f))
    except OSError: pass
child = None
def finish(code, state):
    w("exit_code", code); w("finished", int(time.time())); w("state", state)
def on_term(*_):
    if child is not None:
        try: child.terminate()
        except Exception: pass
    finish(143, "cancelled"); sys.exit(143)
for s in ("SIGTERM", "SIGINT", "SIGBREAK"):
    if hasattr(signal, s): signal.signal(getattr(signal, s), on_term)
os.environ["OMP_NUM_THREADS"] = "{nthreads}"
BIN = {bin_dir!r}
if BIN: os.environ["PATH"] = BIN + os.pathsep + os.environ.get("PATH", "")
STEPS = {steps!r}
for i, st in enumerate(STEPS, 1):
    w("step", i)
    os.makedirs(st["cwd"], exist_ok=True)
    argv = st["argv"] if not st["shell"] else ([shutil.which("bash") or "sh", st["input"]])
    if not st["shell"] and not os.path.isabs(argv[0]) and shutil.which(argv[0]) is None and shutil.which(argv[0][:-2] + ".exe"):
        argv[0] = argv[0][:-2] + ".exe"
    with open(os.path.join(st["cwd"], st["out"]), "wb") as fo, open(os.path.join(st["cwd"], st["out"] + ".err"), "wb") as fe:
        try:
            child = subprocess.Popen(argv, cwd=st["cwd"], stdout=fo, stderr=fe, stdin=subprocess.DEVNULL)
        except OSError as exc:
            fe.write(str(exc).encode()); finish(127, "failed"); sys.exit(1)
        rc = child.wait(); child = None
    if rc != 0:
        finish(rc, "failed"); sys.exit(1)
    if st.get("save_xml"):
        try:
            shutil.copyfile(os.path.join(st["cwd"], st["save_xml"]), os.path.join(st["cwd"], st["out"].rsplit(".", 1)[0] + ".xml"))
        except OSError: pass
finish(0, "done")
'''
