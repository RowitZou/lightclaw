#!/usr/bin/env python3
"""Glob helper for the environment runtime."""

from __future__ import annotations

import fnmatch
import json
import sys
from pathlib import Path


def expand(pattern: str, cwd: Path, dot: bool) -> list[str]:
    matches: list[str] = []
    for candidate in cwd.glob(pattern):
        rel = candidate.relative_to(cwd)
        if not dot and any(part.startswith(".") for part in rel.parts):
            continue
        matches.append(str(rel))
    return matches


def matches_ignore(rel_path: str, ignore_patterns: list[str]) -> bool:
    return any(
        fnmatch.fnmatch(rel_path, pattern)
        or fnmatch.fnmatch(rel_path, pattern.rstrip("/"))
        for pattern in ignore_patterns
    )


def main() -> int:
    try:
        config = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        print(f"invalid stdin json: {exc}", file=sys.stderr)
        return 1

    patterns = config.get("pattern")
    if isinstance(patterns, str):
        patterns = [patterns]
    if not patterns:
        print("pattern is required", file=sys.stderr)
        return 1

    cwd = Path(config.get("cwd", ".")).resolve()
    if not cwd.exists() or not cwd.is_dir():
        print(f"cwd does not exist: {cwd}", file=sys.stderr)
        return 1

    ignore = config.get("ignore", [])
    only_files = bool(config.get("onlyFiles", True))
    dot = bool(config.get("dot", False))

    seen: set[str] = set()
    results: list[str] = []
    for pattern in patterns:
        for rel_path in expand(pattern, cwd, dot):
            if matches_ignore(rel_path, ignore):
                continue
            absolute = cwd / rel_path
            if only_files and not absolute.is_file():
                continue
            if rel_path in seen:
                continue
            seen.add(rel_path)
            results.append(rel_path)

    for rel_path in sorted(results):
        print(rel_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
