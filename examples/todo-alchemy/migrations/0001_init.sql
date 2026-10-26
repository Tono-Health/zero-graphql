CREATE TABLE list (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE list_member (
  list_id TEXT NOT NULL REFERENCES list (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (list_id, user_id)
);

CREATE TABLE todo (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES list (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DOUBLE PRECISION NOT NULL
);

CREATE INDEX list_owner_idx ON list (owner_id);
CREATE INDEX list_member_user_idx ON list_member (user_id);
CREATE INDEX todo_list_idx ON todo (list_id, created_at);
