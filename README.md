# 🧠 Second Brain v2.0 — AI Memory trên Cloudflare Workers

> Fork từ [rahilp/second-brain-cloudflare](https://github.com/rahilp/second-brain-cloudflare) — đã tối ưu cho **tiếng Việt** và hướng dẫn tích hợp với **Antigravity** + **Codex**.

## Thay đổi so với bản gốc

| Thành phần | Bản gốc | Fork này |
|---|---|---|
| Embedding Model | `@cf/baai/bge-small-en-v1.5` | **`@cf/qwen/qwen3-embedding-0.6b`** |
| Vector Dimensions | 384 | 1024 |
| Context Window | 512 tokens | **32K tokens** |
| Ngôn ngữ | Chỉ English | **100+ ngôn ngữ** (bao gồm tiếng Việt) |
| Instruction-aware | ❌ | ✅ |
| Memory Graph | ❌ | ✅ Auto-link + Multi-hop recall |
| Graceful Degradation | ❌ | ✅ SQL keyword fallback |
| Advanced Recall | Basic | ✅ MMR, Recency weighting, Similarity cutoff |
| Phiên bản | 1.0.0 | **2.0.0** |

---

## What's new in v2.0

### 🕸️ Memory Graph
Memories tự động liên kết với nhau thành đồ thị tri thức. Khi lưu entry mới, hệ thống tìm các entries tương tự (>60% similarity) và tạo edges tự động. Khi gọi `recall`, tham số `hops` cho phép AI đi theo các liên kết để khám phá thông tin liên quan mà semantic search thuần không tìm thấy.

### 🛡️ Graceful Degradation
Nếu Cloudflare Vectorize bận hoặc lỗi, hệ thống tự động fallback về tìm kiếm từ khóa SQL trên D1. Endpoint `/health` (không cần auth) để monitoring.

### 🎚️ Advanced Recall Controls
- **Recency Weighting**: Cân bằng giữa semantic relevance và thời gian (`recency_weight`)
- **MMR Diversity**: Đa dạng hóa kết quả, tránh trùng lặp (`diversity`)
- **Similarity Cutoff**: Lọc bỏ kết quả có điểm thấp (`min_score`)

---

## Kiến trúc

```
AI Client (Antigravity/Codex/Claude)
    │
    ▼ MCP Protocol (HTTP + SSE)
┌─────────────────────────────────────┐
│   Cloudflare Worker (second-brain)  │
│   ├── /mcp    → MCP Server (7 tools)│
│   ├── /capture → REST API          │
│   ├── /list   → REST API           │
│   └── /health → Health Check       │
├─────────────────────────────────────┤
│   Workers AI (qwen3-embedding)     │ ← Tạo embedding vector
│   Cloudflare D1 (SQLite)           │ ← entries + edges (graph)
│   Cloudflare Vectorize (1024-dim)  │ ← Semantic search
│   ┌─ Graceful Degradation ────┐    │
│   │  Vectorize lỗi → SQL LIKE │    │
│   └───────────────────────────┘    │
└─────────────────────────────────────┘
```

**Toàn bộ chạy trên Cloudflare free tier.** Không cần server riêng, không lo downtime.

---

## Cài đặt & Deploy

### Yêu cầu
- Node.js 18+
- Tài khoản Cloudflare (free tier đủ dùng)

### Các bước

```bash
# 1. Clone repo
git clone https://github.com/chithanh85/second-brain-cloudflare.git
cd second-brain-cloudflare
npm install

# 2. Đăng nhập Cloudflare
npx wrangler login

# 3. Tạo database D1
npm run db:create
# → Copy database_id từ output, paste vào wrangler.toml → [[d1_databases]] → database_id

# 4. Tạo Vectorize index (1024 dimensions cho qwen3-embedding)
npm run vectors:create

# 5. Migrate schema lên remote (bao gồm bảng edges cho Memory Graph)
npm run db:migrate:remote

# 6. Đặt token bảo mật
"your-secret-token-here" | npx wrangler secret put AUTH_TOKEN

# 7. Deploy
npm run deploy
```

Sau khi deploy thành công, bạn sẽ nhận được URL dạng:
```
https://second-brain.<your-subdomain>.workers.dev
```

---

## Tích hợp với AI Client

### Antigravity (VS Code)

Mở file `~/.gemini/antigravity/mcp_config.json` và thêm:

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://second-brain.<your-subdomain>.workers.dev/mcp",
        "--header",
        "Authorization:Bearer <your-auth-token>"
      ]
    }
  }
}
```

Restart Antigravity để áp dụng. Sau đó AI sẽ tự động có thêm 7 tools:
- `remember` — Lưu ghi chú (auto-link với entries tương tự)
- `recall` — Tìm kiếm ngữ nghĩa (hỗ trợ multi-hop, MMR, recency)
- `append` — Cập nhật ghi chú đã có
- `list_recent` — Liệt kê gần nhất
- `forget` — Xóa ghi chú (cascade delete edges)
- `link` — Tạo liên kết thủ công giữa 2 entries
- `connections` — Xem danh sách liên kết của entry

### Codex (OpenAI CLI)

Mở file `~/.codex/config.toml` và thêm:

```toml
[mcp_servers.second-brain]
command = "npx"
args = [
  "-y",
  "mcp-remote",
  "https://second-brain.<your-subdomain>.workers.dev/mcp",
  "--header",
  "Authorization:Bearer <your-auth-token>"
]
```

Restart Codex để áp dụng.

### Claude Desktop

Mở file `claude_desktop_config.json` và thêm:

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://second-brain.<your-subdomain>.workers.dev/mcp",
        "--header",
        "Authorization:Bearer <your-auth-token>"
      ]
    }
  }
}
```

