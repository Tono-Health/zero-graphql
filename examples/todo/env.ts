/** What app code (`authenticate`, `partition.scope`) reads. Each host's env extends this. */
export interface Env {
  readonly SESSION_SECRET: string;
  /** Local development connects directly; deployed Workers go through Hyperdrive. */
  readonly DATABASE_URL?: string;
  readonly HYPERDRIVE?: { readonly connectionString: string };
}

export function databaseURL(env: Env): string {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error("Bind HYPERDRIVE or set DATABASE_URL");
  return url;
}
