#!/usr/bin/env python3
"""WebSearch helper for the environment runtime.

Reads JSON from stdin:
  {
    "query": "...",
    "max_results": 10,
    "allowed_domains": [],
    "blocked_domains": []
  }

If LIGHTCLAW_SEARCH_API_URL and LIGHTCLAW_SEARCH_API_KEY are present, the helper
calls that JSON endpoint. Otherwise it falls back to DuckDuckGo HTML search.
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


def hostname(url: str) -> str:
    return urllib.parse.urlparse(url).hostname or ""


def domain_allowed(url: str, allowed: list[str], blocked: list[str]) -> bool:
    host = hostname(url).lower()
    if not host:
        return False
    if allowed and not any(host == item or host.endswith("." + item) for item in allowed):
        return False
    if any(host == item or host.endswith("." + item) for item in blocked):
        return False
    return True


def fetch_json_search(query: str, max_results: int) -> list[dict[str, str]]:
    api_url = os.environ.get("LIGHTCLAW_SEARCH_API_URL", "").strip()
    api_key = os.environ.get("LIGHTCLAW_SEARCH_API_KEY", "").strip()
    brave_key = os.environ.get("BRAVE_SEARCH_API_KEY", "").strip()

    if brave_key and not api_url:
        api_url = "https://api.search.brave.com/res/v1/web/search"
        api_key = brave_key

    if not api_url or not api_key:
        return []

    params = urllib.parse.urlencode({"q": query, "count": max_results})
    separator = "&" if "?" in api_url else "?"
    request = urllib.request.Request(
        f"{api_url}{separator}{params}",
        headers={
            "Accept": "application/json",
            "User-Agent": "LightClaw-WebSearch/0.1",
            "X-Subscription-Token": api_key,
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read(2 * 1024 * 1024).decode("utf-8", errors="replace"))

    raw_results = []
    if isinstance(data, dict):
        if isinstance(data.get("web"), dict) and isinstance(data["web"].get("results"), list):
            raw_results = data["web"]["results"]
        elif isinstance(data.get("results"), list):
            raw_results = data["results"]

    results: list[dict[str, str]] = []
    for item in raw_results[:max_results]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("name") or "Untitled")
        url = str(item.get("url") or item.get("link") or "")
        snippet = str(item.get("description") or item.get("snippet") or "")
        if url:
            results.append({"title": title, "url": url, "snippet": snippet})
    return results


def fetch_duckduckgo(query: str, max_results: int) -> list[dict[str, str]]:
    url = "https://duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    # DDG's /html/ endpoint serves an anomaly / captcha page when the UA
    # smells like a bot. A current Chrome string keeps the lite-HTML branch.
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        text = response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")

    results: list[dict[str, str]] = []
    blocks = re.findall(r'<a rel="nofollow" class="result__a" href="(.*?)">(.*?)</a>', text, re.S)
    snippets = re.findall(r'<a class="result__snippet".*?>(.*?)</a>', text, re.S)
    for idx, (raw_url, raw_title) in enumerate(blocks[:max_results]):
        parsed = urllib.parse.urlparse(html.unescape(raw_url))
        params = urllib.parse.parse_qs(parsed.query)
        target = params.get("uddg", [html.unescape(raw_url)])[0]
        title = re.sub(r"<.*?>", "", raw_title, flags=re.S)
        snippet = snippets[idx] if idx < len(snippets) else ""
        snippet = re.sub(r"<.*?>", "", snippet, flags=re.S)
        results.append({
            "title": html.unescape(title).strip() or "Untitled",
            "url": target,
            "snippet": html.unescape(snippet).strip(),
        })
    return results


def render_results(query: str, results: list[dict[str, str]]) -> str:
    lines = [f"# Search results for: {query}", ""]
    if not results:
        return "\n".join(lines + ["No search results found."])
    for idx, item in enumerate(results, start=1):
        title = item["title"].replace("[", "\\[").replace("]", "\\]")
        lines.append(f"{idx}. [{title}]({item['url']})")
        if item.get("snippet"):
            lines.append(f"   {item['snippet']}")
    return "\n".join(lines)


def main() -> int:
    try:
        config = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        print(f"invalid stdin json: {exc}", file=sys.stderr)
        return 1

    query = str(config.get("query", "")).strip()
    if not query:
        print("query is required", file=sys.stderr)
        return 1

    max_results = int(config.get("max_results", 10))
    allowed = [str(item).lower() for item in config.get("allowed_domains", [])]
    blocked = [str(item).lower() for item in config.get("blocked_domains", [])]

    try:
        results = fetch_json_search(query, max_results)
        if not results:
            results = fetch_duckduckgo(query, max_results)
    except urllib.error.URLError as exc:
        print(f"search failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"unexpected: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    filtered = [
        item for item in results
        if domain_allowed(item["url"], allowed, blocked)
    ][:max_results]
    print(render_results(query, filtered))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
