# platf-mcp-bridge

Stdio-to-Streamable HTTP bridge for MCP servers — part of the Platf AI Hub.

Wraps any MCP server that speaks JSON-RPC over **stdio** and exposes it as a **Streamable HTTP** (`/mcp`) endpoint. Built with [Bun](https://bun.sh).

## Modes

| Flag | Mode | Description |
|------|------|-------------|
| _(default)_ | **Stateless** | Spawns a fresh child process per request. Auto-initializes if the incoming message isn't an `initialize` request. |
| `--stateful` | **Stateful** | One child process per session (`Mcp-Session-Id` header). Optional inactivity timeout via `--sessionTimeout`. |

## Authentication

The bridge supports OAuth 2.0 JWT authentication via `--authIssuer` and `--authClientId`.
- Validates **Bearer tokens** (signature + expiration checks against issuer's JWKS).
- Exposes standard discovery endpoints:
  - `/.well-known/oauth-protected-resource` (RFC 9728)
  - `/.well-known/oauth-authorization-server` (RFC 8414 proxy)
- Rejects unauthenticated requests to `/mcp` with `401 Unauthorized` and `WWW-Authenticate` header.

## Usage

```bash
# Using bunx (Stateless default)
bunx @platf/bridge --stdio "npx -y @modelcontextprotocol/server-everything" --port 8000 --cors '*' --healthEndpoint /healthz

# With Authentication enabled
bunx @platf/bridge \
  --stdio "npx -y @modelcontextprotocol/server-everything" \
  --authIssuer https://auth.platf.ai \
  --authClientId mcp-bridge-client

# Using npx (Stateful with 10 min session timeout)
npx @platf/bridge --stdio "npx -y @modelcontextprotocol/server-everything" --stateful --sessionTimeout 600000 --cors '*'
```

## Docker

You can use the pre-built image from GitHub Container Registry:

```bash
docker run -p 8000:8000 ghcr.io/platf-ai/bridge:latest \
  --stdio "npx -y @modelcontextprotocol/server-everything" \
  --cors '*' --healthEndpoint /healthz
```

Or build locally:

```bash
docker build -t platf-mcp-bridge .

docker run -p 8000:8000 platf-mcp-bridge \
  --stdio "npx -y @modelcontextprotocol/server-everything" \
  --cors '*' --healthEndpoint /healthz
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--stdio` | _(required)_ | Shell command for the stdio MCP server |
| `--port` | `8000` | HTTP listen port |
| `--path` | `/mcp` | HTTP endpoint path |
| `--stateful` | `false` | Enable stateful session mode |
| `--sessionTimeout` | — | Inactivity timeout (ms), stateful only |
| `--protocolVersion` | `2025-03-26` | MCP protocol version for auto-init |
| `--logLevel` | `info` | `none` / `info` / `debug` |
| `--cors` | — | CORS origins (omit=disabled, `*`=all) |
| `--healthEndpoint` | — | Health-check path(s) returning 200 |
| `--header` | — | Extra response headers (`Key: Value`) |
| `--authIssuer` | — | OAuth 2.0 issuer URL (enables auth) |
| `--authClientId` | — | OAuth client ID (required if issuer set) |

This project was created using `bun init` in bun v1.3.7. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
