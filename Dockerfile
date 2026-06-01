# syntax=docker/dockerfile:1.7
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1

# Layer 1: shell core, search, VCS, Python interpreter, build tooling
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils sed gawk grep \
      ripgrep git curl ca-certificates \
      sudo \
      python3 python3-pip \
      poppler-utils \
      build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Layer 2: AI-researcher daily-driver CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
      jq \
      wget unzip zip xz-utils \
      vim-tiny less \
      dnsutils iputils-ping netcat-openbsd \
      sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# yq is a single Go binary; pin release for reproducibility
ARG YQ_VERSION=4.44.3
RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in \
         amd64) YQ_ARCH=amd64 ;; \
         arm64) YQ_ARCH=arm64 ;; \
         *) echo "unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${YQ_ARCH}" \
         -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq

# Layer 3: Python data-science baseline
RUN python3 -m pip install --break-system-packages --no-cache-dir \
      "numpy==2.*" "pandas==2.*" "scipy==1.*" "matplotlib==3.*" \
      tqdm pyarrow jsonlines \
      requests pyyaml python-dotenv \
      "Pillow>=10,<12" \
      "openpyxl>=3.1,<4" \
      "python-docx>=1.1,<2" \
      "python-pptx>=1.0,<2"

# Brain++ is an internal package. Build with BuildKit and pass the internal
# pip config as a secret, for example:
#   DOCKER_BUILDKIT=1 docker build --secret id=pip_conf,src=/etc/pip.conf -t lightclaw-sandbox:brainpp .
RUN --mount=type=secret,id=pip_conf,target=/etc/pip.conf,required=false \
    python3 -m pip install --break-system-packages --no-cache-dir brainpp

# rjob expects the kubebrain ssh environment to be initialized from the
# container's process-1 environment. This script is intentionally generic:
# deployment-specific KUBEBRAIN_* values are injected through docker env.
RUN cat > /etc/profile.d/ssh-init.sh <<'EOF' \
    && chmod 0644 /etc/profile.d/ssh-init.sh
#!/usr/bin/env bash
# import environment from process 1
# shellcheck disable=SC1090
if [ "$(id -u)" = "0" ]; then
  _lightclaw_strings_cmd="strings"
else
  _lightclaw_strings_cmd="sudo strings"
fi
. <(echo "export $($_lightclaw_strings_cmd /proc/1/environ | grep -v HOME | grep -v LS_COLORS | grep -v TERM | tr '\n' ' ')")
unset _lightclaw_strings_cmd
EOF

# Layer 4: Node 22 LTS + pnpm 10 (covers lightclaw self-debug and Node-flavored
# user scripts; tarball install avoids nvm rc-file overhead and apt repo coupling)
ARG NODE_VERSION=22.11.0
RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in \
         amd64) NODE_ARCH=x64 ;; \
         arm64) NODE_ARCH=arm64 ;; \
         *) echo "unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
         | tar -xJ -C /opt \
    && NODE_BIN="/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin" \
    && ln -s "${NODE_BIN}/node" /usr/local/bin/node \
    && ln -s "${NODE_BIN}/npm" /usr/local/bin/npm \
    && ln -s "${NODE_BIN}/npx" /usr/local/bin/npx \
    && npm install -g pnpm@10 \
    && ln -s "${NODE_BIN}/pnpm" /usr/local/bin/pnpm \
    && ln -s "${NODE_BIN}/pnpx" /usr/local/bin/pnpx \
    && npm cache clean --force

# Build-time smoke: fail the build if any expected tool is missing
RUN jq --version && yq --version \
    && pdftotext -v 2>&1 | head -1 \
    && pdftoppm -v 2>&1 | head -1 \
    && python3 -c "import numpy, pandas, scipy, matplotlib, requests, yaml, tqdm, pyarrow, jsonlines, dotenv, openpyxl, docx, pptx, PIL" \
    && command -v rjob \
    && node --version && pnpm --version \
    && rg --version | head -1

WORKDIR /workspace
CMD ["sleep", "infinity"]
