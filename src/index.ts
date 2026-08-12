/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 * Modified by chithanh85: switched to qwen3-embedding-0.6b multilingual model (1024-dim)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  AUTH_TOKEN: string;
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

// ─── Thresholds ───────────────────────────────────────────────────────────────

const DUPLICATE_BLOCK_THRESHOLD = 0.95;
const DUPLICATE_FLAG_THRESHOLD = 0.85;
const MAX_JSON_BODY_BYTES = 256_000;
const MAX_CONTENT_CHARS = 50_000;
const MAX_ADDITION_CHARS = 20_000;
const MAX_QUERY_CHARS = 2_000;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 64;
const MAX_SOURCE_CHARS = 64;
const MAX_EMBEDDING_BATCH_SIZE = 32;
const MAX_VECTORIZE_INSERT_BATCH_SIZE = 500;
const MAX_VECTORIZE_TOP_K_WITH_METADATA = 50;

// ─── Embedding Model ──────────────────────────────────────────────────────────
// Using Qwen3-Embedding-0.6B: 100+ languages (incl. Vietnamese), 32K context,
// instruction-aware, Matryoshka Representation Learning (MRL). 1024-dim output.
const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";

// ─── Helpers ──────────────────────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "ValidationError";
  }
}

function isAuthorized(request: Request, env: Env): boolean {
  const authHeader = (request.headers.get("Authorization") || "").trim();
  const expectedToken = (env.AUTH_TOKEN || "").trim();
  return authHeader === `Bearer ${expectedToken}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function rejectLargeBody(request: Request): Response | null {
  const contentLength = request.headers.get("Content-Length");
  if (!contentLength) return null;

  const bytes = Number(contentLength);
  if (Number.isFinite(bytes) && bytes > MAX_JSON_BODY_BYTES) {
    return json({ error: `Request body is too large. Limit: ${MAX_JSON_BODY_BYTES} bytes` }, 413);
  }

  return null;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const rawBody = await request.text();
  if (rawBody.length > MAX_JSON_BODY_BYTES) {
    throw new ValidationError(`Request body is too large. Limit: ${MAX_JSON_BODY_BYTES} characters`, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ValidationError("Invalid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("JSON body must be an object");
  }

  return parsed as Record<string, unknown>;
}

function assertText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }

  const text = value.trim();
  if (!text) {
    throw new ValidationError(`${field} is required`);
  }

  if (text.length > maxChars) {
    throw new ValidationError(`${field} is too long. Limit: ${maxChars} characters`, 413);
  }

  return text;
}

function normalizeTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) {
    throw new ValidationError("tags must be an array of strings");
  }
  if (tags.length > MAX_TAGS) {
    throw new ValidationError(`Too many tags. Limit: ${MAX_TAGS}`);
  }

  const normalized: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") {
      throw new ValidationError("tags must be an array of strings");
    }

    const trimmed = tag.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_TAG_CHARS) {
      throw new ValidationError(`Tag is too long. Limit: ${MAX_TAG_CHARS} characters`);
    }
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
  }

  return normalized;
}

function normalizeSource(source: unknown, fallback: string): string {
  if (source === undefined || source === null || source === "") return fallback;
  if (typeof source !== "string") {
    throw new ValidationError("source must be a string");
  }

  const normalized = source.trim();
  if (!normalized) return fallback;
  if (normalized.length > MAX_SOURCE_CHARS) {
    throw new ValidationError(`source is too long. Limit: ${MAX_SOURCE_CHARS} characters`);
  }

  return normalized;
}

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function toolValidationError(error: unknown) {
  if (error instanceof ValidationError) return toolText(error.message);
  throw error;
}

async function embedMany(texts: string[], env: Env): Promise<number[][]> {
  if (!texts.length) return [];

  const result = (await env.AI.run(EMBEDDING_MODEL as any, { text: texts })) as { data?: unknown };
  const data = result.data;

  if (!Array.isArray(data) || data.length !== texts.length || !data.every((item) => Array.isArray(item))) {
    throw new Error("Unexpected embedding response from Workers AI");
  }

  return data as number[][];
}

async function embed(text: string, env: Env): Promise<number[]> {
  const [embedding] = await embedMany([text], env);
  return embedding;
}

async function embedTextsInBatches(texts: string[], env: Env): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += MAX_EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_EMBEDDING_BATCH_SIZE);
    embeddings.push(...await embedMany(batch, env));
  }

  return embeddings;
}

async function insertVectors(env: Env, vectors: VectorizeVector[]): Promise<void> {
  for (let i = 0; i < vectors.length; i += MAX_VECTORIZE_INSERT_BATCH_SIZE) {
    await env.VECTORIZE.insert(vectors.slice(i, i + MAX_VECTORIZE_INSERT_BATCH_SIZE));
  }
}

async function initializeDatabase(env: Env): Promise<void> {
  try {
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'api',
        created_at INTEGER NOT NULL,
        vector_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
    `);

    const { results } = await env.DB.prepare(`PRAGMA table_info(entries)`).all();
    const hasVectorIds = (results as Record<string, unknown>[]).some((column) => column.name === "vector_ids");

    if (!hasVectorIds) {
      await env.DB.exec(`ALTER TABLE entries ADD COLUMN vector_ids TEXT NOT NULL DEFAULT '[]'`);
    }
  } catch (e) {
    console.error("Database initialization error:", e);
    throw e;
  }
}

