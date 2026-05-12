#!/usr/bin/env python3
"""WebFetch helper for the environment runtime.

Reads JSON from stdin:
  {
    "url": "...",
    "max_bytes": 200000,
    "timeout_seconds": 30,
    "download_dir": "/workspace/.lightclaw/downloads"   # optional
  }

For text-shaped content (text/*, +json, +xml, application/javascript, form-data)
the helper extracts a Markdown / text body and writes it to stdout.

For binary content (application/pdf, images, archives, office docs, ...) the
raw bytes are written to `download_dir/<filename>` and stdout reports the
saved path. The agent decides what to do with the file (Read for PDFs,
AnalyzeVisuals for images, Bash for archives, ...). When `download_dir` is
not provided the helper still rejects binary with exit 1.

LocalRuntime invokes this with host python; DockerRuntime / RlaunchRuntime
invoke the same script from inside the sandbox image.
"""

from __future__ import annotations

import json
import os
import os.path
import posixpath
import re
import secrets
import sys
from urllib.parse import urlparse

# httpx replaces stdlib urllib because urllib's HTTPRedirectHandler in Python
# 3.10 (Ubuntu 22.04 system Python) lacks a `http_error_308` handler — it
# raises HTTPError on RFC 7538 Permanent Redirects instead of following them,
# and trailing-slash Next.js sites (alphaxiv, many Cloudflare-fronted hosts)
# answer / → /+slash with 308. httpx follows 308 by default and additionally
# gives us split connect/read timeouts so stderr can distinguish "server
# unreachable" from "server slow"; both are required for sensible WebFetch
# diagnostics. The dep is staged into rlaunch workers via the same preheat
# path as trafilatura/markdownify (rlaunch.ts:stageHelpersOnce) and baked
# into the Docker image at layer 3.
try:
    import httpx
except ImportError:
    print(
        "httpx is not installed. Run: python3 -m pip install --user httpx",
        file=sys.stderr,
    )
    sys.exit(2)

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
        "application/pdf;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


# Mime → extension map. Mirrors Claude Code mcpOutputStorage.extensionForMimeType
# (same vocabulary keeps cross-tool behavior predictable). Entries here are
# only consulted on the binary path; text content_types never reach this.
MIME_TO_EXT = {
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "application/x-tar": "tar",
    "application/gzip": "gz",
    "application/x-gzip": "gz",
    "application/x-bzip2": "bz2",
    "application/x-7z-compressed": "7z",
    "application/x-rar-compressed": "rar",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/msword": "doc",
    "application/vnd.ms-excel": "xls",
    "application/vnd.ms-powerpoint": "ppt",
    "application/octet-stream": "bin",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/x-wav": "wav",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    # Note: image/svg+xml is treated as text (xml-shaped) below, not here.
    "image/bmp": "bmp",
    "image/tiff": "tiff",
}


def is_text_content_type(mime: str) -> bool:
    """Mirrors Claude Code mcpOutputStorage.isBinaryContentType (inverted).

    text/*, +json, +xml, application/javascript, form-encoded → text.
    Everything else (pdf, images, office, archives, audio/video, octet-stream)
    is binary and gets persisted to disk.
    """
    if not mime:
        # Unknown content-type: behave like the old helper did and treat as
        # text (utf-8 decode + fall through). Servers that mean to serve a
        # binary blob almost always send a header.
        return True
    mt = mime.split(";", 1)[0].strip().lower()
    if not mt:
        return True
    if mt.startswith("text/"):
        return True
    if mt.endswith("+json") or mt == "application/json":
        return True
    if mt.endswith("+xml") or mt == "application/xml":
        return True
    if mt.startswith("application/javascript"):
        return True
    if mt == "application/x-www-form-urlencoded":
        return True
    return False


def ext_for_mime(mime: str) -> str:
    if not mime:
        return "bin"
    mt = mime.split(";", 1)[0].strip().lower()
    return MIME_TO_EXT.get(mt, "bin")


_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]")


def derive_filename(url: str, mime: str) -> str:
    """Build a safe, somewhat-readable filename from the URL's path basename
    and the response mime. The mime-derived extension is authoritative —
    URL paths like `/2509.25721` (arxiv-style numeric IDs) would otherwise
    confuse os.path.splitext into treating `.25721` as an extension. A
    6-char random suffix is always appended so repeated fetches of the same
    URL never silently overwrite — cheaper than stat + retry, and downstream
    tools that already grabbed the path keep working."""
    try:
        parsed = urlparse(url)
        raw = posixpath.basename(parsed.path or "")
    except Exception:
        raw = ""
    raw = raw.strip()
    target_ext = ext_for_mime(mime)
    # Strip the redundant extension if the URL basename already carries it,
    # so `/sample.pdf` becomes `sample-<rand>.pdf` rather than the doubled
    # `sample.pdf-<rand>.pdf`. Comparison is case-insensitive on a copy;
    # the original casing of the kept portion is preserved in name_part.
    raw_lower = raw.lower()
    suffix = "." + target_ext
    if raw_lower.endswith(suffix):
        name_part = raw[: -len(suffix)]
    else:
        name_part = raw
    name_part = _FILENAME_SAFE_RE.sub("-", name_part).strip("-_.")[:64]
    if not name_part:
        name_part = "webfetch"
    rand = secrets.token_hex(3)
    return f"{name_part}-{rand}.{target_ext}"


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


