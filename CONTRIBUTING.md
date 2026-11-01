# Contributing to QE Studio

Thanks for helping. This guide covers the development setup, the commands you need, and the
conventions that keep the code easy to read for the next person. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first for how the pieces fit together.

## Setup

Requirements: Python ≥ 3.10, Node.js ≥ 20, git. Quantum ESPRESSO is **not** needed for the test
suite (stand-in executables replay real QE outputs).

```bash
scripts/setup.sh                 # .venv with the backend (editable, test extras) + UI build
make dev                         # backend with auto-reload (:8765) + Vite dev server with HMR (:5173)
```

Open http://localhost:5173 during development (the Vite dev server proxies `/api` to the backend and
injects the API token). `make help` lists every task.

Optional: `pip install pre-commit && pre-commit install` runs ruff and the frontend checks on commit.

## Everyday commands

| Task | Command |
| --- | --- |
| All fast checks (what CI runs, except e2e) | `make check` |
| Backend tests | `make test-backend` (`cd backend && pytest -q`) |
| One backend test | `cd backend && pytest -q tests/test_parsers.py -k phonon` |
| Frontend typecheck + lint + format + unit tests | `make test-frontend` (`cd frontend && npm run check`) |
| Frontend unit tests only | `cd frontend && npm test` |
| Browser end-to-end tests | `make build && make e2e` (first time: `npx playwright install chromium`) |
| Auto-format | `make format` |

Optional integration tests run when their prerequisites exist:

- real `pw.x`: put QE on `PATH` and set `QES_TEST_PSEUDO_DIR` to a folder with `Si.pbe-tm-test.UPF`
  (any Si UPF renamed to that file name works for the smoke test);
- SSH: `QES_TEST_SSH=user@host:port` (and `QES_TEST_SSH_KEY=/path/to/key`).

## Code conventions

### General

- Small modules with one responsibility. When a module grows past ~500 lines, split it by
  responsibility behind a stable import (see `core/structure/`).
- Names say what things are (`wait_for_runner`, `phonon_dos_from_grid`), units are in names where it
  matters (`energy_ev`, `freq_cm1`, `timeout_s`, `B0_GPa`).
- Comments explain *why* (a QE quirk, a protocol constraint, a measured bug), not what the next line
  does. When a choice comes from a measurement, say what was measured and with which QE version.
- No dead code, commented-out code or speculative options.

### Python (backend)

- Formatting and linting: `ruff format` and `ruff check` (line length 120, rules in
  `backend/pyproject.toml`). `from __future__ import annotations` at the top of every module.
- Type hints on all public functions; use `dict[str, Any]` for JSON-like payloads and pydantic
  models at the API boundary.
- `core/` stays pure: no FastAPI, database, network or filesystem side effects beyond reading what
  it is given. That keeps it fast to test.
- Async rules: never block the event loop. Wrap CPU-heavy or blocking library calls in
  `asyncio.to_thread`. Create `asyncio.Event`/`Lock` objects inside the running loop (in `start()` or
  on first use), not at import time.
- Errors: raise `ExecutorError` for transport problems, `JobError` for invalid jobs, `ValueError` from
  parsers; routers turn them into HTTP 400/404 with a message a user can act on. Never swallow an
  exception without logging it.
- Shell commands on targets: quote every interpolated value with `q()` (`shlex.quote`). Keep detached
  launches as simple commands (see the comments in `executors/`).
- Secrets: read them with `secrets_store.get_secret` where they are used; never put them in a
  response, a log line or an exception message.

### TypeScript (frontend)

- `strict` TypeScript, ESLint (flat config with typescript-eslint and react-hooks rules) and Prettier
  (`printWidth` 120, single quotes). `npm run check` must pass.
- Function components and hooks only. Server data through the TanStack Query hooks in
  `src/api/hooks.ts`; do not call `fetch` from components. Keep `src/api/types.ts` in sync with the
  backend responses.
- Pure logic (parsing, geometry, unit conversion) goes in `src/lib/` or a `*.ts` file next to the
  components that use it, with a `*.test.ts` beside it.
- Lazy-load heavy dependencies (Monaco, Plotly, three.js) at page or component level.
- Physical constants come from `src/lib/units.ts` (mirror of `backend/qestudio/core/units.py`).

### Scientific correctness

This is a research tool; wrong numbers are worse than missing ones.

- Parsers return `None` (JSON `null`) for values they cannot find. Never fill in placeholders.
- Every parser change needs a test against a **real** QE output in `backend/tests/data/` (record the
  QE version in the commit message). Synthetic snippets are fine for edge cases in addition.
- Prefer invariants as tests: electron count from the DOS, 3·nat from the phonon DOS, charge from a
  cube file, unit constants against `pw.x` output.
- Defaults in workflow generators must be physically reasonable and documented as starting points
  that need convergence testing.
- When behaviour depends on a QE version or build, say so in a comment and in the UI message.
- Cite the source (QE documentation, paper, release notes) in a comment when you rely on a specific
  definition or convention.

## Tests

- Backend: pytest. Fixtures in `tests/conftest.py` give an isolated `QES_HOME`, a `TestClient`, and
  `fake_qe` stand-in executables (they print a stored QE output; `FAKE_QE_SLEEP` and `FAIL_ME`
  simulate long and failing runs). The Jupyter executor test starts a real `jupyter_server` with a
  Kaggle-style URL.
- Frontend: vitest for pure logic (`src/**/*.test.ts`), Playwright smoke tests in `frontend/e2e/`
  against the real backend and the production build.
- A bug fix comes with a test that fails without the fix.

## Commits and pull requests

- One logical change per commit, imperative subject line ("Validate phonon DOS normalisation"), and a
  body that explains why when it is not obvious.
- Before opening a PR: `make check` passes; new behaviour is tested; user-visible changes are
  reflected in `README.md`; design changes in `docs/ARCHITECTURE.md`.
- PR description: what changed, why, how it was tested (including QE version and target type for
  anything that touches running jobs), screenshots for UI changes.

### PR checklist

- [ ] `make check` passes (ruff, pytest, tsc, eslint, prettier, vitest)
- [ ] Tests added or updated (real QE output for parser changes)
- [ ] No secrets in responses, logs or errors
- [ ] Long-running or blocking work is off the event loop
- [ ] `api/types.ts` matches backend responses
- [ ] Docs updated (README / ARCHITECTURE) where relevant