---

## Sử dụng

### Qua MCP (AI tự động gọi)

Khi đã config xong, AI sẽ tự động sử dụng các tools. Ví dụ:

- Bạn nói: *"Nhớ giúp tôi: API backend dùng port 3000"*
  → AI gọi `remember` lưu lại → tự động link đến entries liên quan (nếu có)

- Bạn hỏi: *"Backend dùng port mấy?"*
  → AI gọi `recall` tìm và trả lời

- Bạn nói: *"Tìm tất cả quyết định liên quan đến kiến trúc"*
  → AI gọi `recall` với `hops=1` để mở rộng kết quả qua đồ thị

- Bạn nói: *"Liên kết ghi chú A với ghi chú B"*
  → AI gọi `link` tạo edge giữa 2 entries

- Bạn nói: *"Ghi chú X liên quan đến những gì?"*
  → AI gọi `connections` để xem đồ thị

### Qua REST API (tích hợp script/CI)

```bash
# Lưu ghi chú
curl -X POST https://second-brain.<subdomain>.workers.dev/capture \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Nội dung ghi chú", "tags": ["tag1"], "source": "api"}'

# Liệt kê
curl https://second-brain.<subdomain>.workers.dev/list?n=10 \
  -H "Authorization: Bearer <token>"

# Health check (không cần auth)
curl https://second-brain.<subdomain>.workers.dev/health
```

---

## MCP Tools chi tiết

| Tool | Tham số | Mô tả |
|---|---|---|
| `remember` | `content` (bắt buộc), `tags?`, `source?` | Lưu ghi chú mới. Tự phát hiện trùng lặp (>95% block, >85% cảnh báo). **Auto-link** với entries tương tự (>60%) |
| `recall` | `query` (bắt buộc), `topK?` (5), `tag?`, `hops?` (0), `recency_weight?` (0.3), `diversity?` (0), `min_score?` (0) | Tìm kiếm ngữ nghĩa. Hỗ trợ multi-hop graph traversal, MMR diversity, recency weighting, similarity cutoff |
| `append` | `id` (bắt buộc), `addition` (bắt buộc) | Thêm thông tin vào entry đã có, giữ nguyên nội dung cũ + timestamp update |
| `list_recent` | `n?` (10), `tag?` | Liệt kê entries theo thời gian, có thể lọc theo tag |
| `forget` | `id` (bắt buộc) | Xóa entry, vectors, và tất cả graph edges liên quan |
| `link` | `source_id`, `target_id`, `relation?` ("related") | Tạo liên kết thủ công giữa 2 entries. Relations: `related`, `extends`, `contradicts`, `depends_on` |
| `connections` | `id` (bắt buộc), `depth?` (1, max 3) | Xem danh sách entries liên kết trong đồ thị tri thức |

