# NanoClaw Agent Container
# Dual runner: OpenAI (default) with Claude SDK fallback
# Runner selected via RUNNER env var: "openai" (default) or "claude"

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    jq \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — needed by routeaware-implementer-exec for PR creation.
# Installed via the official GitHub apt repo so we track upstream cleanly.
RUN install -d -m 0755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and MCP tools globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @playwright/mcp@latest hylo-mcp

# ── Claude SDK Runner (at /app/claude-runner) ────────────────────
WORKDIR /app/claude-runner
COPY agent-runner/package*.json ./
RUN npm install
COPY agent-runner/ ./
RUN npm run build

# ── OpenAI Runner (at /app/openai-runner) ────────────────────────
WORKDIR /app/openai-runner
COPY openai-runner/package*.json ./
RUN npm install --legacy-peer-deps
COPY openai-runner/ ./
RUN npm run build

# Install bridge-call script (GHL API wrapper)
COPY bridge-call.sh /usr/local/bin/bridge-call
RUN chmod +x /usr/local/bin/bridge-call

# Install ai-news-mcp dependencies compiled for container's Node version.
COPY ai-news-mcp-deps/package.json /opt/ai-news-mcp/package.json
RUN apt-get update && apt-get install -y --no-install-recommends make g++ python3 && \
    cd /opt/ai-news-mcp && npm install --omit=dev && \
    apt-get purge -y make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Python test toolchain (persisted, not purged) for hylo-pr-drafts: it clones
# dasonshi/hylo, creates a venv, `pip install`s the repo's requirements + pytest,
# then writes/runs a regression test before drafting a PR. Without pip + venv the
# whole reproduce-then-fix loop can't run.
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint that selects runner based on RUNNER env var
RUN printf '#!/bin/bash\nset -e\nRUNNER="${RUNNER:-openai}"\nif [ "$RUNNER" = "claude" ]; then\n  RUNNER_DIR=/app/claude-runner\nelse\n  RUNNER_DIR=/app/openai-runner\nfi\ncd "$RUNNER_DIR" && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s "$RUNNER_DIR/node_modules" /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Default to OpenAI runner
ENV RUNNER=openai

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
