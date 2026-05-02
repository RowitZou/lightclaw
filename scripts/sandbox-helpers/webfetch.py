#!/usr/bin/env python3
"""WebFetch helper for the environment runtime.

Reads JSON from stdin:
  {"url": "...", "max_bytes": 200000, "timeout_seconds": 30}

Writes markdown/text to stdout on success and errors to stderr on failure.
LocalRuntime invokes this with host python; DockerRuntime / RlaunchRuntime
invoke the same script from inside the sandbox image.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

# trafilatura extracts the article body from HTML (drops nav / footer / sidebars
# / cookie banners). markdownify is the dump-everything fallback used when
# extraction returns nothing — useful for short pages, JSON-rendered SPAs,
# and stripped-down HTML where there's no "main content" to find.
try:
    import trafilatura
except ImportError:
    trafilatura = None

try:
    from markdownify import markdownify as html_to_markdown
except ImportError:
    print("markdownify is not installed. Run: python3 -m pip install --user markdownify", file=sys.stderr)
    sys.exit(2)

# Mimic a current Chrome on Linux. urllib's default UA is `Python-urllib/x.y`,
# which Cloudflare/Akamai/Distill flag as a bot and either 403 or serve a JS
# challenge that this helper can't solve.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
BROWSER_HEADERS = {
    "User-Agent": BROWSER_USER_AGENT,
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "application/rss+xml;q=0.9,application/atom+xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def format_json(text: str) -> str:
    try:
        parsed = json.loads(text)
    except Exception:
        return text
    return "```json\n" + json.dumps(parsed, indent=2, ensure_ascii=False) + "\n```"


def html_to_body(text: str) -> str:
    """Prefer trafilatura main-content extraction; fall back to markdownify
    if extraction returns nothing (typical for short pages or SPAs whose
    static HTML is just a JS bootstrap)."""
    if trafilatura is not None:
        try:
            extracted = trafilatura.extract(
                text,
                output_format="markdown",
                include_links=True,
                include_tables=True,
                include_comments=False,
                favor_precision=True,
            )
            if extracted and extracted.strip():
                return extracted.strip()
        except Exception as exc:
            print(f"trafilatura extraction failed: {exc}; falling back to markdownify", file=sys.stderr)
    return html_to_markdown(text, heading_style="ATX").strip()


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

    request = urllib.request.Request(url, headers=BROWSER_HEADERS)

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

    # Treat XML feeds (RSS / Atom) and generic XML as HTML-shaped content;
    # trafilatura handles them, and markdownify is a reasonable fallback.
    is_html_like = (
        "html" in content_type_lower
        or "application/xhtml" in content_type_lower
        or "application/xml" in content_type_lower
        or "application/rss" in content_type_lower
        or "application/atom" in content_type_lower
        or "text/xml" in content_type_lower
    )

    if is_html_like:
        try:
            body = html_to_body(text)
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
