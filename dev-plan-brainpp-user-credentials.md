# Brain++ per-user credentials on qm/dev

## Goal

Make `BrainppCluster` submit/list/get/logs/events/stop/delete use the current LightClaw user's Brain++ AK/SK instead of the daemon process' ambient deployment identity.

## Current qm/dev shape

- Global config may boot without global models; user model/endpoint settings live in `users/<canonical>/config.json`.
- Runtime/cluster settings are still deployment-level config.
- User secrets already live under `identity/per-user/<canonical>/secrets.json`.

## Design

- Fixed per-user secret names:
  - `BRAINPP_ACCESS_KEY`
  - `BRAINPP_SECRET_KEY`
- User setup:
  - `/secret set BRAINPP_ACCESS_KEY <ak>`
  - `/secret set BRAINPP_SECRET_KEY <sk>`
- `BrainppCluster` reads these stored secrets directly. They do not need `/secret enable`, because they are not general Bash env injection.
- Missing current user or missing AK/SK fails before any cluster CLI runs.
- AK/SK are only passed through `runtime.exec({ env })`; they must never appear in command strings, tool results, skills, memory, or job `-e` env.

## Test Plan

- Unit test missing active user.
- Unit test missing Brain++ secrets for an active user.
- Unit test successful CLI execution gets env values but command/tool output does not leak them.
- Existing cluster job command, redaction, mount, and permission tests continue to pass.
