# Source map

The package exports five entry points. Endpoint authors use the app and procedure APIs; the host adapter owns transport and deployment details.

| Entry           | Responsibility                                                                  |
| --------------- | ------------------------------------------------------------------------------- |
| `index.ts`      | App configuration, procedure builders, partitions, middleware, and error types. |
| `client.ts`     | Typed router proxy and public browser client types.                             |
| `react.ts`      | Query subscriptions and mutation state for React.                               |
| `server.ts`     | Fetch handlers for Zero's query and mutation requests.                          |
| `cloudflare.ts` | Worker routing, authentication on upgrade, and Durable Object lifecycle.        |

The other top-level modules define the app's public vocabulary: procedures, partitions, errors, audit events, and shared types.

## Internal implementation

| Module                                                             | Responsibility                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `internal/connection.ts`                                           | Browser sockets, subscriptions, reconnects, pending calls, and visibility handling.         |
| `internal/protocol.ts`                                             | Wire messages, validation, and WebSocket close codes; shared by browser and server.         |
| `internal/compile.ts`                                              | Compile procedures into Zero query/mutator registries and enforce their schemas and guards. |
| `internal/middleware.ts`                                           | Run asynchronous middleware in registration order, around the handler.                      |
| `internal/relays.ts`                                               | Resolve named relay definitions and load partition context.                                 |
| `internal/relay/contracts.ts`                                      | The socket, Zero client, and lifecycle interfaces between a relay and its host.             |
| `internal/relay/runtime.ts`                                        | One partition's Zero session, connections, subscriptions, mutations, expiry, and refresh.   |
| `internal/relay/views.ts`                                          | Share and batch Zero views, project output, and apply subscription transformations.         |
| `internal/cloudflare/`                                             | Binding-backed WebSocket transport and Durable Object SQLite storage.                       |
| `internal/standard.ts`, `session.ts`, `token.ts`, `wire-errors.ts` | Schema validation, session deadlines, relay identity, and safe error transport.             |

## Boundaries

- Browser runtime code depends only on the connection implementation, protocol, and errors. Imports of procedure and app types are erased; Zero, Effect, and host adapters stay out of the browser bundle.
- The relay runtime receives sockets and a `createZero` factory from its host. It does not import Cloudflare APIs. Keep host storage and transport implementations in the adapter's directory.
- Query/mutation compilation is shared by the relay and server endpoints so both enforce the same procedure definitions. Relay middleware wraps browser operations; mutation middleware wraps Zero's transaction execution.
- Keep resource ownership together in `relay/runtime.ts`: its Effect scopes release connections, shared views, and the Zero session. View projection and pure helpers live separately because they do not own that lifecycle.
- Internal modules are not package exports. Cloudflare is currently the only recommended host and the only implemented adapter. The next path for every non-Cloudflare host is Node.js + Rivet, using the same adapter across providers. Exercise these contracts with that adapter before making them a public API. See [hosting](../docs/hosting.md) for the remaining work.

Run `vp check`, `vp test`, and `vp run build` from the repository root. The tests exercise public client behavior, compiled procedures, the relay with a fake Zero client, and Cloudflare adapter boundaries.
