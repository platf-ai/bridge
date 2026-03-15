FROM oven/bun:1 AS base
WORKDIR /app

ARG VERSION=dev
ENV PLATF_BRIDGE_VERSION=$VERSION

# Create npx → bunx wrapper so npx-based MCP servers work with Bun
# See: https://htdocs.dev/posts/replacing-npx-with-bunx-a-simple-workaround/
RUN echo '#!/bin/sh\nexec bunx "$@"' > /usr/local/bin/npx && chmod +x /usr/local/bin/npx

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

EXPOSE 8000

ENTRYPOINT ["bunx", "@platf/bridge"]
