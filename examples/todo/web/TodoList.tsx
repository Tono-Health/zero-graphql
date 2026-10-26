import { useState } from "react";
import { useMutation, useQuery } from "zero-relay/react";
import { api } from "./api.ts";

export function TodoList({ listID }: { listID: string }) {
  const [list, { status, error: queryError }] = useQuery(api.lists.get, { id: listID });
  const { mutate: add, pending, error: addError } = useMutation(api.todos.add);
  const { mutate: toggle, error: toggleError } = useMutation(api.todos.toggle);
  const [title, setTitle] = useState("");
  const mutationError = addError ?? toggleError;

  if (queryError) return <p role="alert">{queryError.message}</p>;
  if (!list) return status === "complete" ? <p>List not found.</p> : <p>Loading…</p>;

  const addTodo = async () => {
    const { error } = await add({ id: crypto.randomUUID(), listID, title });
    if (!error) setTitle("");
  };

  return (
    <section>
      <h1>{list.name}</h1>
      {mutationError && <p role="alert">{mutationError.message}</p>}
      <ul>
        {list.todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() => toggle({ id: todo.id, done: !todo.done })}
              />
              {todo.title}
            </label>
          </li>
        ))}
      </ul>
      <input value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
      <button disabled={pending || title === ""} onClick={addTodo}>
        Add
      </button>
    </section>
  );
}
