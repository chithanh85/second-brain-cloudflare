/**
 * Second Brain v2.0 — Cloudflare Worker
 * https://github.com/chithanh85/second-brain-cloudflare
 *
 * Features:
 *   - Memory Graph with auto-linking & multi-hop recall
 *   - Graceful Degradation (Vectorize → SQL keyword fallback)
 *   - Advanced Recall (recency weighting, MMR diversity, similarity cutoff)
 *   - Qwen3-Embedding-0.6B multilingual model (1024-dim, 32K context)
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
const AUTO_LINK_THRESHOLD = 0.6;
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
const RECENCY_WEIGHT_DEFAULT = 0.3;
const MAX_HOPS = 3;
const MAX_CONNECTIONS_DEPTH = 3;

// Edge relation types
const VALID_RELATIONS = ["related", "extends", "contradicts", "depends_on"] as const;
type EdgeRelation = (typeof VALID_RELATIONS)[number];

// ─── Embedding Model ──────────────────────────────────────────────────────────
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

// ─── Database initialization ──────────────────────────────────────────────────

async function initializeDatabase(env: Env): Promise<void> {
  try {
    // Use batch with individual statements (D1 exec() has issues with multi-line CREATE TABLE on production)
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)`),
    ]);

    const { results } = await env.DB.prepare(`PRAGMA table_info(entries)`).all();
    const hasVectorIds = (results as Record<string, unknown>[]).some((column) => column.name === "vector_ids");

    if (!hasVectorIds) {
      await env.DB.prepare(`ALTER TABLE entries ADD COLUMN vector_ids TEXT NOT NULL DEFAULT '[]'`).run();
    }

    // ── Memory Graph: edges table ──
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS edges (source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'related', weight REAL NOT NULL DEFAULT 1.0, created_at INTEGER NOT NULL, PRIMARY KEY (source_id, target_id))`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)`),
    ]);
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

// ─── Graceful Degradation ─────────────────────────────────────────────────────

interface SafeQueryResult {
  matches: RecallMatch[];
  degraded: boolean;
}

async function safeVectorizeQuery(
  env: Env,
  values: number[],
  options: { topK: number; returnMetadata?: "all" | "indexed" | "none" }
): Promise<SafeQueryResult> {
  try {
    const results = await env.VECTORIZE.query(values, options);
    return { matches: results.matches as RecallMatch[], degraded: false };
  } catch (e) {
    console.error("Vectorize query failed, degrading to keyword search:", e);
    return { matches: [], degraded: true };
  }
}

/**
 * SQL keyword fallback when Vectorize is unavailable.
 * Splits query into words, searches D1 with LIKE.
 */
async function keywordFallbackSearch(
  env: Env,
  query: string,
  topK: number,
  tag?: string
): Promise<RecallMatch[]> {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8); // cap to avoid huge SQL

  if (!keywords.length) return [];

  const conditions = keywords.map(() => `LOWER(content) LIKE ?`);
  let sql = `SELECT id, content, tags, source, created_at FROM entries WHERE (${conditions.join(" OR ")})`;
  const params: (string | number)[] = keywords.map((k) => `%${k}%`);

  if (tag) {
    sql += ` AND tags LIKE ?`;
    params.push(`%"${tag}"%`);
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(topK);

  const { results } = await env.DB.prepare(sql).bind(...params).all();

  return (results as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    score: 0,
    metadata: {
      content: (row.content as string).slice(0, 512),
      parentId: row.id as string,
      tags: safeJsonArray(row.tags),
      source: row.source as string,
      created_at: row.created_at as number,
    },
  }));
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

type DuplicateResult =
  | { status: "unique"; embedding: number[] }
  | { status: "blocked"; matchId: string; score: number; embedding: number[] }
  | { status: "flagged"; matchId: string; score: number; embedding: number[] }
  | { status: "skipped"; embedding: number[] }; // Vectorize unavailable

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

/**
 * Rerank results with configurable time-decay weighting.
 * Uses weighted sum: final = (1 - w) * semantic + w * recency
 */
