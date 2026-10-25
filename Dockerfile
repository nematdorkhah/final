# ==============================================================================
# Stage 1: Build Application (Frontend Vite bundle + Backend Server)
# ==============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy application sources
COPY . .

# Build Vite client SPA and bundle server to dist/server.js
RUN npm run build

# Prune development dependencies to keep production footprint minimal
RUN npm prune --omit=dev

# ==============================================================================
# Stage 2: Production Runner
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Copy package manifests for scripts
COPY --from=builder /app/package*.json ./

# Copy production dependencies
COPY --from=builder /app/node_modules ./node_modules

# Copy built production assets (dist/index.html, dist/assets, dist/server.js)
COPY --from=builder /app/dist ./dist

# Create data directory if needed for runtime storage and assign node ownership
RUN mkdir -p /app/data && chown -R node:node /app

# Use non-root node user for security
USER node

# Expose standard cloud container port
EXPOSE 8080

# Start server
CMD ["npm", "start"]
