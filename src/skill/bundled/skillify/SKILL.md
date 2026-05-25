---
name: skillify
description: "Capture a repeatable method — the how of a multi-step workflow — as a new skill. For one-off facts or preferences use `remember` instead."
when_to_use: "Use when the user is establishing a repeatable METHOD you should run the same way next time — the *how* of a multi-step workflow. Explicit ('以后这么做', 'always do it this way', 'make this a skill') or implicit when they wrap up a procedure with 'do it like this from now on'. Skip if they're only asking to remember a one-off fact or preference (use `remember` instead), or if the workflow is still being explored / debugged / in flux."
allowed-tools:
  - SkillWrite
  - AskUserQuestion
  - Read
  - Grep
  - Glob
---

# Skillify {{userDescriptionBlock}}

You are capturing a repeatable workflow the user just established into a saved
skill so you'll run it the same way next time.

## Product framing — read first

The user talks to you on Feishu, not a terminal. They will never read the
SKILL.md you produce; they don't know it has a name, a file path, or that
"skills" exist as a system concept. The promise to them is simple: "I told
the agent 'always do X this way' and it remembered."

So:
- **You** pick the name, the file location, the tool list, and the body
  structure. None of that surfaces to the user.
- **You** decide whether something varies next time and becomes \`$ARGUMENTS\`.
- **The user** is consulted only about needs: *when* should this fire next
  time, *what counts as done*, *what must never happen*, *where to pause for
  confirmation*. Always in their domain language.

Decide first, ask second.

## Your Session Context

Here is the session memory summary:
<session_memory>
{{sessionMemory}}
</session_memory>

Here are the user's messages during this session. Pay attention to how they
steered you — corrections become hard rules, repeated preferences become
defaults:
<user_messages>
{{userMessages}}
</user_messages>

## Your Task

### Step 1: Analyze the session

Before asking anything, work out from the transcript:
- The repeatable process the user wants remembered
- Distinct steps, in order
- Inputs the user supplied — which ones could vary next time? Those become
  \`$ARGUMENTS\`.
- A success artifact for each step (not "wrote code" but "PR open with CI
  green")
- Where the user corrected or steered you — these are constraints, not
  nice-to-haves
- Which tools were actually used
- Anything that must NEVER happen (the user said "no", "don't", "stop")

### Step 2: Decide whether to ask — and only ask what's truly unresolved

Default to *not* asking. Most workflows the user wants captured were
demonstrated end-to-end in the session — you watched them do it, you have
enough to write the skill. Asking turns a smooth "got it, saved"
interaction into a quiz.

Ask only when, after Step 1's analysis, you genuinely cannot proceed
without the user's input. Concrete cases that warrant asking:

- **Ambiguous trigger**: the session showed one example, but the next
  invocation could come in multiple shapes and *which* shape changes how
  the skill should fire (e.g. "for any Linear ticket" vs "only P0").
- **Branch you never saw**: the workflow has a fork (CI passed / failed,
  conflict / no conflict) and the session only walked one path — you need
  to know what the other path should do, or whether to halt for a human.
- **Hidden constraint suspected**: the user corrected you mid-flow
  ("don't do X"), and you can't tell whether that was one-off or a
  standing rule worth encoding.
- **Irreversible action without a confirmation cue**: a step is destructive
  (merge, force-push, send) and the session didn't establish whether to
  pause for confirmation before it.

If none apply, skip Step 2 entirely. Write the skill from what you
observed.

When you do ask, use \`AskUserQuestion\` (load it via ToolSearch first if it
isn't in your tool list). Never plain text. Group related questions into a
single call (up to 4). The user has a freeform slot per question — don't
add your own "needs tweaking" placeholder option.

Phrase every option in the user's domain language ("when I drop a Linear
ticket link"), not yours ("when the requester invokes …"). Use
\`multiSelect: true\` when options aren't mutually exclusive. Never ask
about names, file locations, allowed tools, or anything implementation-
flavored — you decide those.

### Step 3: Write the SKILL.md

You decide all of the following without asking:

- **name**: short kebab-case slug derived from what the workflow does
  (\`cherrypick-to-release\`, \`triage-linear-ticket\`). The user never sees this.
- **description**: one line, in the user's domain language — this is what
  the dispatcher matches against future requests.
- **when_to_use**: starts with "Use when…", encodes the trigger phrasings
  the user picked (or that you inferred), includes 2-3 example user
  messages.
- **allowed-tools**: minimum tools you actually need from what you observed.
  Use patterns (\`Bash(gh:*)\`, not bare \`Bash\`).
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
description: {{one line, user's language}}
when_to_use: {{Use when… + trigger phrasings + 2-3 example messages}}
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

Save via \`SkillWrite\` to per-user storage. The save location is fixed; don't
ask the user about it.

### Step 4: Tell the user, in their language

Do NOT print the SKILL.md. Do NOT mention the slug, the file path, or
"skills" as a system concept. Just tell the user, in natural language, what
they'll get next time. Something like:

> Got it — next time you {{trigger paraphrased}}, I'll {{step 1
> paraphrased}}, then {{step 2}}, then {{step 3}}. {{If you added a
> human checkpoint, mention it: "I'll check with you before merging."}}
> If you want to tweak it later, just tell me.

The save is invisible to the user; the promise is in plain language.
