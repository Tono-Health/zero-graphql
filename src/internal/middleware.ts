/** Runs middleware around `last`, in registration order (first registered is outermost). */
export function runMiddleware<TArgs, TResult>(
  hooks: readonly ((args: TArgs & { next: () => Promise<TResult> }) => Promise<TResult>)[],
  args: TArgs,
  last: () => Promise<TResult>,
): Promise<TResult> {
  const step = (i: number): Promise<TResult> =>
    i === hooks.length ? last() : hooks[i]!({ ...args, next: () => step(i + 1) });
  return step(0);
}
