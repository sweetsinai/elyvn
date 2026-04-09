# =============================================================================
# Stage 1: Builder — install all dependencies and build dashboard
# =============================================================================
FROM node:20-slim AS builder

WORKDIR /app

# Install build tools for native modules (better-sqlite3 needs python3 + build-essential)
RUN apt-get update && \
    apt-get install -y python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

# Install bridge dependencies (includes better-sqlite3 native build)
COPY server/bridge/package*.json server/bridge/
RUN cd server/bridge && npm ci

# Install dashboard dependencies
COPY dashboard/package*.json dashboard/
RUN cd dashboard && npm ci

# Copy source
COPY server/ ./server/
COPY dashboard/ ./dashboard/

# Build dashboard into server/bridge/public/
RUN cd dashboard && npx vite build

# Prune dev dependencies from bridge after build
RUN cd server/bridge && npm prune --production

# =============================================================================
# Stage 2: Runtime — minimal production image
# =============================================================================
FROM node:20-slim AS runtime

# Install dumb-init for proper signal handling and process reaping
RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init python3 && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN addgroup --system app && adduser --system --ingroup app app

WORKDIR /app

# Copy production node_modules (already pruned in builder)
COPY --from=builder /app/server/bridge/node_modules ./server/bridge/node_modules

# Copy server source (bridge + built dashboard assets in server/bridge/public/)
COPY --from=builder /app/server/bridge/ ./server/bridge/

# Copy root package.json for metadata only
COPY package*.json ./

# Set proper ownership
RUN chown -R app:app /app

USER app

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=15s --retries=5 \
  CMD node -e "const p=process.env.PORT||3001;fetch('http://localhost:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/bridge/index.js"]
