import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { useQuery } from "zero-relay/react";
import { api } from "../todo/web/api.ts";
import { TodoList } from "../todo/web/TodoList.tsx";

function App() {
  const [lists = []] = useQuery(api.lists.mine);
  const [listID, setListID] = useState<string>();

  return (
    <main>
      <nav>
        {lists.map((list) => (
          <button
            key={list.id}
            aria-pressed={list.id === listID}
            onClick={() => setListID(list.id)}
          >
            {list.name}
          </button>
        ))}
      </nav>
      {listID ? <TodoList listID={listID} /> : <p>Pick a list.</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
