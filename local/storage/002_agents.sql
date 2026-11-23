CREATE TABLE conversations_next (
  id                  TEXT PRIMARY KEY NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  agent_id            TEXT NOT NULL CHECK (agent_id IN ('codex', 'dsh', 'agy')),
  title               TEXT NOT NULL,
  provider_session_id TEXT,
  draft               TEXT NOT NULL DEFAULT '',
  updated_at          INTEGER NOT NULL,
  revision            INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
) STRICT;

INSERT INTO conversations_next SELECT * FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_next RENAME TO conversations;
CREATE INDEX conversations_project_agent_updated
  ON conversations(project_id, agent_id, updated_at DESC, id);
