-- One personal profile for the single-user application. Private keys never enter this table.
CREATE TABLE personal_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  user_id          TEXT NOT NULL,
  user_name        TEXT NOT NULL,
  passkey_rp_id    TEXT NOT NULL,
  credential_json  TEXT NOT NULL CHECK (json_valid(credential_json) AND json_type(credential_json) = 'object'),
  session_ttl_seconds INTEGER NOT NULL DEFAULT 43200 CHECK (session_ttl_seconds BETWEEN 1 AND 31536000),
  preferences_json TEXT NOT NULL DEFAULT '{"theme":"system","opaque":false,"motion":false,"ratio":0.2}' CHECK (
    json_valid(preferences_json) AND json_type(preferences_json) = 'object'
  ),
  preferences_revision INTEGER NOT NULL DEFAULT 0 CHECK (preferences_revision >= 0),
  revision         INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at       INTEGER NOT NULL
) STRICT;
