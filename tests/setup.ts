// Preloaded by `bun test` (see bunfig.toml), before any test file is loaded.
//
// Stubs the one browser API the app's state modules use outside a browser. Under `bun test`,
// solid-js resolves to its server build, where signals are plain getter/setter pairs. That is
// what these tests want: they read state, not the DOM.
(globalThis as unknown as { requestAnimationFrame: (callback: () => void) => unknown }).requestAnimationFrame = (
  callback,
) => setTimeout(callback, 0);
