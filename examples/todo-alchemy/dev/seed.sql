-- Demo rows for a fresh local database. Applied once, when the Postgres container
-- is first created. Tables come from migrations/0001_init.sql.

INSERT INTO list (id, owner_id, name) VALUES
  ('groceries', 'alice', 'Groceries'),
  ('work', 'bob', 'Work'),
  ('trip', 'bob', 'Trip');

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
  ('bob', 'Bob');
