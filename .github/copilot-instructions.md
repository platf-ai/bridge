# platf-mcp-bridge — Copilot Instructions

## Project Overview

**platf-mcp-bridge** is a stdio-to-Streamable HTTP bridge for MCP (Model Context Protocol) servers. It wraps any MCP server that speaks JSON-RPC over stdio and exposes it as a Streamable HTTP (`/mcp`) endpoint.

- **Runtime**: Bun v1.3.7
- **Language**: TypeScript (strict mode, NodeNext module resolution)
- **Build**: `tsc` + `tsc-alias` for `@/` path resolution
- **Package**: Published as `@platf/bridge` to npm and GitHub Container Registry

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        platf-mcp-bridge                         │
├─────────────────────────────────────────────────────────────────┤
│  Express Server                                                 │
│  ├─ GET  /.well-known/oauth-protected-resource (RFC 9728)       │
│  ├─ GET  /.well-known/oauth-authorization-server (RFC 8414)     │
│  ├─ POST /oauth/register (DCR proxy to issuer)                  │
│  └─ POST /mcp (MCP endpoint, auth required if configured)       │
├─────────────────────────────────────────────────────────────────┤
│  Gateways                                                       │
│  ├─ statelessBridge.ts — One process per request                │
│  └─ statefulBridge.ts  — Session-based (Mcp-Session-Id header) │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point, yargs argument parsing |
| `src/lib/express.ts` | Shared Express app factory |
| `src/lib/authMiddleware.ts` | JWT Bearer token validation via jose |
| `src/lib/discoveryRoutes.ts` | RFC 9728/8414 OAuth discovery endpoints |
| `src/gateways/statelessBridge.ts` | Stateless mode: fresh process per request |
| `src/gateways/statefulBridge.ts` | Stateful mode: session-based process pool |
| `src/types.ts` | Shared type definitions |

## OAuth 2.0 Integration

When `--authIssuer` and `--authClientId` are provided:

1. **Protected Resource Metadata** (RFC 9728): Advertises at `/.well-known/oauth-protected-resource`
2. **Authorization Server Metadata** (RFC 8414): Proxied from issuer at `/.well-known/oauth-authorization-server`
3. **Dynamic Client Registration** (RFC 7591): Proxied to issuer at `/oauth/register`
4. **JWT Validation**: Bearer tokens validated against issuer's JWKS
5. **Audience Validation** (RFC 9068): Validates `aud` claim matches bridge URL

### Owner Restriction Flow

Owner-based access control is enforced by **platf-auth** (not the bridge):

1. MCP server deployed with `enableAuth: true` → platf-runner sets `ownerId` to deployer's user ID
2. OAuth client registered with `ownerId` restriction
3. VS Code dynamically registers new client via DCR with `resource` parameter
4. platf-auth extracts `ownerId` from resource URL and enforces access restriction
5. Non-owners receive `ACCESS_DENIED` error during OAuth callback

### Audience Validation (RFC 9068)

The bridge validates the `aud` (audience) claim:
- If `aud` is a URL, it must match the bridge's resource URL (`https://{host}/mcp`)
- If `aud` is a client ID (non-URL), it's accepted for backward compatibility
- Mismatched audience → 401 Unauthorized

## Coding Conventions

- Use `@/` path alias for imports (resolved by `tsc-alias`)
- Prefer `async/await` over callbacks
- Use `Logger` object for structured logging
- Keep functions small and focused
- Add JSDoc comments for public APIs
- TypeScript strict mode enabled

## Build & Test

```bash
# Install dependencies
bun install

# Type check
bun run tsc --noEmit

# Build (outputs to dist/)
bun run build

# Run locally in stateful mode
bun run src/index.ts --stdio "npx -y @modelcontextprotocol/server-everything" --port 8000 --stateful --cors '*'

# With OAuth enabled
bun run src/index.ts \
  --stdio "npx -y @modelcontextprotocol/server-everything" \
  --authIssuer https://app.platf.ai/oauth \
  --authClientId my-client-id \
  --stateful
```

## Docker Variants

| Dockerfile | Base | Use Case |
|------------|------|----------|
| `docker/Dockerfile` | Node.js Alpine | `npx`-based MCP servers |
| `docker/Dockerfile.uvx` | Python + Node | `uvx`-based MCP servers |

## CI/CD

- **GitHub Actions**: `.github/workflows/release.yml`
  - Triggers on push to `main`
  - Builds TypeScript, commits `dist/`, publishes to npm
  - Builds and pushes Docker images to GHCR

## Related Projects

- **platf-auth**: OAuth 2.0 authorization server (enforces ownerId restriction)
- **platf-runner**: Kubernetes operator for MCP server deployments
- **platf-frontend**: Web UI for managing MCP servers
