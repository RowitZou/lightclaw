# Sandbox Helpers

Helper scripts that run inside the environment runtime.

- `glob.py` expands glob patterns inside DockerRuntime without adding Node.js to the sandbox image.

LocalRuntime invokes these with host `python3`.

DockerRuntime should copy this directory into the sandbox image at
`/opt/lightclaw/sandbox-helpers/`.

> **History (Phase 34, 2026-05-12)**: `webfetch.py` + `websearch.py` were
> deleted in this directory and replaced by daemon-side TS modules
> (`src/tools/web-fetch-*.ts` + `src/tools/web-search-*.ts`). Migration
> aligned with Claude Code / OpenClaw / Hermes which all run their
> webfetch/websearch in the daemon process. See dev-plan + history for
> the rationale.
