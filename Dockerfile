# syntax=docker/dockerfile:1.7
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils sed gawk grep \
      ripgrep git curl ca-certificates \
      python3 python3-pip \
      build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

RUN python3 -m pip install --break-system-packages --no-cache-dir markdownify==1.2.2

COPY scripts/sandbox-helpers /opt/lightclaw/sandbox-helpers
RUN chmod +x /opt/lightclaw/sandbox-helpers/*.py

WORKDIR /workspace
CMD ["sleep", "infinity"]