let databaseInitPromise: Promise<void> | null = null;

function ensureDatabase(env: Env): Promise<void> {
  databaseInitPromise ??= initializeDatabase(env).catch((e) => {
    databaseInitPromise = null;
    throw e;
  });
  return databaseInitPromise;
}

function safeJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

type DuplicateResult =
  | { status: "unique"; embedding: number[] }
  | { status: "blocked"; matchId: string; score: number; embedding: number[] }
  | { status: "flagged"; matchId: string; score: number; embedding: number[] };

interface RecallMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

function getDuplicateCheckSample(content: string): string {
  if (content.length <= 1600) return content;

  const start = content.slice(0, 500);
  const midIndex = Math.floor(content.length / 2);
  const middle = content.slice(Math.max(0, midIndex - 250), midIndex + 250);
  const end = content.slice(-500);

  return `${start}\n...\n${middle}\n...\n${end}`;
}

function getHalfLifeMs(tags: string[]): number {
  if (tags.includes("task")) return 7 * 24 * 60 * 60 * 1000;
  if (tags.includes("context")) return 180 * 24 * 60 * 60 * 1000;
  if (tags.includes("work")) return 90 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function rerankWithTimeDecay(matches: RecallMatch[]): RecallMatch[] {
  const now = Date.now();

  return matches
    .map((match) => {
      const meta = match.metadata;
      const createdAt = typeof meta?.created_at === "number" ? meta.created_at : now;
      const tags = Array.isArray(meta?.tags)
        ? meta.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      const ageMs = Math.max(0, now - createdAt);
      const recencyMultiplier = Math.exp(-ageMs / getHalfLifeMs(tags));

      return { ...match, score: match.score * recencyMultiplier };
    })
    .sort((a, b) => b.score - a.score);
}

async function checkDuplicate(content: string, env: Env): Promise<DuplicateResult> {
  const values = await embed(getDuplicateCheckSample(content), env);
  const results = await env.VECTORIZE.query(values, { topK: 1, returnMetadata: "all" });

  if (!results.matches.length) return { status: "unique", embedding: values };

  const top = results.matches[0];
  const score = top.score;
  const matchId = (top.metadata as any)?.parentId ?? top.id;

  if (score >= DUPLICATE_BLOCK_THRESHOLD) return { status: "blocked", matchId, score, embedding: values };
  if (score >= DUPLICATE_FLAG_THRESHOLD) return { status: "flagged", matchId, score, embedding: values };
  return { status: "unique", embedding: values };
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

function chunkText(text: string, maxChars = 1600, overlapChars = 200): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxChars / 2) end = breakPoint + 1;
    }
    chunks.push(text.slice(start, Math.min(end, text.length)).trim());
    start = end - overlapChars;
  }

  return chunks.filter((c) => c.length > 0);
}

