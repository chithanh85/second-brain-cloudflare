# 🧠 Second Brain — AI Memory trên Cloudflare Workers

> Fork từ [rahilp/second-brain-cloudflare](https://github.com/rahilp/second-brain-cloudflare) — đã tối ưu cho **tiếng Việt** và hướng dẫn tích hợp với **Antigravity** + **Codex**.

## Thay đổi so với bản gốc

| Thành phần | Bản gốc | Fork này |
|---|---|---|
| Embedding Model | `@cf/baai/bge-small-en-v1.5` | `@cf/baai/bge-m3` |
| Vector Dimensions | 384 | 1024 |
| Ngôn ngữ | Chỉ English | **100+ ngôn ngữ** (bao gồm tiếng Việt) |
| Phiên bản MCP | 1.0.0 | 1.1.0 |

---

## Kiến trúc

```
AI Client (Antigravity/Codex/Claude)
    │
    ▼ MCP Protocol (HTTP + SSE)
┌─────────────────────────────────────┐
│   Cloudflare Worker (second-brain)  │
│   ├── /mcp    → MCP Server         │
│   ├── /capture → REST API          │
│   └── /list   → REST API           │
├─────────────────────────────────────┤
│   Workers AI (bge-m3)              │ ← Tạo embedding vector
│   Cloudflare D1 (SQLite)           │ ← Lưu nội dung gốc
│   Cloudflare Vectorize (1024-dim)  │ ← Tìm kiếm semantic
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

# 4. Tạo Vectorize index (1024 dimensions cho bge-m3)
npm run vectors:create

# 5. Migrate schema lên remote
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

Restart Antigravity để áp dụng. Sau đó AI sẽ tự động có thêm 5 tools:
- `remember` — Lưu ghi chú
- `recall` — Tìm kiếm ngữ nghĩa (semantic search)
- `append` — Cập nhật ghi chú đã có
- `list_recent` — Liệt kê gần nhất
- `forget` — Xóa ghi chú

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
  → AI gọi `remember` lưu lại

- Bạn hỏi: *"Backend dùng port mấy?"*
  → AI gọi `recall` tìm và trả lời

- Bạn nói: *"Cập nhật: backend đã đổi sang port 3001"*
  → AI gọi `append` thêm update vào entry cũ

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
```

---

## MCP Tools chi tiết

| Tool | Tham số | Mô tả |
|---|---|---|
| `remember` | `content` (bắt buộc), `tags?`, `source?` | Lưu ghi chú mới. Tự phát hiện trùng lặp (>95% block, >85% cảnh báo) |
| `recall` | `query` (bắt buộc), `topK?` (mặc định 5), `tag?` | Tìm kiếm ngữ nghĩa. Hiểu được tiếng Việt, tiếng Anh, và 100+ ngôn ngữ khác |
| `append` | `id` (bắt buộc), `addition` (bắt buộc) | Thêm thông tin vào entry đã có, giữ nguyên nội dung cũ + timestamp update |
| `list_recent` | `n?` (mặc định 10), `tag?` | Liệt kê entries theo thời gian, có thể lọc theo tag |
| `forget` | `id` (bắt buộc) | Xóa entry và tất cả vector chunks liên quan |

---

## Tại sao dùng bge-m3?

`bge-m3` (Multi-Functionality, Multi-Linguality, Multi-Granularity) được chọn vì:

1. **100+ ngôn ngữ** — Tiếng Việt, tiếng Anh, tiếng Nhật, tiếng Hàn... tất cả trong 1 model
2. **Multi-Granularity** — Tìm kiếm tốt cả đoạn ngắn (câu hỏi) lẫn đoạn dài (tài liệu)
3. **Có sẵn trên Cloudflare Workers AI** — Free tier, không cần host model riêng
4. **Cùng họ BAAI/BGE** với model gốc — Code thay đổi tối thiểu

### So sánh các model Cloudflare Workers AI

| Model | Dimensions | Ngôn ngữ | Ghi chú |
|---|---|---|---|
| `bge-small-en-v1.5` | 384 | English only | Mặc định bản gốc |
| **`bge-m3`** | 1024 | **100+ ngôn ngữ** | ⭐ **Dùng trong fork này** |
| `embeddinggemma-300m` | — | 100+ ngôn ngữ | Google Gemma |
| `qwen3-embedding-0.6b` | — | Multilingual | Qwen3, 4096 token |

---

## Test local (trước khi deploy)

```bash
# Tạo file .dev.vars với nội dung:
# AUTH_TOKEN=test-token-local

# Migrate schema local
npm run db:migrate

# Chạy dev server (cần Cloudflare auth vì AI + Vectorize chạy remote)
npx wrangler dev --experimental-vectorize-bind-to-prod

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
| Cloudflare D1 | SQLite database | Free (5GB) |
| Cloudflare Vectorize | Vector search index | Free (30M vector dimensions) |
| Workers AI (bge-m3) | Text → Embedding | Free (10k tokens/phút) |
| MCP TypeScript SDK | Giao thức MCP | Open source |

---

## License

[MIT](LICENSE)
