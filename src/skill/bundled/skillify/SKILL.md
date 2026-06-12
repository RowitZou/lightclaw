---
name: skillify
description: "Capture a repeatable method — the how of a multi-step workflow — as a new skill. For one-off facts or preferences use `remember` instead."
when_to_use: "Use when your requester is establishing a repeatable METHOD you should run the same way next time — the *how* of a multi-step workflow. Explicit ('以后这么做', 'always do it this way', 'make this a skill', a brief that says to capture the method) or implicit when they wrap up a procedure with 'do it like this from now on'. Skip if they're only asking to remember a one-off fact or preference (use `remember` instead), or if the workflow is still being explored / debugged / in flux."
allowed-tools:
  - SkillWrite
  - Read
  - Grep
  - Glob
---

# Skillify {{userDescriptionBlock}}

You are capturing a repeatable workflow your requester just established into a
saved skill so you'll run it the same way next time.

**You capture your own method only.** The skill you save is a procedure YOU
executed, and its frontmatter `roles` names exactly you — the save is refused
otherwise. When the repeatable flow spans work you dispatched, capture your
half (the briefs you wrote, the acceptance criteria, the settle order) and
have each dispatched role capture its own half: say so in the brief, or in
reject feedback while its context is still warm.

## Product framing — read first

Your requester will never read the SKILL.md you produce; they don't know it
has a name, a file path, or that "skills" exist as a system concept. The
promise to them is simple: "I said 'always do X this way' and it remembered."

So:
- **You** pick the name, the file location, the tool list, and the body
  structure. None of that surfaces to the user.
