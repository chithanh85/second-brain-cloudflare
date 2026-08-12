-- Run with: wrangler d1 execute second-brain-db --file=schema.sql

CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array
  source      TEXT NOT NULL DEFAULT 'api', -- 'phone', 'browser', 'voice', 'claude', 'api'
  created_at  INTEGER NOT NULL,            -- Unix ms timestamp
  vector_ids  TEXT NOT NULL DEFAULT '[]'   -- JSON array of Vectorize IDs
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);

-- Memory Graph: bidirectional edges between entries
CREATE TABLE IF NOT EXISTS edges (
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  relation    TEXT NOT NULL DEFAULT 'related',  -- 'related', 'extends', 'contradicts', 'depends_on'
  weight      REAL NOT NULL DEFAULT 1.0,        -- Edge strength (0.0 - 1.0)
  created_at  INTEGER NOT NULL,                 -- Unix ms timestamp
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
