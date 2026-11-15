// Small helpers shared by the test files.

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `condition` is true or `ms` has passed, and return whether it became true.
 * Prefer this to a fixed `wait()`: it is fast when things are fast and does not flake when a CI
 * runner is slow.
 */
export async function until(condition: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await wait(10);
  }
  return condition();
}