- **You** decide whether something varies next time and becomes \`$ARGUMENTS\`.
- **Your requester** is consulted only about needs: *when* should this fire
  next time, *what counts as done*, *what must never happen*, *where to pause
  for confirmation*. Always in their domain language.

Decide first, ask second.

## Your Session Context

Here is the session memory summary:
<session_memory>
{{sessionMemory}}
</session_memory>

Here are the requester's messages during this session. Pay attention to how they
steered you — corrections become hard rules, repeated preferences become
defaults:
<user_messages>
{{userMessages}}
</user_messages>

## Your Task

### Step 1: Analyze the session

Before asking anything, work out from the transcript:
- The repeatable process your requester wants remembered
- Distinct steps, in order
- Inputs the requester supplied — which ones could vary next time? Those become
  \`$ARGUMENTS\`.
- A success artifact for each step (not "wrote code" but "PR open with CI
  green")
- Where the requester corrected or steered you — these are constraints, not
  nice-to-haves
- Which tools were actually used
- Anything that must NEVER happen (the requester said "no", "don't", "stop")
- Whether any step is a fixed, deterministic procedure (parsing, formatting,
  a set API-call sequence) that runs more reliably as a script than as prose —
  those become a `scripts/` helper.
- Whether any step is already covered by a skill you can see — those become a
  `UseSkill('<name>')` call in the body, not steps you re-encode.

### Step 2: Decide whether to ask — and only ask what's truly unresolved

Default to *not* asking. Most workflows worth capturing were demonstrated
end-to-end in the session — you have enough to write the skill. Asking turns
a smooth "got it, saved" interaction into a quiz.

Ask only when, after Step 1's analysis, you genuinely cannot proceed
without your requester's input. Concrete cases that warrant asking:

- **Ambiguous trigger**: the session showed one example, but the next
  invocation could come in multiple shapes and *which* shape changes how
  the skill should fire (e.g. "for any Linear ticket" vs "only P0").
- **Branch you never saw**: the workflow has a fork (CI passed / failed,
  conflict / no conflict) and the session only walked one path — you need
  to know what the other path should do, or whether to halt for a human.
- **Hidden constraint suspected**: the requester corrected you mid-flow
  ("don't do X"), and you can't tell whether that was one-off or a
  standing rule worth encoding.
- **Irreversible action without a confirmation cue**: a step is destructive
  (merge, force-push, send) and the session didn't establish whether to
  pause for confirmation before it.

If none apply, skip Step 2 entirely. Write the skill from what you
observed.

When you do ask, use \`AskUserQuestion\` when it is in your tool catalog —
group related questions into a single call (up to 4), never plain text, and
don't add your own "needs tweaking" placeholder option. Without the card
tool, ask upward instead (Message with no \`to\`), one bundled question with
concrete options and a default.

Phrase every option in your requester's domain language ("when I drop a
Linear ticket link"), not yours. Use
\`multiSelect: true\` when options aren't mutually exclusive. Never ask
about names, file locations, allowed tools, or anything implementation-
flavored — you decide those.

### Step 3: Write the SKILL.md

Keep the body lean and imperative — a skill is a procedure, not a tutorial.
Encode the brittle specifics the session surfaced (exact commands, ordering,
hard constraints, the gotchas that bit you) and leave out generic advice
you'd follow anyway; every line gets re-read on each future run.

You decide all of the following without asking:

- **name**: short kebab-case slug derived from what the workflow does
  (\`cherrypick-to-release\`, \`triage-linear-ticket\`). The requester never sees this.
- **description**: one line, in the requester's domain language — this is what
  future requests are matched against.
- **when_to_use**: starts with "Use when…", encodes the trigger phrasings
  your requester used (or that you inferred), includes 2-3 example requests.
- **roles**: exactly yourself — \`roles: [<your role>]\`. The save refuses
  anything else; a method another role runs is theirs to capture.
- **allowed-tools**: minimum tools you actually used, from your own tool
  catalog. Use patterns (\`Bash(gh:*)\`, not bare \`Bash\`). Never list a tool
  you only saw mentioned in a report — if you didn't call it, it doesn't
  belong here.
- **Arguments**: only if something genuinely varies next time. Single
  positional \`$ARGUMENTS\` — reference it in the body where it gets
  substituted.
- **Steps**: numbered. Each step has a \`**Success criteria**:\` line
  (required). Add \`**Human checkpoint**:\` for steps that are destructive
  or that you (or the user, if asked) decided need confirmation. Add
  \`**Rules**:\` lines for hard constraints surfaced by session corrections
  or by the user's answers. Don't pad obvious steps with empty
  annotations.

Format:

\`\`\`markdown
---
name: {{kebab-slug}}
description: {{one line, requester's language}}
when_to_use: {{Use when… + trigger phrasings + 2-3 example messages}}
roles:
  - {{your own role}}
allowed-tools:
  - {{tool pattern}}
  - {{tool pattern}}
{{argument-hint: "<arg>" — only if arguments}}
{{arguments:
  - {{name}} — only if arguments}}
---

# {{Skill Title}}
{{One sentence describing the workflow.}}

{{## Inputs — only if arguments}}

## Goal
{{Plain outcome statement.}}

## Steps

### 1. {{Step name}}
{{What to do, concrete and actionable.}}

**Success criteria**: {{required}}

### 2. {{Step name}}
…
\`\`\`

**Supporting files (optional).** When a step is a fixed, deterministic
procedure, write it as a helper instead of prose — the model re-deriving the
same parsing/formatting every run is where skills drift. Put helpers under
`scripts/` and longer reference docs under `references/`, and reference them
from the body as `${LIGHTCLAW_SKILL_DIR}/scripts/<file>`. Before saving:
write the script into your workspace, run it with Bash on a real input, and
confirm it works — only then pass its verified contents to `SkillWrite`'s
`files`. A script you never ran is a guess. The script runs from
`${LIGHTCLAW_SKILL_DIR}/scripts/` at use time — a different path than where
you tested it — so keep it self-contained: take input via arguments or stdin,
and don't hardcode absolute paths. If the body invokes a script, list its
interpreter in `allowed-tools` (e.g. `Bash(python:*)`).

**Reusing an existing skill (optional).** When a step is something a saved
skill already does, don't re-encode it — have the body call `UseSkill('<name>')`
there so that skill's procedure runs inline. Compose instead of copying its
steps, for the same reason you'd call a shared helper rather than paste it: when
either skill changes they stay in sync. Only reuse a skill you can see and that
cleanly covers the step; if it only half-fits, write the step out directly.

Save via `SkillWrite` — the SKILL.md as `markdown`, any helpers as `files`.
The save location is fixed; don't ask about it.

### Step 4: Tell your requester, in their language

Do NOT print the SKILL.md. Do NOT mention the slug, the file path, or
"skills" as a system concept. Just say, in natural language, what they'll
get next time. Something like:

> Got it — next time you {{trigger paraphrased}}, I'll {{step 1
> paraphrased}}, then {{step 2}}, then {{step 3}}. {{If you added a
> human checkpoint, mention it: "I'll check with you before merging."}}
> If you want to tweak it later, just tell me.

The save is invisible to your requester; the promise is in plain language.
