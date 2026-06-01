# Cluster job templates and troubleshooting

## Minimal interaction flow

1. Translate the user's request into a job draft: command, code location, resource needs, image, namespace/group, output/log location, and stop condition.
2. Ask for missing environment-specific values instead of guessing. Source must not contain hardcoded namespace, charged group, image, GPFS path, or secret values.
3. Run `submit --predict-only true ...` through the wrapper (the preview flag takes a value; `--dry-run true` is the spec-preview alternative). A real submit also needs `--image` and the resource flags.
4. Summarize the predicted job spec and resource impact.
5. Ask for explicit confirmation before a real `submit`.
6. After submission, return the job name and the exact read-only follow-ups: `get`, `logs --tail N`, `events`, and `download-logs`.

## Common troubleshooting order

1. `get <job>`: verify phase, pod/job identifiers, command, resource requests, and recent status.
2. `events <job>`: check scheduling, quota, image pull, volume mount, and eviction messages.
3. `logs <job> --tail 200`: keep logs bounded first; increase only when needed.
4. `download-logs <job>`: collect complete logs only when the user needs an artifact or failure analysis.
5. For failed jobs, compare requested resources, image, working directory, dataset path, credentials, and command-line arguments against the predicted spec.

## Safety rules

- Never use `rjob` for LightClaw sandbox/runtime sessions; use `rlaunch` for runtime sandbox work.
- Never run real `submit`, `stop`, or `delete` without explicit user confirmation.
- Treat `clone` and `patch` as spec-editing operations. Inspect and explain what changes before any risky action.
- Keep log reads bounded unless the user asks for a full artifact.
- Do not put credentials into Git remotes, job specs, command lines, or logs.
