# Direct Execution Runtime repository contract

Current source ownership is [direct-execution-runtime in Agent Host](https://github.com/tetracoralla/agent-host-suite/tree/main/packages/direct-execution-runtime).
This repository retains historical source. Apply new implementation and release
work in Agent Host; the contract below describes this retained implementation.

Read `docs/PRODUCT_MODEL.md` and `docs/REVIEW_CONTRACT.md` before changing or
reviewing this runtime.

This repository owns host execution mechanics for already selected, structured,
read-only provider calls. It does not own domain Capability meaning, Procedure
method, natural-language routing, provider product behavior, or a model-facing
generic invocation tool.

- Keep the public surface as a library and explicit CLI. Do not add an MCP tool
  such as `invoke(provider, operation, opaqueInput)`.
- Contract projection is read-only host introspection after a provider and
  operation are selected. Keep it explicit and typed; never turn it into a
  model-facing execution indirection.
- Closed resolution may match one exact typed semantic target against explicit
  local bindings. Keep it config-backed, finite, point-in-time, and mechanical:
  no prose search, fuzzy match, ranking, winner selection, target invocation,
  or availability claim from a configured-file projection. A configured MCP
  projection envelope is not an observed operation identity; an unavailable
  live contract must remain unknown and must not be counted as an exact
  operation candidate. Do not widen the v0.1 Socket protocol without an
  explicit protocol revision.
- Validate every call against the selected provider-owned live schema or the
  exact schema whose digest is bound by the current Provider Manifest.
- Preserve provider result and error semantics. Host errors describe only
  admission, configuration, transport, timeout, cancellation, validation, and
  response-boundary failures.
- Keep work orders ephemeral unless a named repository consumer separately owns
  a versioned automation format and tests.
- The v0.1 runtime admits only read-only, non-destructive, closed-world provider
  operations. Do not generalize side-effect authorization without a current
  consumer and a separate effect contract.
- Bound queued plus executing work, whole-order input, provider responses, final
  output, deadlines, stderr, and adapter protocol lines. Cancellation must free
  admission and replace a poisoned session before recovery is claimed. One
  waiter leaving a shared MCP startup must not poison the startup for remaining
  waiters; the last abandoned startup waiter must still terminate the child.
- Do not persist local development checkout paths in tracked product config.
  Real-provider checks may construct temporary development bindings.
- Generated measurements are review observations under ignored `.verify/`;
  they do not prove universal savings, correctness, or production capacity.
- Preserve sibling repositories as read-only. Do not commit, push, publish,
  install globally, or deploy without explicit owner authorization.

Run `npm run check` for development regression and `npm run check:local-pilots`
for the maintainer pilots currently registered by source. Derive provider count
and identity from the current runner rather than this prose. Report installed-
host, performance/load, and owner business acceptance separately.
