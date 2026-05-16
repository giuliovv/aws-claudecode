FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY bridge.js ./

# EFS mount point — provision script creates per-user access point here
RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "bridge.js"]