// ─── Store entry (full embed + chunk) ────────────────────────────────────────

async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  precomputedEmbedding?: number[]
): Promise<string[]> {
  const chunks = chunkText(content);

  const chunkEmbeddings = new Map<number, number[]>();
  if (chunks.length === 1 && precomputedEmbedding) {
    chunkEmbeddings.set(0, precomputedEmbedding);
  } else {
    const embeddings = await embedTextsInBatches(chunks, env);
    embeddings.forEach((values, i) => chunkEmbeddings.set(i, values));
  }

  const vectors: VectorizeVector[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const values = chunkEmbeddings.get(i);
    if (!values) throw new Error(`Missing embedding for chunk ${i}`);

    const chunk = chunks[i];
    vectors.push({
      id: chunks.length === 1 ? id : `${id}-chunk-${i}`,
      values,
      metadata: {
        content: chunk.slice(0, 512),
        parentId: id,
        chunkIndex: i,
        totalChunks: chunks.length,
        tags,
        source,
        created_at: now,
      },
    });
  }

  await insertVectors(env, vectors);
  const vectorIds = vectors.map((vector) => vector.id);

  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify(vectorIds), id).run();

  return vectorIds;
}

// ─── Append to existing entry ─────────────────────────────────────────────────
// Updates D1 with the full appended content, then adds only the new addition
// as a new Vectorize chunk pointing to the same parent ID.

