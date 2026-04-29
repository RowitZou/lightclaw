# LightClaw Runtime Safety Notes

- LocalRuntime is admin-only. When `runtime.backend = "local"`, paired non-admin users must not acquire a runtime; multi-user service must use DockerRuntime or RjobRuntime.
- Do not add path-string workspace guards to tools or permission policy. Runtime safety comes from the LocalRuntime admin-only gate, Docker/Rjob isolation, read-only mounts, and the Phase 5 permission system.

# LightClaw Permission System Notes

- Approval suggestion granularity is owned by the tool. New tools that have a meaningfully scopable input (command head, path prefix, hostname, MCP `server:tool`) should implement `Tool.suggestPermissionRules(input)` returning a precise→broad list of `PermissionRuleValue`. Tools that omit it fall back to a single tool-wide allow option. Approvers (terminal numbered prompt, Feishu N-button card) only render the list — they do not derive granularity themselves.
- `ask` outranks `allow` in `evaluatePermission`. Rules in `permissions.json`'s `ask: [...]` array force the ASK flow even under `bypassPermissions`; only `deny` outranks them. Use this to keep critical operations (`Bash(rm:*)`, `Edit(/etc/**)`) confirmable while running otherwise-permissive sessions.
