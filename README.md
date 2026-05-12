# Second Brain — MCP Server on Cloudflare Workers (Multilingual Fork)

> Forked from [rahilp/second-brain-cloudflare](https://github.com/rahilp/second-brain-cloudflare)

**Key modification: Switched embedding model from `bge-small-en-v1.5` (English-only, 384-dim) to `bge-m3` (100+ languages including Vietnamese, 1024-dim) for multilingual semantic search.**

---

## What changed from upstream

| Component | Original | This Fork |
|---|---|---|
| Embedding Model | `@cf/baai/bge-small-en-v1.5` | `@cf/baai/bge-m3` |
| Vector Dimensions | 384 | 1024 |
| Language Support | English only | 100+ languages (incl. Vietnamese) |
| MCP Server Version | 1.0.0 | 1.1.0 |

## Quick Setup

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)

### Steps
```bash
# 1. Clone and install
git clone https://github.com/chithanh85/second-brain-cloudflare.git
cd second-brain-cloudflare
npm install

# 2. Authenticate with Cloudflare
npx wrangler login

# 3. Create the D1 database
npm run db:create
# Copy the database_id output and paste it into wrangler.toml → [[d1_databases]] → database_id

# 4. Create the Vectorize index (1024 dimensions for bge-m3)
npm run vectors:create

# 5. Run the schema migration
npm run db:migrate:remote

# 6. Set your auth token
openssl rand -base64 32
npx wrangler secret put AUTH_TOKEN

# 7. Deploy
npm run deploy
```

## MCP Tools

| Tool | Parameters | Description |
|---|---|---|
| `remember` | `content`, `tags?`, `source?` | Store a note (with duplicate detection) |
| `append` | `id`, `addition` | Append update to existing entry |
| `recall` | `query`, `topK?`, `tag?` | Semantic vector search (multilingual) |
| `list_recent` | `n?`, `tag?` | Chronological listing |
| `forget` | `id` | Delete entry + all chunks |

## Connect to AI Clients

### Antigravity / Claude Desktop
Add to your MCP server config:
```json
{
  "mcpServers": {
    "second-brain": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your-worker-url>/mcp"]
    }
  }
}
```

### Test via curl
```bash
curl -X POST https://<your-worker-url>/capture \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "test note in Vietnamese: Đây là ghi chú thử nghiệm", "tags": ["test"], "source": "api"}'
```

## Stack
| Service | Role |
|---|---|
| Cloudflare Workers | Serverless runtime |
| Cloudflare D1 | SQLite database |
| Cloudflare Vectorize | Vector index (1024-dim, cosine) |
| Workers AI (bge-m3) | Multilingual text embeddings |
| MCP TypeScript SDK | Model Context Protocol server |

All free tier at personal scale.

## License
[MIT](LICENSE)
