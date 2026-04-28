# Sandbox Helpers

Helper scripts that run inside the environment runtime.

- `webfetch.py` fetches a URL and converts HTML to Markdown.
- `websearch.py` calls a configured search API, or falls back to DuckDuckGo HTML search.
- `glob.py` expands glob patterns inside DockerRuntime without adding Node.js to the sandbox image.

LocalRuntime invokes these with host `python3`. `webfetch.py` requires:

```bash
python3 -m pip install --user markdownify
```

DockerRuntime should copy this directory into the sandbox image at
`/opt/lightclaw/sandbox-helpers/`.
