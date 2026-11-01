# Common developer tasks. Run `make help` for the list.
PY      ?= .venv/bin/python
VENV    ?= .venv
NPM     ?= npm

.PHONY: help setup dev run build test test-backend test-frontend e2e lint format check docker clean

help:          ## show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

setup:         ## create the venv, install backend (editable) and frontend deps, build the UI
	scripts/setup.sh

dev:           ## backend with auto-reload + Vite dev server with hot reload
	scripts/dev.sh

run:           ## start QE Studio (serves the built UI)
	scripts/run.sh

build:         ## production build of the web UI
	cd frontend && $(NPM) run build

test: test-backend test-frontend  ## all fast tests

test-backend:  ## pytest (no Quantum ESPRESSO needed; stand-in executables are used)
	cd backend && ../$(PY) -m pytest -q

test-frontend: ## typecheck + lint + format check + unit tests (vitest) of the UI
	cd frontend && $(NPM) run check

e2e:           ## browser end-to-end tests (needs `make build` and `npx playwright install chromium`)
	cd frontend && QES_PYTHON=../$(PY) $(NPM) run e2e

lint:          ## static checks (ruff, eslint, tsc)
	cd backend && ../$(VENV)/bin/ruff check . && ../$(VENV)/bin/ruff format --check .
	cd frontend && $(NPM) run lint && $(NPM) run typecheck

format:        ## auto-format Python and TypeScript
	cd backend && ../$(VENV)/bin/ruff check --fix . && ../$(VENV)/bin/ruff format .
	cd frontend && $(NPM) run format

check: lint test  ## everything CI runs (except e2e)

docker:        ## build the container image
	docker build -t qe-studio .

clean:         ## remove build artefacts and caches
	rm -rf frontend/dist frontend/test-results frontend/playwright-report
	find backend -name __pycache__ -type d -prune -exec rm -rf {} +
	rm -rf backend/.pytest_cache backend/.ruff_cache