function rerankWithTimeDecay(matches: RecallMatch[], recencyWeight: number = RECENCY_WEIGHT_DEFAULT): RecallMatch[] {
  if (recencyWeight <= 0) {
    return [...matches].sort((a, b) => b.score - a.score);
  }

  const now = Date.now();
  const w = Math.min(recencyWeight, 1);

  return matches
    .map((match) => {
      const meta = match.metadata;
      const createdAt = typeof meta?.created_at === "number" ? meta.created_at : now;
      const tags = Array.isArray(meta?.tags)
        ? meta.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      const ageMs = Math.max(0, now - createdAt);
      const recencyScore = Math.exp(-ageMs / getHalfLifeMs(tags));

      // Weighted combination: semantic relevance + time recency
      const finalScore = (1 - w) * match.score + w * recencyScore;

      return { ...match, score: finalScore };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Duplicate check with graceful degradation.
 * If Vectorize fails, returns "skipped" and allows the entry to be stored.
 */
async function checkDuplicate(content: string, env: Env): Promise<DuplicateResult> {
  const values = await embed(getDuplicateCheckSample(content), env);

  const { matches, degraded } = await safeVectorizeQuery(env, values, { topK: 1, returnMetadata: "all" });

  if (degraded) {
    return { status: "skipped", embedding: values };
  }

  if (!matches.length) return { status: "unique", embedding: values };

  const top = matches[0];
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

// ─── Memory Graph ─────────────────────────────────────────────────────────────

/**
 * Auto-create edges between a new entry and similar existing entries.
 * Uses the already-computed embedding (no extra AI call).
 */
async function autoLinkEntry(env: Env, id: string, embedding: number[], now: number): Promise<number> {
  try {
    const results = await env.VECTORIZE.query(embedding, { topK: 4, returnMetadata: "all" });

    // Filter: not self, above threshold, deduplicate by parentId
    const seen = new Set<string>([id]);
    const candidates = results.matches.filter((m) => {
      const parentId = (m.metadata as any)?.parentId ?? m.id;
      if (seen.has(parentId)) return false;
      if (m.score < AUTO_LINK_THRESHOLD) return false;
      seen.add(parentId);
      return true;
    }).slice(0, 3);

    if (!candidates.length) return 0;

    // Create bidirectional edges
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO edges (source_id, target_id, relation, weight, created_at) VALUES (?, ?, 'related', ?, ?)`
    );
    const batch = candidates.flatMap((m) => {
      const targetId = (m.metadata as any)?.parentId ?? m.id;
      const w = Math.round(m.score * 1000) / 1000;
      return [
        stmt.bind(id, targetId, w, now),
        stmt.bind(targetId, id, w, now),
      ];
    });

    await env.DB.batch(batch);
    return candidates.length;
  } catch (e) {
    console.error("Auto-link failed (non-fatal):", e);
    return 0;
  }
}

/**
 * Get connections (neighbors) of an entry, up to `depth` hops.
 */
async function getConnections(
  env: Env,
  id: string,
  depth: number = 1
): Promise<{ id: string; relation: string; weight: number; content: string; hop: number }[]> {
  const visited = new Set<string>([id]);
  const results: { id: string; relation: string; weight: number; content: string; hop: number }[] = [];
  let currentIds = [id];

  for (let hop = 1; hop <= depth; hop++) {
    if (!currentIds.length) break;

    const placeholders = currentIds.map(() => "?").join(", ");
    const { results: edgeRows } = await env.DB.prepare(`
      SELECT source_id, target_id, relation, weight FROM edges
      WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
    `).bind(...currentIds, ...currentIds).all() as { results: Record<string, unknown>[] };

    const neighborIds = new Set<string>();
    const edgeMap = new Map<string, { relation: string; weight: number }>();

    for (const row of edgeRows) {
      const src = row.source_id as string;
      const tgt = row.target_id as string;
      const neighborId = currentIds.includes(src) ? tgt : src;

      if (!visited.has(neighborId)) {
        neighborIds.add(neighborId);
        edgeMap.set(neighborId, { relation: row.relation as string, weight: row.weight as number });
        visited.add(neighborId);
      }
    }

    if (!neighborIds.size) break;

    const nIds = [...neighborIds];
    const nPlaceholders = nIds.map(() => "?").join(", ");
    const { results: entryRows } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${nPlaceholders})`
    ).bind(...nIds).all() as { results: Record<string, unknown>[] };

    for (const row of entryRows) {
      const edge = edgeMap.get(row.id as string);
      results.push({
        id: row.id as string,
        relation: edge?.relation ?? "related",
        weight: edge?.weight ?? 1.0,
        content: (row.content as string).slice(0, 200),
        hop,
      });
    }

    currentIds = nIds;
  }

  return results;
}

/**
 * Expand recall seeds by following graph edges (multi-hop).
 * Returns additional entries discovered via graph traversal.
 */
async function expandWithHops(
  env: Env,
  seeds: { parentId: string; score: number }[],
  hops: number
): Promise<{ id: string; score: number; hop: number }[]> {
  if (hops <= 0 || !seeds.length) return [];

  const visited = new Set<string>(seeds.map((s) => s.parentId));
  const expanded: { id: string; score: number; hop: number }[] = [];
  let currentLayer = seeds.map((s) => ({ id: s.parentId, score: s.score }));

  for (let hop = 1; hop <= hops; hop++) {
    if (!currentLayer.length) break;

    const ids = currentLayer.map((s) => s.id);
    const placeholders = ids.map(() => "?").join(", ");
    const { results: edgeRows } = await env.DB.prepare(`
      SELECT source_id, target_id, weight FROM edges
      WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
    `).bind(...ids, ...ids).all() as { results: Record<string, unknown>[] };

    const nextLayer: { id: string; score: number }[] = [];
    const scoreMap = new Map(currentLayer.map((s) => [s.id, s.score]));

    for (const row of edgeRows) {
      const src = row.source_id as string;
      const tgt = row.target_id as string;
      const neighborId = ids.includes(src) ? tgt : src;
      const originId = ids.includes(src) ? src : tgt;

      if (visited.has(neighborId)) continue;
      visited.add(neighborId);

      const originScore = scoreMap.get(originId) ?? 0;
      const edgeWeight = row.weight as number;
      const hopDecay = Math.pow(0.8, hop);
      const neighborScore = originScore * edgeWeight * hopDecay;

      expanded.push({ id: neighborId, score: neighborScore, hop });
      nextLayer.push({ id: neighborId, score: neighborScore });
    }

    currentLayer = nextLayer;
  }

  return expanded;
}

// ─── Advanced Recall: MMR ─────────────────────────────────────────────────────

interface MMRCandidate {
  id: string;
  parentId: string;
  score: number;
  tags: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Maximal Marginal Relevance (MMR) for diversifying recall results.
 *
 * Simplified approach: instead of computing full cosine similarity between
 * all candidate pairs (which would require raw vectors), we estimate
 * inter-result similarity using parentId overlap and tag Jaccard similarity.
 *
 * MMR(d) = (1 - λ) × relevance(d) − λ × max[sim(d, d_selected)]
 */
function applyMMR(candidates: MMRCandidate[], lambda: number, topK: number): MMRCandidate[] {
  if (lambda <= 0 || candidates.length <= 1) return candidates.slice(0, topK);

  const selected: MMRCandidate[] = [];
  const remaining = [...candidates].sort((a, b) => b.score - a.score);

  // Pick highest-scoring candidate first
  selected.push(remaining.shift()!);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMMR = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const relevance = cand.score;

      // Compute max similarity to already-selected results
      let maxSim = 0;
      for (const sel of selected) {
        let sim = 0;
        if (cand.parentId === sel.parentId) {
          sim = 0.9; // near-duplicate chunks
        } else {
          // Tag Jaccard similarity
          const candTags = new Set(cand.tags);
          const selTags = new Set(sel.tags);
          const intersection = [...candTags].filter((t) => selTags.has(t)).length;
          const union = new Set([...candTags, ...selTags]).size;
          sim = union > 0 ? intersection / union : 0;
        }
        maxSim = Math.max(maxSim, sim);
      }

      const mmr = (1 - lambda) * relevance - lambda * maxSim;
      if (mmr > bestMMR) {
        bestMMR = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "second-brain", version: "2.0.0" });

  // ── remember ────────────────────────────────────────────────────────────
  server.tool(
    "remember",
    "Store an idea, task, or note in your second brain. Automatically links to similar existing memories.",
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

      let linkedCount = 0;
      try {
        await storeEntry(env, id, c, finalTags, s, now, dup.embedding);
        // Auto-link to similar entries (Memory Graph)
        linkedCount = await autoLinkEntry(env, id, dup.embedding, now);
      } catch (e) {
        console.error("Vectorize insert failed (non-fatal):", e);
      }

      const linkedNote = linkedCount > 0 ? ` Linked to ${linkedCount} related memory(ies).` : "";

      if (dup.status === "flagged") {
        return {
          content: [{
            type: "text",
            text: `Stored with ID: ${id} — note: similar entry exists (${(dup.score * 100).toFixed(0)}% match, ID: ${dup.matchId}). Tagged as duplicate-candidate.${linkedNote}`,
          }],
        };
      }

      if (dup.status === "skipped") {
        return {
          content: [{
            type: "text",
            text: `Stored with ID: ${id} [⚠ Vectorize unavailable — duplicate check skipped]`,
          }],
        };
      }

      return { content: [{ type: "text", text: `Stored. ID: ${id}${linkedNote}` }] };
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
    "Semantically search your second brain for relevant notes. Supports multi-hop graph traversal, recency weighting, diversity control, and minimum similarity filtering.",
    {
      query: z.string().min(1).max(MAX_QUERY_CHARS).describe("Natural language search query"),
      topK: z.number().int().min(1).max(20).default(5).describe("Number of results"),
      tag: z.string().min(1).max(MAX_TAG_CHARS).optional().describe("Filter by a specific tag"),
      hops: z.number().int().min(0).max(MAX_HOPS).default(0).describe("Graph traversal depth (0 = semantic only, 1-3 = follow connections)"),
      recency_weight: z.number().min(0).max(1).default(RECENCY_WEIGHT_DEFAULT).describe("Time-decay weight (0 = pure semantic, 1 = pure recency)"),
      diversity: z.number().min(0).max(1).default(0).describe("MMR diversity (0 = off, 0.3-0.5 = balanced, 1 = max diversity)"),
      min_score: z.number().min(0).max(1).default(0).describe("Minimum similarity cutoff (0 = no filter)"),
    },
    async ({ query, topK, tag, hops, recency_weight, diversity, min_score }) => {
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

      // ── Semantic search (with graceful degradation) ──
      const queryTopK = requestedTag
        ? MAX_VECTORIZE_TOP_K_WITH_METADATA
        : Math.min(topK * 3, MAX_VECTORIZE_TOP_K_WITH_METADATA);

      let values: number[];
      let allMatches: RecallMatch[];
      let degraded = false;

      try {
        values = await embed(q, env);
      } catch (e) {
        // If embedding fails, fall back to keyword search
        console.error("Embedding failed, falling back to keyword search:", e);
        values = [];
        degraded = true;
      }

      if (!degraded && values.length > 0) {
        const result = await safeVectorizeQuery(env, values, {
          topK: queryTopK,
          returnMetadata: "all",
        });
        allMatches = result.matches;
        degraded = result.degraded;
      } else {
        allMatches = [];
        degraded = true;
      }

      // Fallback to keyword search if Vectorize failed
      if (degraded) {
        allMatches = await keywordFallbackSearch(env, q, topK, requestedTag);
        if (!allMatches.length) {
          return { content: [{ type: "text", text: "Nothing found matching that query. [⚠ Vectorize unavailable — used keyword fallback]" }] };
        }
      }

      if (!allMatches.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      // ── Apply similarity cutoff ──
      if (min_score > 0 && !degraded) {
        allMatches = allMatches.filter((m) => m.score >= min_score);
        if (!allMatches.length) {
          return { content: [{ type: "text", text: `Nothing found above ${(min_score * 100).toFixed(0)}% similarity threshold.` }] };
        }
      }

      // ── Rerank with time decay ──
      const reranked = rerankWithTimeDecay(allMatches, recency_weight);

      // ── Deduplicate by parentId + tag filter ──
      const seen = new Set<string>();
      const deduped = reranked.filter((m) => {
        const parentId = (m.metadata as any)?.parentId ?? m.id;
        if (seen.has(parentId)) return false;
        if (tagFilterIds && !tagFilterIds.has(parentId)) return false;
        seen.add(parentId);
        return true;
      });

      // ── Apply MMR diversity ──
      let selected: typeof deduped;
      if (diversity > 0 && !degraded) {
        const mmrCandidates: MMRCandidate[] = deduped.map((m) => ({
          id: m.id,
          parentId: ((m.metadata as any)?.parentId ?? m.id) as string,
          score: m.score,
          tags: Array.isArray((m.metadata as any)?.tags)
            ? ((m.metadata as any).tags as string[])
            : [],
          metadata: m.metadata,
        }));
        const mmrResult = applyMMR(mmrCandidates, diversity, topK);
        selected = mmrResult.map((c) => ({
          id: c.id,
          score: c.score,
          metadata: c.metadata,
        }));
      } else {
        selected = deduped.slice(0, topK);
      }

      if (!selected.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      // ── Multi-hop graph expansion ──
      let hopEntries: { id: string; score: number; hop: number }[] = [];
      if (hops > 0 && !degraded) {
        const seeds = selected.map((m) => ({
          parentId: ((m.metadata as any)?.parentId ?? m.id) as string,
          score: m.score,
        }));
        hopEntries = await expandWithHops(env, seeds, hops);
      }

      // ── Fetch full content from D1 ──
      const parentIds = selected.map((m) => ((m.metadata as any)?.parentId ?? m.id) as string);
      const hopIds = hopEntries.map((h) => h.id);
      const allIds = [...new Set([...parentIds, ...hopIds])];
      const placeholders = allIds.map(() => "?").join(", ");

      const { results: d1Rows } = await env.DB.prepare(
        `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${placeholders})`
      ).bind(...allIds).all() as { results: Record<string, unknown>[] };
      const d1Map = new Map(d1Rows.map((row) => [row.id as string, row]));

      // ── Format seed results ──
      const parts: string[] = [];

      const seedText = selected.map((m, i) => {
        const meta = m.metadata as Record<string, any>;
        const parentId = (meta?.parentId ?? m.id) as string;
        const row = d1Map.get(parentId);
        const score = (m.score * 100).toFixed(0);
        const updateLabel = meta?.isUpdate ? " [updated]" : "";

        if (row) {
          const date = typeof row.created_at === "number" ? new Date(row.created_at as number).toLocaleDateString() : "?";
          const tags = safeJsonArray(row.tags);
          const tagList = tags.length ? ` [${tags.join(", ")}]` : "";
          const src = row.source ? ` · ${row.source as string}` : "";
          return `${i + 1}. [${date}${src}${tagList}] (${degraded ? "keyword" : `${score}%`} match)${updateLabel}\nID: ${parentId}\n${row.content as string}`;
        }

        const date = meta?.created_at ? new Date(meta.created_at as number).toLocaleDateString() : "?";
        const tagList = Array.isArray(meta?.tags) && meta.tags.length ? ` [${(meta.tags as string[]).join(", ")}]` : "";
        const src = meta?.source ? ` · ${meta.source}` : "";
        const chunkLabel = meta?.totalChunks > 1 ? ` (chunk ${meta.chunkIndex + 1}/${meta.totalChunks})` : "";
        return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${chunkLabel}${updateLabel}\n${meta?.content ?? ""}`;
      }).join("\n\n");

      parts.push(seedText);

      // ── Format hop results (if any) ──
      if (hopEntries.length) {
        const hopTexts = hopEntries
          .sort((a, b) => b.score - a.score)
          .slice(0, topK)
          .map((h, i) => {
            const row = d1Map.get(h.id);
            if (!row) return null;
            const date = typeof row.created_at === "number" ? new Date(row.created_at as number).toLocaleDateString() : "?";
            const tags = safeJsonArray(row.tags);
            const tagList = tags.length ? ` [${tags.join(", ")}]` : "";
            const src = row.source ? ` · ${row.source as string}` : "";
            return `  ↳ ${i + 1}. [${date}${src}${tagList}] (hop ${h.hop}, ${(h.score * 100).toFixed(0)}% graph score)\n  ID: ${h.id}\n  ${(row.content as string).slice(0, 300)}${(row.content as string).length > 300 ? "..." : ""}`;
          })
          .filter(Boolean);

        if (hopTexts.length) {
          parts.push(`\n── Connected memories (via graph, ${hops} hop${hops > 1 ? "s" : ""}) ──\n${hopTexts.join("\n\n")}`);
        }
      }

      if (degraded) {
        parts.push("\n[⚠ Vectorize unavailable — results from keyword fallback]");
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    }
  );

  // ── link ─────────────────────────────────────────────────────────────────
  server.tool(
    "link",
    "Create a connection between two memories in the knowledge graph. Links are bidirectional.",
    {
      source_id: z.string().describe("First entry ID"),
      target_id: z.string().describe("Second entry ID"),
      relation: z.enum(VALID_RELATIONS).default("related").describe("Relationship type: related, extends, contradicts, depends_on"),
    },
    async ({ source_id, target_id, relation }) => {
      if (source_id === target_id) {
        return toolText("Cannot link an entry to itself.");
      }

      // Verify both entries exist
      const { results: rows } = await env.DB.prepare(
        `SELECT id FROM entries WHERE id IN (?, ?)`
      ).bind(source_id, target_id).all();

      const foundIds = new Set((rows as Record<string, unknown>[]).map((r) => r.id as string));
      if (!foundIds.has(source_id)) return toolText(`Entry not found: ${source_id}`);
      if (!foundIds.has(target_id)) return toolText(`Entry not found: ${target_id}`);

      const now = Date.now();
      const stmt = env.DB.prepare(
        `INSERT OR REPLACE INTO edges (source_id, target_id, relation, weight, created_at) VALUES (?, ?, ?, 1.0, ?)`
      );

      await env.DB.batch([
        stmt.bind(source_id, target_id, relation, now),
        stmt.bind(target_id, source_id, relation, now),
      ]);

      return toolText(`Linked ${source_id} ↔ ${target_id} (${relation})`);
    }
  );

  // ── connections ──────────────────────────────────────────────────────────
  server.tool(
    "connections",
    "Show memories connected to a given entry in the knowledge graph.",
    {
      id: z.string().describe("Entry ID to explore connections for"),
      depth: z.number().int().min(1).max(MAX_CONNECTIONS_DEPTH).default(1).describe("How many hops to traverse (1 = direct, 2-3 = extended)"),
    },
    async ({ id, depth }) => {
      // Verify entry exists
      const entry = await env.DB.prepare(
        `SELECT id, content FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, unknown> | null;

      if (!entry) return toolText(`Entry not found: ${id}`);

      const conns = await getConnections(env, id, depth);

      if (!conns.length) {
        return toolText(`No connections found for entry ${id}.`);
      }

      const text = conns.map((c, i) => {
        const hopLabel = c.hop > 1 ? ` (${c.hop} hops away)` : "";
        return `${i + 1}. [${c.relation}, weight: ${c.weight.toFixed(2)}]${hopLabel}\n   ID: ${c.id}\n   ${c.content}`;
      }).join("\n\n");

      return toolText(`Connections for ${id} (depth ${depth}):\n\n${text}`);
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
    "Delete an entry from your second brain by ID. Also removes all graph connections.",
    { id: z.string().describe("Entry ID from recall or list_recent") },
    async ({ id }) => {
      const row = await env.DB.prepare(
        `SELECT vector_ids FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, unknown> | null;
      const trackedVectorIds = safeJsonArray(row?.vector_ids);

      // Delete entry from D1
      await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();

      // Cascade: delete all edges involving this entry
      let edgesDeleted = 0;
      try {
        const result = await env.DB.prepare(
          `DELETE FROM edges WHERE source_id = ? OR target_id = ?`
        ).bind(id, id).run();
        edgesDeleted = result.meta?.changes ?? 0;
      } catch (e) {
        console.error("Edge deletion failed (non-fatal):", e);
      }

      // Delete vectors from Vectorize
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

      return { content: [{ type: "text", text: `Deleted entry ${id}, ${trackedVectorIds.length} vector(s), and ${edgesDeleted} edge(s)` }] };
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

    // ── GET /health (no auth — for monitoring) ──
    if (url.pathname === "/health" && request.method === "GET") {
      const health: Record<string, unknown> = {
        version: "2.0.0",
        timestamp: new Date().toISOString(),
      };

      // Check D1 database
      try {
        await ensureDatabase(env);
        const { results } = await env.DB.prepare("SELECT COUNT(*) as count FROM entries").all();
        const entryCount = (results[0] as any)?.count ?? 0;

        const { results: edgeResults } = await env.DB.prepare("SELECT COUNT(*) as count FROM edges").all();
        const edgeCount = (edgeResults[0] as any)?.count ?? 0;

        health.database = { ok: true, entries_count: entryCount };
        health.graph = { ok: true, edges_count: edgeCount };
      } catch (e) {
        health.database = { ok: false, error: (e as Error).message };
        health.graph = { ok: false, error: "Database unavailable" };
      }

      // Check Vectorize index
      try {
        const testVec = new Array(1024).fill(0);
        testVec[0] = 1;
        await env.VECTORIZE.query(testVec, { topK: 1 });
        health.vectorize = { ok: true };
      } catch (e) {
        health.vectorize = { ok: false, error: (e as Error).message };
      }

      const dbOk = (health.database as any)?.ok === true;
      const vecOk = (health.vectorize as any)?.ok === true;

      health.status = dbOk && vecOk ? "healthy" : dbOk ? "degraded" : "error";

      return json(health, dbOk ? 200 : 503);
    }

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
        (async () => {
          try {
            await storeEntry(env, id, c, finalTags, s, now, dup.embedding);
            await autoLinkEntry(env, id, dup.embedding, now);
          } catch (e) {
            console.error("Async embed/link failed:", e);
          }
        })()
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
