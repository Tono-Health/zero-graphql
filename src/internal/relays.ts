import type { App } from "../app.ts";
import type { RouterShape } from "../procedure.ts";
import { compileRouter, type CompiledRouter } from "./compile.ts";
import { MAIN_RELAY } from "./token.ts";

export interface ResolvedRelay {
  readonly name: string;
  readonly app: App<any>;
  readonly compiled: CompiledRouter;
}

const NAME = /^[\w-]{1,64}$/;

/** The main relay plus the host's `relays` option, compiled once. */
export function resolveRelays(
  app: App<any>,
  router: RouterShape,
  extra: Readonly<Record<string, { readonly app: App<any>; readonly router: RouterShape }>> = {},
): ReadonlyMap<string, ResolvedRelay> {
  const relays = new Map<string, ResolvedRelay>();
  relays.set(MAIN_RELAY, { name: MAIN_RELAY, app, compiled: compileRouter(app, router) });
  for (const [name, def] of Object.entries(extra)) {
    if (name === MAIN_RELAY)
      throw new Error(`zero-relay: "${MAIN_RELAY}" is reserved for the main relay`);
    if (!NAME.test(name)) throw new Error(`zero-relay: invalid relay name "${name}"`);
    relays.set(name, { name, app: def.app, compiled: compileRouter(def.app, def.router) });
  }
  return relays;
}

export interface RelayContext {
  readonly scope: unknown;
  /** The partition's one user, in single-user partitions. */
  readonly user: unknown;
}

/** Runs the partition's `scope` (and `user`). Null means the relay may no longer sync. */
export async function loadContext(
  app: App<any>,
  key: string,
  env: unknown,
): Promise<RelayContext | null> {
  const scope = await app.config.partition.scope({ key, env });
  if (scope === null || scope === undefined) return null;
  return { scope, user: app.config.partition.user?.({ scope }) };
}
