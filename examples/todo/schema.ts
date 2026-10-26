import { boolean, createSchema, number, relationships, string, table } from "@rocicorp/zero";

const list = table("list")
  .columns({
    id: string(),
    ownerID: string().from("owner_id"),
    name: string(),
  })
  .primaryKey("id");

const listMember = table("listMember")
  .from("list_member")
  .columns({
    listID: string().from("list_id"),
    userID: string().from("user_id"),
  })
  .primaryKey("listID", "userID");

const todo = table("todo")
  .columns({
    id: string(),
    listID: string().from("list_id"),
    title: string(),
    done: boolean(),
    createdAt: number().from("created_at"),
  })
  .primaryKey("id");

const listRelationships = relationships(list, ({ many }) => ({
  todos: many({ sourceField: ["id"], destField: ["listID"], destSchema: todo }),
  members: many({ sourceField: ["id"], destField: ["listID"], destSchema: listMember }),
}));

const todoRelationships = relationships(todo, ({ one }) => ({
  list: one({ sourceField: ["listID"], destField: ["id"], destSchema: list }),
}));

export const schema = createSchema({
  tables: [list, listMember, todo],
  relationships: [listRelationships, todoRelationships],
  enableLegacyQueries: false,
  enableLegacyMutators: false,
});
