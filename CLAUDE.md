# LightClaw Runtime Safety Notes

- LocalRuntime is admin-only. When `runtime.backend = "local"`, paired non-admin users must not acquire a runtime; multi-user service must use DockerRuntime or RjobRuntime.
- Do not add path-string workspace guards to tools or permission policy. Runtime safety comes from the LocalRuntime admin-only gate, Docker/Rjob isolation, read-only mounts, and the Phase 5 permission system.

# LightClaw Permission System Notes

- `Tool.suggestPermissionRules(input)` returns a *set of rules to install as a group* — not a precise→broad menu. For a chained Bash command the suggester emits one `Bash(<head>:*)` rule per subcommand (split on `;`/`&&`/`||`/`|`, max 5); for path tools a single `Tool(<dir>/**)` rule; for WebFetch a single `WebFetch(<hostname>)` rule; for MCP a single `MCP(<server>:<tool>)` rule. New tools should follow the same shape — return an empty array when no precise scope is derivable, and the approver will fall back to a single tool-wide allow rule.
- Approvers render a fixed three-option UX (Allow once / Allow <merged label> / Deny). The middle option installs every rule in the suggester's array in one go, and the merged label is built by `formatSuggestionLabel` (degrades to `N 类 …` past 50 chars). Faithful port of Claude Code's `bashToolUseOptions.tsx` + `generateShellSuggestionsLabel`. Do not add per-rule buttons or tier-selection UX back.
- `ask` outranks `allow` in `evaluatePermission`. Rules in `permissions.json`'s `ask: [...]` array force the ASK flow even under `bypassPermissions`; only `deny` outranks them. Use this to keep critical operations (`Bash(rm:*)`, `Edit(/etc/**)`) confirmable while running otherwise-permissive sessions.