async function appendToEntry(
  env: Env,
  id: string,
  existingContent: string,
  addition: string,
  tags: string[],
  source: string
): Promise<void> {
  const timestamp = new Date().toLocaleDateString();
  const separator = `\n\n[Update ${timestamp}]: `;
  const newContent = existingContent + separator + addition;

  // Update full content in D1
  await env.DB.prepare(
    `UPDATE entries SET content = ? WHERE id = ?`
  ).bind(newContent, id).run();

  const chunks = chunkText(addition);
  const embeddings = await embedTextsInBatches(chunks, env);
  const updateIdBase = `${id}-update-${Date.now()}`;
  const createdAt = Date.now();

  const vectors: VectorizeVector[] = chunks.map((chunk, i) => ({
    id: `${updateIdBase}-${i}`,
    values: embeddings[i],
    metadata: {
      content: chunk.slice(0, 512),
      parentId: id,
      chunkIndex: i,
      totalChunks: chunks.length,
      isUpdate: true,
      tags,
      source,
      created_at: createdAt,
    },
  }));

  await insertVectors(env, vectors);

  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, unknown> | null;
  const vectorIds = [...safeJsonArray(row?.vector_ids), ...vectors.map((vector) => vector.id)];

  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify(vectorIds), id).run();
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "second-brain", version: "1.2.0" });

  // ── remember ────────────────────────────────────────────────────────────
  server.tool(
    "remember",
    "Store an idea, task, or note in your second brain",
    {
      content: z.string().min(1).max(MAX_CONTENT_CHARS).describe("The idea, task, or note to store"),
      tags: z.array(z.string().min(1).max(MAX_TAG_CHARS)).max(MAX_TAGS).optional().describe("Optional tags for filtering"),
      source: z.string().max(MAX_SOURCE_CHARS).optional().describe("Origin: phone, browser, voice, claude"),
    },
    async ({ content, tags, source }) => {
      let c: string;
      let t: string[];
      let s: string;

      try {
        c = assertText(content, "content", MAX_CONTENT_CHARS);
        t = normalizeTags(tags);
        s = normalizeSource(source, "claude");
      } catch (e) {
        return toolValidationError(e);
      }

      const dup = await checkDuplicate(c, env);

      if (dup.status === "blocked") {
        return {
          content: [{
            type: "text",
            text: `Duplicate detected (${(dup.score * 100).toFixed(0)}% match) — not stored. Existing entry ID: ${dup.matchId}`,
          }],
        };
      }

      let autoTags: string[] = [];
      try {
        if (env.AI) {
          const prompt = `Extract 2 to 4 concise technical topic tags (lowercase, hyphenated, e.g. "mql5", "wfo", "kaggle-gpu") for this text. Respond ONLY with a JSON array of strings, e.g. ["tag1", "tag2"]. Text: ${c.substring(0, 1000)}`;
          const response = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
            messages: [{ role: "user", content: prompt }]
          })) as { response?: string };
          const match = (response?.response || "").match(/\[.*\]/s);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (Array.isArray(parsed)) {
              autoTags = parsed.map((x) => String(x).toLowerCase().trim().replace(/[^a-z0-9-]/g, "")).filter(Boolean);
            }
          }
        }
      } catch (e) {
        console.error("Auto-tag generation failed:", e);
      }

      const mergedTags = Array.from(new Set([...t, ...autoTags]));
      const id = crypto.randomUUID();
      const now = Date.now();
      const finalTags = dup.status === "flagged" ? [...mergedTags, "duplicate-candidate"] : mergedTags;

      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(finalTags), s, now, "[]").run();

      try {
        await storeEntry(env, id, c, finalTags, s, now, dup.embedding);
      } catch (e) {
        console.error("Vectorize insert failed (non-fatal):", e);
      }

      if (dup.status === "flagged") {
        return {
          content: [{
            type: "text",
            text: `Stored with ID: ${id} — note: similar entry exists (${(dup.score * 100).toFixed(0)}% match, ID: ${dup.matchId}). Tagged as duplicate-candidate.`,
          }],
        };
      }

      return { content: [{ type: "text", text: `Stored. ID: ${id}` }] };
    }
  );

  // ── append ───────────────────────────────────────────────────────────────
  server.tool(
    "append",
    "Append new information to an existing entry in your second brain. Use this when something has changed or you have an update to a stored note — preserves the original and adds the update with a timestamp.",
    {
      id: z.string().describe("Entry ID to append to — from recall or list_recent"),
      addition: z.string().min(1).max(MAX_ADDITION_CHARS).describe("The new information to add to the existing entry"),
    },
    async ({ id, addition }) => {
      // Look up the existing entry
      const row = await env.DB.prepare(
        `SELECT id, content, tags, source FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return {
          content: [{ type: "text", text: `No entry found with ID: ${id}` }],
        };
      }

      const existingContent = row.content as string;
      const tags = safeJsonArray(row.tags);
      const source = row.source as string;
      let a: string;

      try {
        a = assertText(addition, "addition", MAX_ADDITION_CHARS);
      } catch (e) {
        return toolValidationError(e);
      }

      try {
        await appendToEntry(env, id, existingContent, a, tags, source);
      } catch (e) {
        console.error("Append failed:", e);
        return {
          content: [{ type: "text", text: `Append failed: ${(e as Error).message}` }],
        };
      }

      return {
        content: [{
          type: "text",
          text: `Appended to entry ${id}. The original content is preserved and your update has been added with today's date.`,
        }],
      };
    }
  );

  // ── recall ───────────────────────────────────────────────────────────────
  server.tool(
    "recall",
    "Semantically search your second brain for relevant notes",
    {
      query: z.string().min(1).max(MAX_QUERY_CHARS).describe("Natural language search query"),
      topK: z.number().int().min(1).max(20).default(5).describe("Number of results"),
      tag: z.string().min(1).max(MAX_TAG_CHARS).optional().describe("Filter by a specific tag"),
    },
    async ({ query, topK, tag }) => {
      let q: string;
      let requestedTag: string | undefined;

      try {
        q = assertText(query, "query", MAX_QUERY_CHARS);
        requestedTag = tag ? assertText(tag, "tag", MAX_TAG_CHARS) : undefined;
      } catch (e) {
        return toolValidationError(e);
      }

      let tagFilterIds: Set<string> | null = null;
      if (requestedTag) {
        const { results: tagRows } = await env.DB.prepare(
          `SELECT id FROM entries WHERE tags LIKE ?`
        ).bind(`%"${requestedTag}"%`).all();

        tagFilterIds = new Set((tagRows as Record<string, unknown>[]).map((row) => row.id as string));
        if (!tagFilterIds.size) {
          return { content: [{ type: "text", text: "Nothing found matching that query." }] };
        }
      }

      const queryTopK = requestedTag ? MAX_VECTORIZE_TOP_K_WITH_METADATA : Math.min(topK * 3, MAX_VECTORIZE_TOP_K_WITH_METADATA);
      const values = await embed(q, env);
      const results = await env.VECTORIZE.query(values, {
        topK: queryTopK,
        returnMetadata: "all",
      });

      if (!results.matches.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      const reranked = rerankWithTimeDecay(results.matches as RecallMatch[]);
      const seen = new Set<string>();
      const deduped = reranked.filter((m) => {
        const parentId = (m.metadata as any)?.parentId ?? m.id;
        if (seen.has(parentId)) return false;
        if (tagFilterIds && !tagFilterIds.has(parentId)) return false;
        seen.add(parentId);
        return true;
      }).slice(0, topK);

      if (!deduped.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      const parentIds = deduped.map((m) => ((m.metadata as any)?.parentId ?? m.id) as string);
      const placeholders = parentIds.map(() => "?").join(", ");
      const { results: d1Rows } = await env.DB.prepare(
        `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${placeholders})`
      ).bind(...parentIds).all() as { results: Record<string, unknown>[] };
      const d1Map = new Map(d1Rows.map((row) => [row.id as string, row]));

      const text = deduped.map((m, i) => {
        const meta = m.metadata as Record<string, any>;
        const parentId = (meta?.parentId ?? m.id) as string;
        const row = d1Map.get(parentId);
        const score = (m.score * 100).toFixed(0);
        const updateLabel = meta?.isUpdate ? " [updated]" : "";

        if (row) {
          const date = typeof row.created_at === "number" ? new Date(row.created_at).toLocaleDateString() : "?";
          const tags = safeJsonArray(row.tags);
          const tagList = tags.length ? ` [${tags.join(", ")}]` : "";
          const src = row.source ? ` · ${row.source as string}` : "";
          return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${updateLabel}\n${row.content as string}`;
        }

        const date = meta?.created_at ? new Date(meta.created_at as number).toLocaleDateString() : "?";
        const tagList = Array.isArray(meta?.tags) && meta.tags.length ? ` [${(meta.tags as string[]).join(", ")}]` : "";
        const src = meta?.source ? ` · ${meta.source}` : "";
        const chunkLabel = meta?.totalChunks > 1 ? ` (chunk ${meta.chunkIndex + 1}/${meta.totalChunks})` : "";
        return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${chunkLabel}${updateLabel}\n${meta?.content ?? ""}`;
      }).join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── list_recent ──────────────────────────────────────────────────────────
  server.tool(
    "list_recent",
    "List the most recent entries from your second brain",
    {
      n: z.number().int().min(1).max(50).default(10),
      tag: z.string().min(1).max(MAX_TAG_CHARS).optional(),
    },
    async ({ n, tag }) => {
      let requestedTag: string | undefined;
      try {
        requestedTag = tag ? assertText(tag, "tag", MAX_TAG_CHARS) : undefined;
      } catch (e) {
        return toolValidationError(e);
      }

      let q = `SELECT id, content, tags, source, created_at FROM entries`;
      const p: (string | number)[] = [];
      if (requestedTag) { q += ` WHERE tags LIKE ?`; p.push(`%"${requestedTag}"%`); }
      q += ` ORDER BY created_at DESC LIMIT ?`; p.push(n);

      const { results } = await env.DB.prepare(q).bind(...p).all();

      if (!results.length) {
        return { content: [{ type: "text", text: "No entries found." }] };
      }

      const text = (results as Record<string, any>[]).map((row, i) => {
        const date = new Date(row.created_at as number).toLocaleDateString();
        const tags = safeJsonArray(row.tags);
        const tagStr = tags.length ? ` · ${tags.join(", ")}` : "";
        return `${i + 1}. [${date} · ${row.source}${tagStr}]\nID: ${row.id as string}\n${row.content}`;
      }).join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── forget ───────────────────────────────────────────────────────────────
  server.tool(
    "forget",
    "Delete an entry from your second brain by ID",
    { id: z.string().describe("Entry ID from recall or list_recent") },
    async ({ id }) => {
      const row = await env.DB.prepare(
        `SELECT vector_ids FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, unknown> | null;
      const trackedVectorIds = safeJsonArray(row?.vector_ids);

      await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();

      try {
        if (trackedVectorIds.length) {
          await env.VECTORIZE.deleteByIds(trackedVectorIds);
        } else {
          const chunkIds = Array.from({ length: 20 }, (_, i) => `${id}-chunk-${i}`);
          await env.VECTORIZE.deleteByIds([id, ...chunkIds]);
        }
      } catch (e) {
        console.error("Vectorize delete failed (non-fatal):", e);
      }

      return { content: [{ type: "text", text: `Deleted entry ${id} and ${trackedVectorIds.length} vector(s)` }] };
    }
  );

  return server;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    ctx.waitUntil(
      ensureDatabase(env).catch((e) => console.error("Async database initialization failed:", e))
    );

    // POST /capture
    if (url.pathname === "/capture" && request.method === "POST") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const largeBodyResponse = rejectLargeBody(request);
      if (largeBodyResponse) return largeBodyResponse;

      let body: Record<string, unknown>;
      try {
        body = await readJsonObject(request);
      } catch (e) {
        if (e instanceof ValidationError) return json({ error: e.message }, e.status);
        throw e;
      }

      let c: string;
      let t: string[];
      let s: string;
      try {
        c = assertText(body.content, "content", MAX_CONTENT_CHARS);
        t = normalizeTags(body.tags);
        s = normalizeSource(body.source, "api");
      } catch (e) {
        if (e instanceof ValidationError) return json({ error: e.message }, e.status);
        throw e;
      }

      const dup = await checkDuplicate(c, env);

      if (dup.status === "blocked") {
        return json({
          ok: false,
          duplicate: true,
          matchId: dup.matchId,
          score: parseFloat((dup.score * 100).toFixed(1)),
          message: "Near-exact duplicate detected — not stored",
        });
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      const finalTags = dup.status === "flagged" ? [...t, "duplicate-candidate"] : t;

      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, c, JSON.stringify(finalTags), s, now, "[]").run();

      ctx.waitUntil(
        storeEntry(env, id, c, finalTags, s, now, dup.embedding)
          .catch((e) => console.error("Async embed failed:", e))
      );

      if (dup.status === "flagged") {
        return json({
          ok: true,
          id,
          warning: "similar",
          matchId: dup.matchId,
          score: parseFloat((dup.score * 100).toFixed(1)),
          message: "Stored but similar entry exists — tagged as duplicate-candidate",
        });
      }

      return json({ ok: true, id });
    }

    // GET /list
    if (url.pathname === "/list" && request.method === "GET") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const requestedN = parseInt(url.searchParams.get("n") ?? "20", 10);
      const n = Number.isFinite(requestedN) ? Math.min(Math.max(requestedN, 1), 100) : 20;
      const { results } = await env.DB.prepare(
        `SELECT id, content, tags, source, created_at FROM entries ORDER BY created_at DESC LIMIT ?`
      ).bind(n).all();
      return json(results);
    }

    // /mcp
    if (url.pathname === "/mcp") {
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const largeBodyResponse = rejectLargeBody(request);
      if (largeBodyResponse) return largeBodyResponse;

      const server = buildMcpServer(env);
      return createMcpHandler(server)(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
