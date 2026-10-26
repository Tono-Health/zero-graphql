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

INSERT INTO list (id, owner_id, name) VALUES
  ('groceries', 'alice', 'Groceries'),
  ('work', 'bob', 'Work'),
  ('trip', 'bob', 'Trip'),
  ('big', 'carol', 'Big');


-- alice can see bob's trip list, but not his work list.
INSERT INTO list_member (list_id, user_id) VALUES ('trip', 'alice');

INSERT INTO todo (id, list_id, title, done, created_at) VALUES
  ('g1', 'groceries', 'Milk', false, 1),
  ('g2', 'groceries', 'Eggs', true, 2),
  ('w1', 'work', 'Ship it', false, 1),
  ('t1', 'trip', 'Book flights', false, 1);

-- What `loadUser` reads. Deleting a row revokes that user's relay on its next refresh.
CREATE TABLE app_user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

INSERT INTO app_user (id, name) VALUES
  ('alice', 'Alice'),
  ('bob', 'Bob'),
  ('carol', 'Carol');