### Recall Parameters chi tiết

| Tham số | Type | Default | Mô tả |
|---|---|---|---|
| `hops` | int | 0 | Số tầng duyệt đồ thị (0 = chỉ semantic, 1-3 = mở rộng qua connections) |
| `recency_weight` | float | 0.3 | Trọng số thời gian (0 = pure semantic, 1 = chỉ ưu tiên mới) |
| `diversity` | float | 0 | MMR diversity (0 = tắt, 0.3-0.5 = cân bằng, 1 = max đa dạng) |
| `min_score` | float | 0 | Ngưỡng similarity tối thiểu (0 = không lọc) |

---

## Tại sao dùng Qwen3-Embedding?

`qwen3-embedding-0.6b` được chọn sau khi benchmark với `bge-m3` vì:

1. **MTEB score cao hơn ~7-8%** — Semantic search chính xác hơn
2. **32K context window** — Ghi chú dài không bị cắt (bge-m3 chỉ 8K)
3. **Instruction-aware** — Có thể thêm task-specific prompt để tăng chất lượng
4. **Matryoshka Representation Learning (MRL)** — Linh hoạt dimensions (32–1024)
5. **100+ ngôn ngữ** — Tiếng Việt, tiếng Anh, tiếng Nhật, tiếng Hàn...
6. **Cùng giá với bge-m3** — $0.012/1M tokens, 1,075 neurons/1M tokens

### So sánh các model Cloudflare Workers AI

| Model | Dimensions | Context | Ngôn ngữ | Ghi chú |
|---|---|---|---|---|
| `bge-small-en-v1.5` | 384 | 512 | English only | Mặc định bản gốc |
| `bge-m3` | 1024 | 8K | 100+ ngôn ngữ | Rất tốt, battle-tested |
| **`qwen3-embedding-0.6b`** | 32–1024 | **32K** | **100+ ngôn ngữ** | ⭐ **Dùng trong fork này** |
| `embeddinggemma-300m` | — | — | 100+ ngôn ngữ | Google Gemma |

---

## Health Check & Monitoring

Endpoint `/health` (không yêu cầu auth) trả về trạng thái hệ thống:

```json
{
  "status": "healthy",
  "version": "2.0.0",
  "timestamp": "2026-08-12T10:00:00.000Z",
  "database": { "ok": true, "entries_count": 42 },
  "graph": { "ok": true, "edges_count": 15 },
  "vectorize": { "ok": true }
}
```

Trạng thái:
- `healthy` — D1 + Vectorize đều hoạt động
- `degraded` — D1 OK nhưng Vectorize lỗi (auto-fallback keyword search)
- `error` — D1 cũng lỗi

---

## Test local (trước khi deploy)

```bash
# Tạo file .dev.vars với nội dung:
# AUTH_TOKEN=test-token-local

# Migrate schema local (bao gồm bảng edges)
npm run db:migrate

# Chạy dev server (cần Cloudflare auth vì AI + Vectorize chạy remote)
npx wrangler dev --experimental-vectorize-bind-to-prod

# Test health
curl http://127.0.0.1:8787/health

# Test capture
Invoke-RestMethod -Uri "http://127.0.0.1:8787/capture" `
  -Method POST `
  -Headers @{"Authorization"="Bearer test-token-local"; "Content-Type"="application/json"} `
  -Body '{"content": "Test tieng Viet", "tags": ["test"], "source": "api"}'
```

---

## Stack

| Service | Vai trò | Chi phí |
|---|---|---|
| Cloudflare Workers | Runtime serverless | Free (100k req/ngày) |
| Cloudflare D1 | SQLite database (entries + edges) | Free (5GB) |
| Cloudflare Vectorize | Vector search index | Free (30M vector dimensions) |
| Workers AI (qwen3-embedding) | Text → Embedding | Free (10k neurons/ngày) |
| MCP TypeScript SDK | Giao thức MCP | Open source |

---

## License

[MIT](LICENSE)