def format_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes}B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f}KB"
    if num_bytes < 1024 * 1024 * 1024:
        return f"{num_bytes / 1024 / 1024:.1f}MB"
    return f"{num_bytes / 1024 / 1024 / 1024:.2f}GB"


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
    timeout_total = int(config.get("timeout_seconds", 30))
    download_dir = config.get("download_dir")
    if download_dir is not None:
        download_dir = str(download_dir)

    # Split timeout: connect/write get a short fixed budget (10s, clamped to
    # the caller's total if smaller) — a server we can't reach should fail
    # fast. Read gets the full caller-provided budget so slow-streaming bodies
    # (large PDFs, flaky upstreams) can still complete. The split is the whole
    # diagnostic point: stderr separates "connect timeout" from "read timeout"
    # so the caller can distinguish "host unreachable / DNS dead" from "server
    # accepted us then stalled", which urllib's single-deadline model collapsed
    # into a single "URLError: timed out" string.
    connect_budget = min(10, timeout_total)
    read_budget = timeout_total

    try:
        with httpx.Client(
            headers=BROWSER_HEADERS,
            follow_redirects=True,
            max_redirects=10,
            timeout=httpx.Timeout(
                connect=connect_budget,
                read=read_budget,
                write=connect_budget,
                pool=5.0,
            ),
        ) as client:
            with client.stream("GET", url) as response:
                status = response.status_code
                final_url = str(response.url)
                content_type = response.headers.get("content-type", "")
                # iter_bytes yields content-decoded bytes (gzip/br already
                # decompressed), so the byte count below reflects what the
                # caller will actually see. Read max_bytes + 1 so the caller
                # can distinguish "page is exactly max_bytes" from "page is
                # larger, truncated"; iterate-and-break avoids buffering
                # gigabyte responses from hostile / misconfigured servers.
                buf = bytearray()
                for chunk in response.iter_bytes(chunk_size=64 * 1024):
                    buf.extend(chunk)
                    if len(buf) > max_bytes:
                        break
                data = bytes(buf[: max_bytes + 1])
    except httpx.TooManyRedirects as exc:
        print(f"fetch failed: too many redirects: {exc}", file=sys.stderr)
        return 1
    except httpx.ConnectTimeout as exc:
        print(
            f"fetch failed: connect timeout after {connect_budget}s: {exc}",
            file=sys.stderr,
        )
        return 1
    except httpx.ReadTimeout as exc:
        print(
            f"fetch failed: read timeout after {read_budget}s: {exc}",
            file=sys.stderr,
        )
        return 1
    except httpx.RequestError as exc:
        # Catches ConnectError / ReadError / ProtocolError / ProxyError /
        # UnsupportedProtocol / WriteTimeout / PoolTimeout / DecodingError /
        # InvalidURL after the more specific timeouts above. Type name is
        # included so admin grep can tell apart "ConnectError" (network /
        # DNS / TLS) from "RemoteProtocolError" (server hung up mid-stream).
        print(f"fetch failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"unexpected: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    truncated = len(data) > max_bytes
    if truncated:
        data = data[:max_bytes]

    content_type_lower = content_type.lower()

    if not is_text_content_type(content_type_lower):
        # Binary path: persist raw bytes to download_dir, report the path on
        # stdout. Truncated downloads still get persisted so partial-binary
        # cases don't silently disappear; the header line flags it.
        if not download_dir:
            print(
                f"binary content type {content_type!r} but no download_dir configured",
                file=sys.stderr,
            )
            return 1
        try:
            os.makedirs(download_dir, exist_ok=True)
        except OSError as exc:
            print(f"failed to create download_dir {download_dir}: {exc}", file=sys.stderr)
            return 1
        filename = derive_filename(final_url, content_type_lower)
        filepath = os.path.join(download_dir, filename)
        try:
            with open(filepath, "wb") as fh:
                fh.write(data)
        except OSError as exc:
            print(f"failed to write {filepath}: {exc}", file=sys.stderr)
            return 1
        size = len(data)
        header = [
            f"URL: {final_url}",
            f"Status: {status}",
            f"Content-Type: {content_type or 'unknown'}",
            f"Bytes: {size}" + (" (truncated)" if truncated else ""),
            "",
        ]
        body = (
            f"[Binary content ({content_type or 'unknown'}, {format_size(size)})"
            f"{' (truncated)' if truncated else ''} saved to {filepath}]"
        )
        sys.stdout.write("\n".join(header) + body + "\n")
        return 0

    # Text path: same behavior as before — decode utf-8 and route by sub-shape.
    text = data.decode("utf-8", errors="replace")

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
    else:
        # Plain text, markdown, javascript, form-encoded, or unknown header.
        body = text.strip()

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
