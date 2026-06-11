---
name: build-environment
description: "How to build or repair a project's runtime environment correctly, for any stack — reuse first, read what the project actually needs (versions, platform, compute target, system deps), confirm the planned install, install the project's own way, and validate before anything depends on it."
when_to_use: "Use when you must create, repair, or extend the environment a project or job runs in — installing its dependencies, toolchain, or runtime so its build / tests / imports pass. Covers Python / conda / venv, Node, Rust, JVM, system packages, and the like. Invoked on its own, or composed from another skill at the point an environment has to be built."
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - MemoryWrite
roles:
  - generalist
  - coder
---

# Building a project environment

Setting up an environment is a real engineering step, not a quick install. A wrong one — the wrong build of a framework, half the dependencies, a pile of one-off installs reacting to errors — wastes everything that runs on top of it. Do it deliberately. The discipline below is the same whatever the stack; the specifics come from the project and the machine, not from defaults.

## Reuse, then read what's needed

1. **Reuse before you build.** If a working environment already exists — in the workspace, shipped by the image / machine, or one you recorded — use it. Only build when nothing usable is there.
2. **Read what the project actually needs; don't assume the default.** The decisive constraints live in the project and the box, not in the tool's defaults: language / runtime version, OS / platform, the **compute target** (which build variant the hardware calls for — CPU vs an accelerator, matched to what's actually present), and system-level libraries. Read them off the project (its manifests, its docs) and the machine, and build to *that*.

## Settle the plan in one pass, confirm it once, then build

3. **Work out the whole plan up front, not by trial and error.** Before you install anything, read the project's own statement of what it needs — README / setup script, the ecosystem's manifest + lockfile, documented extras — and assemble as complete a plan as you can: which of the choices above are still open (reuse-vs-build, runtime version, compute target, base image) *and* the concrete package + version list. Hitting an unforeseen gap later and adding a dependency is fine; what you avoid is going in blind and discovering the whole set one failure at a time.
4. **Confirm the whole plan once — in a single card.** Decide your recommended value for everything still open *and* the package list, and surface them **together in one `AskUserQuestion` card** (it carries several questions at once), each pre-set to your recommendation. One confirmation, not a habit of halting at each uncertainty: bundling the open points lets a long autonomous run keep moving while giving the user a single window to redirect a wrong call (the CPU-vs-GPU build, the wrong base env) before the expensive install. The recommendation you put up is what the user is signing off on — treat it as their standing approval, the agreed plan unless they choose otherwise; you don't re-ask each point. Once the plan is set, the extra deps you hit mid-install don't go back for confirmation — fix forward.
   - **No card tool (you're a worker):** put the same plan — your chosen values and the package list — in your result for your requester rather than installing silently on a guess.
5. **Use the right tool and a stable, isolated location — one env per compatible requirement set.** Pick the ecosystem's own isolation, in a named, self-contained location that can be reused — not a throwaway temp dir. If a project's requirements conflict with an existing env — it needs a different, incompatible version of a shared library — **don't fight to satisfy both in one env; stand up a separate one.** Environments are cheap; an afternoon lost to an unwinnable version-pin tug-of-war is not.
6. **Install from the project's own instructions.** Follow the README / setup script and the ecosystem's manifest + lockfile, in the order they give — the plan from step 3 is *what* you install, the project's instructions are *how*. Don't hand-assemble the env from defaults when the project documents its own setup.

## Prove it before anything depends on it

7. **Validate before you hand it off** with a check that matches the target, not just "it installed": the project's own smoke (import / build / a one-step test), plus a platform-visible check (the runtime can actually see the device it needs; a built binary runs). An env that "installed" but won't import, or can't see the hardware it's for, is not done.
8. **Report the facts that show whether it's right** — where the env is and the decisive versions: runtime version, the key framework, the **build variant**, whether the target device is visible. "Installed it" without these hides exactly the failure this skill exists to catch.

## Stack-specific detail

This skill ships executable, per-stack guides under `references/`. **List `${LIGHTCLAW_SKILL_DIR}/references/`**; if a guide matches your stack, read and follow it — it's the concrete commands behind the general method above. If your stack has no guide yet, follow the project's own setup + lockfile and confirm the plan with your requester; the general method still holds.

## Do not

- Do not assume the tool's default build / index — match the project and the machine (the compute target especially).
- Do not discover the requirement set one failure at a time — work the plan out as fully as you can up front, then install from the project's own instructions.
- Do not drip-feed confirmations — surface the open choices and the package list to your requester once, in a single card with recommended defaults, before the install (step 4); don't stop at each uncertainty.
- Do not call an env ready on "it installed" — call it ready on the project's smoke plus a platform-visible check.
