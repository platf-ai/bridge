FROM oven/bun:1 AS base
WORKDIR /app

# Install Node.js so npx-based MCP servers work inside the container
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

EXPOSE 8000

ENTRYPOINT ["bun", "run", "src/index.ts"]
