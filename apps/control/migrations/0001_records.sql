-- The control plane's records: one table, a JSON object per row (see src/store.ts).
CREATE TABLE IF NOT EXISTS records (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, kind, id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS records_kind_updated ON records (kind, updated_at);

-- The lookups `listWhere` makes, so they do not read a whole kind.
CREATE INDEX IF NOT EXISTS records_workspaces_by_creator
  ON records (json_extract(data, '$.createdBy')) WHERE kind = 'workspaces';
CREATE INDEX IF NOT EXISTS records_workspaces_by_status
  ON records (json_extract(data, '$.status')) WHERE kind = 'workspaces';
CREATE INDEX IF NOT EXISTS records_members_by_account
  ON records (json_extract(data, '$.accountId')) WHERE kind = 'members';
CREATE INDEX IF NOT EXISTS records_members_by_workspace
  ON records (json_extract(data, '$.workspaceId')) WHERE kind = 'members';
CREATE INDEX IF NOT EXISTS records_invites_by_workspace
  ON records (json_extract(data, '$.workspaceId')) WHERE kind = 'invites';
