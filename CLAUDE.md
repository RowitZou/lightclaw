# LightClaw Runtime Safety Notes

- LocalRuntime is admin-only. When `runtime.backend = "local"`, paired non-admin users must not acquire a runtime; multi-user service must use DockerRuntime or RjobRuntime.
- Do not add path-string workspace guards to tools or permission policy. Runtime safety comes from the LocalRuntime admin-only gate, Docker/Rjob isolation, read-only mounts, and the Phase 5 permission system.
