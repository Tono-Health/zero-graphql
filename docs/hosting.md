# Hosting the relay

**Cloudflare is currently the only recommended hosting platform. For every other host, the planned path is Node.js + Rivet.**

The architecture has two deployment paths:

| Deployment          | Runtime and ownership                                           | Status                                                                                     |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Cloudflare**      | Cloudflare Workers with one Durable Object per relay partition. | Adapter implemented and tested locally; production deployment validation is still pending. |
| **Everywhere else** | Node.js with one Rivet Actor per relay partition.               | Next planned adapter; implementation and end-to-end validation still required.             |

Rivet is the actor infrastructure for non-Cloudflare deployments, not another hosting provider in a shortlist. The same Node.js + Rivet adapter should work across infrastructure providers. The current examples use Cloudflare; the Node.js + Rivet integration is not implemented yet.

## Cloudflare: current recommendation

Each relay partition owns a Zero client, its replica, shared live queries, and the browsers subscribed to them. Durable Objects give that partition a globally unique instance with storage, while Cloudflare handles routing and lifecycle management. This directly fits the relay's ownership model. [Cloudflare's model](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

The `cloudflare()` adapter supplies the Worker endpoints and Durable Object implementation. Configure it once in [`worker.ts`](../examples/todo/worker.ts); feature routers and React components stay independent of the host.

Postgres remains the source of truth. The relay can use memory or Durable Object SQLite for its replica. Postgres and zero-cache also need hosting; see the [todo example](../examples/todo) and [Alchemy example](../examples/todo-alchemy) for the existing local setup.

Active relays keep an outbound Zero connection and scheduled refresh/expiry work, which prevent Durable Object hibernation. The runtime releases Zero after the last browser leaves and the idle timeout expires. [Lifecycle requirements](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

The adapter is implemented and tested locally. Remaining deployment validation includes shared partitions, the binding-backed connection to zero-cache, replica persistence across restarts, and long-lived resource usage. See the [design roadmap](design.md#14-roadmap) for current coverage and remaining work.

## Everywhere else: Node.js + Rivet (next)

Run the relay on Node.js and use Rivet Actors for stable actor addresses, placement, lifecycle management, and HTTP/WebSocket routing. Map one actor to each relay partition. Rivet's control plane can be managed or self-hosted; the relay adapter stays the same across infrastructure providers. [Architecture](https://rivet.dev/docs/architecture/)

Implement one Node.js + Rivet adapter for this path and verify raw WebSocket/subprotocol handling, authentication, invalidation routing, and Zero startup and shutdown. Actor sleep must be coordinated with the active Zero client; replica persistence can be evaluated separately. [Lifecycle](https://rivet.dev/actors/docs/lifecycle/)

Validate the integration end to end with real Zero replication, mutations, shared partitions, reconnects, and restart behavior before recommending it for deployment. Endpoint definitions and React hooks should stay the same across hosts.

## Shared adapter boundary

The internal [host contracts](../src/internal/relay/contracts.ts) separate runtime behavior from deployment. Hosts supply sockets, a Zero factory, partition routing, and lifecycle management. The fetch-compatible `createEndpoints()` export handles Zero's query and mutation HTTP requests; it does not supply the WebSocket server or partition ownership.

Keep this boundary internal until both the Cloudflare and Node.js + Rivet adapters have exercised it. Feature routers and React components should remain independent of host infrastructure.
