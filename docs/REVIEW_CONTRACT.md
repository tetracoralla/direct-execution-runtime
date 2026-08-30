# Review contract

Review current source and runtime; `.verify/`, old pilot output, and prior green
checks are only routes back to current facts. This contract records durable
host boundaries and reproduced high-risk sequences. It is minimum coverage,
not a feature inventory, fixed test script, or completion runway.

Before applying the named checks, reconstruct the current library, CLI, local
service protocol, provider transports, resolution surface, limits, and
failure/recovery states from source and runtime. Perform and report at least one
independent discovery route derived from that model rather than from this file,
test names, prior findings, or the changed-file list. Completing every item
below cannot by itself end the review.

## Durable invariants

1. **No model-facing generic invocation.** The product remains a library and
   explicit CLI/service for already selected structured calls. Contract
   projection and closed resolution are read-only, typed, and never exposed as
   fuzzy search, natural-language advice, winner selection, or target execution.
2. **One live contract.** Unknown fields, duplicate JSON keys, unknown targets,
   target/input-operation mismatch, and schema-invalid requests fail before
   execution. Capability and Procedure identities, complete Profile digests,
   manifests, adapter targets, schema digests, conditions, completion, and live
   MCP contracts agree before a call is admitted.
3. **Frozen execution identity.** Launched commands, arguments, working
   directories, provider-owned identity files, and live schemas are captured
   and revalidated. Executable and identity bytes run from verified private
   copies while the authorized business working directory remains the original
   provider root. Alternate path spelling or symlink repointing cannot bypass
   replacement detection.
4. **Read-only closed world.** v0.1 admits only non-destructive, idempotent,
   aggregate `openWorld: false` operations. Missing or legacy Procedure values
   are not assumed safe. MCP annotations are a veto in addition to the operator
   allowlist, never independent proof of effects.
5. **Whole-call bounds.** Admission accounts for queued plus executing work,
   round-robins work orders, and preserves order and correlation. One deadline
   includes queue time, provider startup, validation, execution, serialization,
   and cleanup. Request, stderr, protocol line, provider response, and complete
   result-envelope limits apply without semantic truncation.
6. **Cancellation and shared startup.** Queued and active cancellation release
   admission. One waiter leaving a shared MCP startup cannot poison remaining
   waiters; the last abandoned waiter closes a newly created client or
   transport even when the startup promise settles in the deadline turn.
7. **Error ownership.** Provider results and declared errors remain intact.
   Host errors describe only host boundaries. Capability retryability comes
   from the Profile. Unicode code-point message limits and serialized UTF-8 byte
   limits are both enforced at their owning layer.
8. **Session recovery and cleanup.** Repeated host failures open a per-provider
   circuit with one half-open recovery call. Provider errors and caller-selected
   short deadlines do not trip it. Timeout, replacement, protocol failure,
   stderr overflow, shutdown, and repeated/concurrent close leave no owned
   provider process, Socket inode, or launch staging after settlement.
9. **Local service protocol.** The current-user-only Unix Socket accepts one
   bounded strict newline-terminated request. It dispatches without waiting for
   EOF, rejects buffered or delayed extra requests, never opens a network
   listener, and does not silently widen the v0.1 protocol to resolution.
   Disconnect before a complete line starts no work; response-reader
   abandonment after transfer is not claimed as cancellation.
10. **Observation is metadata only.** The optional owner-only JSONL sink stores
    the closed v0.1 event with hashed execution identity, semantic/provider
    identity, state, timing, digests, session state, and numeric payload sizes.
    It contains no raw input, result, error message, or secret and cannot change
    provider execution when the sink fails.
11. **Resolution preserves uncertainty.** Exact configured targets and current
    live contracts remain distinct. Missing binding, unavailable startup,
    expected startup connection loss, post-initialization transport loss, and
    caller cancellation retain their stable meanings. Results are point-in-time
    and must be revalidated before execution.
12. **Caller-owned input is snapshotted safely.** Proxy, accessor, exotic
    prototype, sparse array, custom `toJSON`, cycle, excessive depth, invalid
    UTF-8, lone surrogate, and later caller mutation cannot execute user traps,
    alter the accepted request, or leak a native parser error.

## Reproduced high-risk sequences

Keep exact negative regressions for these failure families; tests own their
current fixture and command spelling.

- complete Capability/Procedure/Profile/manifest/schema/annotation drift,
  including missing or extra operation sets, conditional-stage activation, and
  required stages depending on optional stages;
- MCP catalog pagination across multiple pages and a non-advancing cursor;
  projected-operation lookup mismatch, oversized/malformed lookup, and one
  invalid item inside an otherwise valid native batch;
- overload, large-followed-by-small fairness, queued cancellation, active
  timeout, replacement, and ordinary recovery with final admission state empty;
- cold startup timeout, one cancelled shared-startup waiter, explicit
  replacement during startup, close during launch snapshot creation, and zero
  surviving child or private staging;
- stdout response racing concurrent stderr overflow, provider crash or malformed
  output, oversized provider/result envelopes, circuit open/half-open recovery,
  and clean next-generation reuse;
- Socket path canonicalization expansion, unsafe/duplicate/stale listener,
  incomplete line, duplicate key, extra line before or after dispatch,
  response-reader abandonment, shutdown, and exact owned-inode cleanup;
- configuration or identity mutation after preparation, alternate symlink
  spelling, missing restored executable, and recovery only after the original
  verified reference is restored;
- resolution result tampering, configured-versus-observed MCP identity,
  cancellation, startup versus initialized transport loss, and no target
  invocation during projection or resolution;
- complete input snapshot hostility and malformed provider bytes, followed by
  one ordinary successful call demonstrating bounded recovery.

## Validation lanes

- **Development regression:** `npm run check`, current schemas, repository and
  package invariants, unit/integration tests, and CLI behavior.
- **Runtime direct flow:** `npm run check:local-pilots` plus any focused pilot
  named by current source. Derive provider count, identities, versions, and
  paths from the runner output; use `OPENADAM_MATH_ANCHOR_ROOT` only as an
  explicit absolute checkout override when Math Anchor is not the sibling
  default. Do not freeze the current pilot inventory in this contract.
- **Performance/load/economics:** cold and warm calls, burst/fairness,
  cancellation/recovery, serialized bytes, process/RSS stability, after-close
  state, and the zero-model direct stage. Timing is a baseline unless a current
  workload and threshold define an SLO.
- **Packaged-host activation:** isolated package installation, config-backed
  resolution without target execution, separate service/client processes, cold
  then warm provider reuse, and clean shutdown.
- **Installed-host activation:** no global or login-startup installation is
  claimed unless it was actually performed and observed.
- **Runtime human flow:** diagnostic CLI only; no product UI is promised.
- **Business/experience acceptance:** owner judgment, separate from all lanes.

Every PASS names the current command or flow and observable. End with
`tools-dev workspace escalations`, including any Capability/Procedure drift,
installed-host conflict, adjacent provider dependency, or shared resource risk.
