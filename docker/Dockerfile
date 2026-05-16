FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code --no-fund --no-audit \
    && rm -f /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-fund --no-audit
COPY bridge.js ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -sf http://localhost:3000/health || exit 1

CMD ["node", "bridge.js"]
