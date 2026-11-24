CREATE TABLE schema_migrations (
  version       INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at    INTEGER NOT NULL,
  legacy_digest TEXT
) STRICT;

CREATE TABLE projects (
  id         TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL,
  cwd        TEXT NOT NULL UNIQUE,
  position   INTEGER NOT NULL UNIQUE CHECK (position >= 0)
) STRICT;

CREATE TABLE conversations (
  id                  TEXT PRIMARY KEY NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id            TEXT NOT NULL CHECK (agent_id IN ('codex', 'dsh')),
  title               TEXT NOT NULL,
  provider_session_id TEXT,
  draft               TEXT NOT NULL DEFAULT '',
  updated_at          INTEGER NOT NULL,
  revision            INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
) STRICT;

CREATE INDEX conversations_project_agent_updated
  ON conversations(project_id, agent_id, updated_at DESC, id);

CREATE TABLE messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  id              TEXT NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  kind            TEXT NOT NULL CHECK (
    kind IN ('user', 'assistant', 'thought', 'tool', 'plan', 'notice', 'error', 'event')
  ),
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK (json_type(payload_json) = 'object'
         AND json_type(payload_json, '$.text') IS 'text'),
  PRIMARY KEY (conversation_id, id),
  UNIQUE (conversation_id, ordinal)
) STRICT;
