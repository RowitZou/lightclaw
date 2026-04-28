#!/usr/bin/env python3
"""WebFetch helper for the environment runtime.

Reads JSON from stdin:
  {"url": "...", "max_bytes": 200000, "timeout_seconds": 30}

Writes markdown/text to stdout on success and errors to stderr on failure.
LocalRuntime invokes this with host python; DockerRuntime will invoke the same
script from inside the sandbox image.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

try:
    from markdownify import markdownify as html_to_markdown
except ImportError:
    print("markdownify is not installed. Run: python3 -m pip install --user markdownify", file=sys.stderr)
    sys.exit(2)


def format_json(text: str) -> str:
    try:
        parsed = json.loads(text)
    except Exception:
        return text
    return "```json\n" + json.dumps(parsed, indent=2, ensure_ascii=False) + "\n```"


def main() -> int:
    try:
        config = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        print(f"invalid stdin json: {exc}", file=sys.stderr)
        return 1

    url = str(config.get("url", ""))
    if not url:
        print("url is required", file=sys.stderr)
        return 1

    max_bytes = int(config.get("max_bytes", 200_000))
    timeout = int(config.get("timeout_seconds", 30))

    request = urllib.request.Request(
        url,
        headers={"User-Agent": "LightClaw-WebFetch/0.1"},
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", 0)
            final_url = response.geturl()
            content_type = response.headers.get("content-type", "")
            data = response.read(max_bytes + 1)
    except urllib.error.URLError as exc:
        print(f"fetch failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"unexpected: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    truncated = len(data) > max_bytes
    if truncated:
        data = data[:max_bytes]

    text = data.decode("utf-8", errors="replace")
    content_type_lower = content_type.lower()

    if "html" in content_type_lower or "application/xhtml" in content_type_lower:
        try:
            body = html_to_markdown(text, heading_style="ATX").strip()
        except Exception as exc:
            print(f"markdown conversion failed: {exc}", file=sys.stderr)
            return 1
    elif "json" in content_type_lower:
        body = format_json(text)
    elif (
        "text/" in content_type_lower
        or "markdown" in content_type_lower
        or content_type_lower == ""
    ):
        body = text.strip()
    else:
        print(f"unsupported content type: {content_type}", file=sys.stderr)
        return 1

    header = [
        f"URL: {final_url}",
        f"Status: {status}",
        f"Content-Type: {content_type or 'unknown'}",
        f"Bytes: {len(data)}" + (" (truncated)" if truncated else ""),
        "",
    ]
    print("\n".join(header) + body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
