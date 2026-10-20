FROM node:22-bookworm-slim

# git for cloning/pushing, plus whatever toolchains your repos need to build and test.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 python3-pip python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/*
# Add more toolchains here, e.g. Go:
# COPY --from=golang:1.23 /usr/local/go /usr/local/go
# ENV PATH="/usr/local/go/bin:${PATH}"

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV DATA_DIR=/data COMPANIES_FILE=/app/companies.yaml
CMD ["node", "dist/index.js"]
