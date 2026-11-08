# kernels

## State machines W2: kernels-web-face (`core/js/web.ts`)

- `loadKernels`: a load from another source (by identity) during a load in flight is refused, no source joins it, and loaded stays final. The last failure is kept and named by the "not loaded" error. Module-level wrappers go through `api()`, so before a load they say to load first instead of failing inside the glue. `loadKernelsSync` still throws during an async load (documented).
- `serveKernels`: no latch; each request loads if not loaded, so a failed load is retried. A request the worker cannot deserialize gets an id-less `{ok:false}`.
- `KernelWorker`: a failed `postMessage` drops its entry; `messageerror` and a reply without a numeric id reject everything in flight; new `close(reason?)` rejects in-flight and later calls. `KernelPort.addEventListener` takes `'message' | 'messageerror'`.
- `envMap` reads the variant from the result and throws on a wrong length (unreachable without a diverged wasm build; pinned by review).
- `SceneCamera.#s()`: the scratch-view rule is a comment; a memory-growth regression case guards it.
- Tests: `core/crates/wasm-web/tests/{load,worker-rpc}.test.ts`, run by `npm run test:kernels-web` (so by `check:tests`).
- Deviation: the growth case projects 3,999,999 floats, not 4M, because `projectMany` takes whole xyz triples.
