FROM node:22-bookworm-slim

# git for cloning/pushing, plus whatever toolchains your repos need to build and test.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 python3-pip python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/*
# Add more toolchains here, e.g. Go:
# COPY --from=golang:1.23 /usr/local/go /usr/local/go
# ENV PATH="/usr/local/go/bin:${PATH}"

# Claude Code CLI, pinned. The bot runs `claude -p` for triage and coding. Auth comes from .env at
# runtime (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) and is never baked into the image.
RUN npm install -g @anthropic-ai/claude-code@2.1.222

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# The CLI keeps its state in ~/.claude, so the non-root user's HOME must be writable.
RUN mkdir -p /data /home/node/.claude && chown -R node:node /data /app /home/node
USER node
ENV HOME=/home/node DATA_DIR=/data COMPANIES_FILE=/app/companies.yaml
CMD ["node", "dist/index.js"]
