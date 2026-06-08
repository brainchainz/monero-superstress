FROM node:18-alpine AS builder

# better-sqlite3 requires build tools for native addon compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files and install ALL dependencies (need devDeps for build)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and build React frontend
COPY . .
ARG CACHEBUST=4
RUN npm run build

# --- Production stage (smaller image) ---
FROM node:18-alpine

# better-sqlite3 native addon needs libstdc++
RUN apk add --no-cache tini libstdc++

WORKDIR /app

# Install production dependencies only (better-sqlite3 needs build tools here too)
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev --ignore-scripts \
    && npm rebuild better-sqlite3 \
    && apk del .build-deps \
    && npm cache clean --force

# Copy built React app from builder
COPY --from=builder /app/build ./build
ARG CACHEBUST=5

# Copy backend files
COPY server.js ./
COPY spammer-module.js ./

# Monitor data directory
RUN mkdir -p /data

EXPOSE 4050

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
