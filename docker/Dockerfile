FROM node:20-alpine

RUN apk add --no-cache git curl ca-certificates

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code --no-fund --no-audit

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-fund --no-audit
COPY bridge.js ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "bridge.js"]
