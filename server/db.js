import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })

export const db = new Database(config.databasePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    name TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    icon_url TEXT,
    connection_type TEXT NOT NULL DEFAULT 'server_url',
    auth_type TEXT NOT NULL DEFAULT 'oauth',
    connection_status TEXT NOT NULL DEFAULT 'pending',
    oauth_authorize_url TEXT,
    oauth_token_url TEXT,
    oauth_client_id TEXT,
    oauth_client_secret TEXT,
    oauth_scope TEXT,
    oauth_access_token TEXT,
    oauth_refresh_token TEXT,
    oauth_expires_at TEXT,
    transport TEXT NOT NULL DEFAULT 'stdio',
    command TEXT,
    url TEXT,
    env_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mcp_oauth_states (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    code_verifier TEXT,
    redirect_uri TEXT,
    resource TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mcp_tools (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    input_schema_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (mcp_server_id, name)
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    instructions TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instruction TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    raw_usage_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS live_chat_shares (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    allowed_origin TEXT,
    icon_url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS live_chat_sessions (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES live_chat_shares(id) ON DELETE CASCADE,
    visitor_key TEXT NOT NULL,
    page_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS live_chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES live_chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS website_sources (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    page_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS website_pages (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES website_sources(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS website_pages_fts USING fts5(
    page_id UNINDEXED,
    source_id UNINDEXED,
    user_id UNINDEXED,
    url UNINDEXED,
    title,
    content
  );

  CREATE INDEX IF NOT EXISTS idx_token_usage_user_created_at
    ON token_usage (user_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_token_usage_conversation
    ON token_usage (conversation_id);

  CREATE INDEX IF NOT EXISTS idx_mcp_tools_server
    ON mcp_tools (mcp_server_id);

  CREATE INDEX IF NOT EXISTS idx_live_chat_sessions_share
    ON live_chat_sessions (share_id, updated_at);

  CREATE INDEX IF NOT EXISTS idx_live_chat_messages_session
    ON live_chat_messages (session_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_website_sources_user
    ON website_sources (user_id, enabled, updated_at);

  CREATE INDEX IF NOT EXISTS idx_website_pages_source
    ON website_pages (source_id, user_id);
`)

ensureColumn('mcp_servers', 'description', 'TEXT')
ensureColumn('mcp_servers', 'icon_url', 'TEXT')
ensureColumn('mcp_servers', 'connection_type', "TEXT NOT NULL DEFAULT 'server_url'")
ensureColumn('mcp_servers', 'auth_type', "TEXT NOT NULL DEFAULT 'oauth'")
ensureColumn('mcp_servers', 'connection_status', "TEXT NOT NULL DEFAULT 'pending'")
ensureColumn('mcp_servers', 'oauth_authorize_url', 'TEXT')
ensureColumn('mcp_servers', 'oauth_token_url', 'TEXT')
ensureColumn('mcp_servers', 'oauth_client_id', 'TEXT')
ensureColumn('mcp_servers', 'oauth_client_secret', 'TEXT')
ensureColumn('mcp_servers', 'oauth_scope', 'TEXT')
ensureColumn('mcp_servers', 'oauth_access_token', 'TEXT')
ensureColumn('mcp_servers', 'oauth_refresh_token', 'TEXT')
ensureColumn('mcp_servers', 'oauth_expires_at', 'TEXT')
ensureColumn('mcp_oauth_states', 'code_verifier', 'TEXT')
ensureColumn('mcp_oauth_states', 'redirect_uri', 'TEXT')
ensureColumn('mcp_oauth_states', 'resource', 'TEXT')
ensureColumn('skills', 'description', 'TEXT')
ensureColumn('live_chat_shares', 'icon_url', 'TEXT')
ensureColumn('website_sources', 'status', "TEXT NOT NULL DEFAULT 'pending'")
ensureColumn('website_sources', 'page_count', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('website_sources', 'error', 'TEXT')
ensureColumn('website_sources', 'enabled', 'INTEGER NOT NULL DEFAULT 1')

export function upsertUser(user) {
  db.prepare(`
    INSERT INTO users (id, email, name, avatar_url)
    VALUES (@id, @email, @name, @avatar_url)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      avatar_url = excluded.avatar_url,
      updated_at = CURRENT_TIMESTAMP
  `).run(user)
}

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((field) => field.name === column)
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
