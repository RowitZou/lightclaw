# LightClaw Runtime Safety Notes

- LocalRuntime is admin-only. When `runtime.backend = "local"`, paired non-admin users must not acquire a runtime; multi-user service must use DockerRuntime or RjobRuntime.
- Do not add path-string workspace guards to tools or permission policy. Runtime safety comes from the LocalRuntime admin-only gate, Docker/Rjob isolation, read-only mounts, and the Phase 5 permission system.
- RlaunchRuntime never uses `brainctl exec -i`. The cluster's brainctl exec drops stdin payloads silently (the `9cafbdc` writeFile incident: ~16% silent corruption) and also suppresses stdout when `-i` is opened with no real stdin. Every `ExecInput.stdin` is folded into the bash command body via `composeExecScript` (base64 inline + brace group so the pipe feeds the whole `&&` chain). Per-call cap is 32 KB raw — empirically the brainctl ws frame fails above ~57 KB total script. `fs.writeFile` chunks transparently above the cap; new tools that hand large payloads to a helper should chunk via `fs.writeFile` + read-from-disk rather than growing the cap.

# LightClaw Permission System Notes

- `Tool.suggestPermissionRules(input)` returns a *set of rules to install as a group* — not a precise→broad menu. For a chained Bash command the suggester emits one `Bash(<head>:*)` rule per subcommand (split on `;`/`&&`/`||`/`|`, max 5); for path tools a single `Tool(<dir>/**)` rule; for WebFetch a single `WebFetch(<hostname>)` rule; for MCP a single `MCP(<server>:<tool>)` rule. New tools should follow the same shape — return an empty array when no precise scope is derivable, and the approver will fall back to a single tool-wide allow rule.
- Approvers render a fixed three-option UX (Allow once / Allow <merged label> / Deny). The middle option installs every rule in the suggester's array in one go, and the merged label is built by `formatSuggestionLabel` (degrades to `N 类 …` past 50 chars). Faithful port of Claude Code's `bashToolUseOptions.tsx` + `generateShellSuggestionsLabel`. Do not add per-rule buttons or tier-selection UX back.
- `ask` outranks `allow` in `evaluatePermission`. Rules in `permissions.json`'s `ask: [...]` array force the ASK flow even under `bypassPermissions`; only `deny` outranks them. Use this to keep critical operations (`Bash(rm:*)`, `Edit(/etc/**)`) confirmable while running otherwise-permissive sessions.

# LightClaw Memory Extraction Notes

- Auto-memory extraction goes through the forked-agent runner (`src/agents/forked-agent.ts`) and uses tool-use (`MemoryWrite`). Do not restore the old "emit JSON text -> JSON.parse" path; long sessions with quoted or nested content can corrupt JSON text and silently lose memories.
- The extraction subagent's tool gate is `createAutoMemCanUseTool`: `MemoryWrite`, `MemoryRead`, `Read`, `Grep`, `Glob`, and read-only `Bash` are allowed; everything else, including `Write`, `Edit`, `AgentTool`, and MCP tools, is denied.
- `inProgress + pendingContext` coalescing prevents high-frequency turns from spawning many extraction forks. Do not bypass it by calling the extraction inner loop directly.
- `drainPendingExtraction(60_000)` must run from process exit paths. New daemon or shutdown paths need to wire the same drain.
