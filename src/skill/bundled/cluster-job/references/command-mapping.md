# rjob command mapping

Use the wrapper as `${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh <command> ...` so the kubebrain SSH environment is initialized before `rjob` runs.

| Intent | Safe command shape | Notes |
| --- | --- | --- |
| List jobs | `list [rjob list flags]` | Read-only. Ask for filters if the result would be too broad. |
| Get job details | `get <job> [flags]` | Read-only. Use before logs/events when the job name is uncertain. |
| Tail logs | `logs <job> [--tail N] [flags]` | Wrapper injects `--tail ${RJOB_WRAPPER_DEFAULT_LOG_TAIL:-200}` when no tail is supplied. Keep output bounded. |
| Events | `events <job> [flags]` | Read-only cluster scheduling/debug events. |
| Dry-run submit | `submit --predict-only [submit args]` | Always run before a real submit when possible. Summarize predicted resources/command for user confirmation. |
| Real submit | `submit --confirm-submit [submit args]` or `RJOB_WRAPPER_CONFIRM_SUBMIT=1 ... submit ...` | Only after explicit user confirmation of the dry run or final job spec. Do not hardcode namespace/group/image/path values. |
| Stop job | `stop <job> --confirm-destructive [flags]` | Destructive. Require explicit user confirmation naming the job. |
| Delete job | `delete <job> --confirm-destructive [flags]` | Destructive. Require explicit user confirmation naming the job. Prefer stop first if intent is only to halt work. |
| Clone | `clone <job> [flags]` | Caution: inspect generated spec/command. Do not submit the clone without a separate confirmed submit step. |
| Patch | `patch <job> [flags]` | Caution: patches can change live job behavior. Explain diff/impact and confirm before applying risky changes. |
| Download logs | `download-logs <job> [flags]` | Prefer a user-approved destination under the workspace. Do not overwrite existing artifacts without confirmation. |

## Positioning

`rjob` is for H-cluster batch/cluster training jobs: submit, observe, debug, stop, and collect logs for long-running cluster jobs. It is not a LightClaw runtime backend. Keep interactive sandbox/runtime work on `rlaunch`.
