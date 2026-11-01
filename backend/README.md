# qe-studio (backend)

FastAPI backend of **QE Studio**, a workbench for Quantum ESPRESSO. See the repository
root `README.md` for the full documentation and `docs/ARCHITECTURE.md` for the design.

```bash
pip install -e ".[test]"      # development install
qe-studio                      # start (serves the built UI from ../frontend/dist when present)
pytest                         # tests (no Quantum ESPRESSO needed)
ruff check . && ruff format --check .
```
