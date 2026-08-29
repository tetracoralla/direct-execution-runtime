# Review contract

Review current source and runtime; do not inherit `.verify/` observations as a
current verdict.

## Invariants

1. No model-facing generic invoke tool or MCP server exists.
2. Unknown fields, duplicate JSON keys, unknown providers, unknown operations,
   and schema-invalid inputs fail before the selected operation executes.
   A projected MCP target and its repeated input operation must agree; only the
   selected listed branch or declared schema-lookup result is compiled, and
   native batch items are checked contract by contract before execution.
3. Capability Profile identity, complete Profile digest, semantics-derived
   annotations, schema digests, and complete Provider Manifest v0.3 public and
   adapter operation sets agree; Procedure
   Profile v0.5 identity, complete Profile digest, conditional stage/completion
   graph, implementation stages, adapter entry, and schema digests agree; MCP
   execution identity covers arguments, working directory,
   provider-owned identity files, and the live schemas reacquired after every
   replacement. The launched command and declared execution references —
   classified by their preparation-time symlink-resolved target, not by
   launch-time spelling — use verified private copies, while the original
   canonical working directory
   and work-order paths remain outside that execution view.
4. The direct boundary accepts only read-only, non-destructive, idempotent,
   closed-world operations. Procedure admission requires aggregate
   `openWorld: false`; an older Profile or missing value is unsafe. Raw MCP
   additionally requires the operator's closed
   allowlist; live annotations are a veto, not proof of effect safety.
5. Bounded admission accounts for queued and executing work, preserves FIFO
   within a work order, and round-robins queued work orders; overload is a
   stable host error and cannot grow memory without bound.
6. The whole call deadline includes queue time. Queued and running cancellation
   release admission, and a poisoned session is replaced before reuse. A
   cancelled or expired waiter cannot close a shared MCP startup while another
   admitted waiter still depends on it; the last abandoned waiter still closes
   the owned child.
7. Correlation and input order survive concurrency and partial provider/host
   failure.
8. Provider errors and results are preserved; host errors do not claim portable
   domain meaning. Capability JSONL errors accept only exact `{code,message}`
   or `{code,message,retryable}` forms, and the Profile owns the returned
   retryability.
9. Complete request, raw provider response, stderr/protocol line, and final
   result envelopes are bounded without semantic truncation. Host error-message
   `minLength`/`maxLength` uses Unicode code points exactly as the published JSON
   Schema does, while the complete serialized response retains its UTF-8 byte
   ceiling.
10. Repeated host failures open a per-provider circuit; only one half-open
    recovery call proceeds, while provider-owned errors do not trip it.
11. Closing or replacing the runtime terminates the owned provider processes;
    startup timeout and stderr overflow cannot leave a reusable poisoned child.
    Close also waits for launch-snapshot creation that began before startup
    ownership was revoked, and resolves only after its private staging is gone.
12. One-shot work orders, results, and measurements are not tracked normative
    repository inputs.
13. Provider processes remain trusted host-user code; binding validation is not
    represented as operating-system isolation or secret containment. Undeclared
    imports, interpreter and dynamic-library chains, adjacent loader content,
    and workspace data remain outside the declared fixed-byte identity.
14. The local host service uses an absolute current-user-only Unix Socket,
    accepts one bounded strict request per connection, and never opens a
    network listener. Its read-only `project` action returns one selected
    contract, never invokes the selected target operation, and for a projected
    operation may call only the explicitly bound read-only schema-lookup tool.
    Projection, validation, and resolution live contract acquisition is bounded
    by the service connection limit, operation deadlines, and response byte
    limits rather than the work-order admission controller or provider
    circuits. The requested Socket path is checked
    again after canonicalizing its parent; canonicalization cannot expand it
    past the platform UTF-8 byte limit and defer failure to `listen`.
15. Separate client processes reuse eligible provider sessions. The service
    dispatches only after request EOF; pre-EOF disconnect cannot start work.
    After complete-request transfer, abandonment of the response-reading side
    is not claimed as cancellation. Shutdown closes owned providers, and
    cleanup removes only the Socket inode created by this service.
16. Optional observation writes only the closed v0.1 metadata event to an
    absolute owner-only regular file. It contains no raw IDs, work order, input,
    result, or error message; it preserves zero model calls and null external
    token/money cost. Sink failure is visible and cannot change execution.
17. Observation storage is capped at 256 MiB. Symlink, insecure ownership/mode,
    invalid parent, and full-log cases fail the observation sink without
    altering provider results.
18. Closed resolution accepts only an exact typed target and fixed read-only,
    local-process constraints. It distinguishes a configured projected-MCP
    envelope from an operation identity observed in the current live contract,
    counts only observed identities as exact operation candidates, omits full
    schemas and unrelated provider identities, invokes no selected target
    operation, and exposes no fuzzy score or natural-language advice.
    The library snapshots caller-owned request state before validation or
    projection so later caller mutation cannot alter a returned candidate or
    contract selection.
19. Resolution separates deterministic contract rejection from unavailable or
    uncertain projection. Configured-file projection does not claim process
    availability; live MCP projection claims only a contract session. Every
    result is point-in-time and requires revalidation before reuse. Caller
    cancellation terminates the complete resolution as `HOST_CANCELLED`; it is
    never converted into provider uncertainty or eligibility. Expected MCP
    startup connection loss is a retryable Host unavailable observation, not
    `HOST_INTERNAL`; connection loss after initialization is a retryable Host
    transport observation.
20. The v0.1 Socket protocol does not accept resolution. Config-backed library
    and CLI support must not silently widen the separately versioned service
    protocol.

## Adversarial sequences

- duplicate call id or duplicate JSON key;
- manifest/provider/capability/version/Profile-digest/schema-digest/annotation
  drift, including incomplete or extra manifest operation sets;
- Procedure Profile/version/digest/condition/completion/stage/implementation-manifest/adapter-entry
  drift, including a required stage depending on an optional stage;
- MCP argument, working-directory, identity-file, or live-contract drift;
- unknown Capability operation or unlisted MCP tool;
- unknown projected MCP operation, target/input operation mismatch, malformed,
  rejected, or oversized schema-lookup response, and a schema-invalid item
  inside an otherwise valid native batch;
- a native batch tool that is itself an operation projection target is
  rejected at configuration time;
- live MCP schema rejects an extra or wrong-typed argument;
- MCP catalog pages: allowed tools spread across declared pagination pages
  still bind and execute, while a catalog whose pagination cursor never
  advances fails closed before any tool is admitted;
- queue burst beyond executing plus queued capacity;
- one large queued work order followed by a small independent work order;
- queued cancellation followed by an ordinary successful call;
- JSONL timeout terminates the process, then a new session recovers;
- MCP timeout/cancellation followed by session replacement and recovery;
- provider exits, emits malformed/oversized JSONL, or floods stderr;
- repeated host failures open the circuit, then one half-open call recovers;
- cold MCP startup timeout and runtime close leave no owned process;
- close during JSONL and MCP launch-snapshot creation waits for the cancelled
  startup to settle and leaves neither private staging nor an owned child;
- one waiter cancels during shared persistent MCP startup while the other
  completes without false provider-unavailable attribution;
- explicit replacement during shared MCP startup gives every collateral waiter
  retryable `HOST_PROVIDER_REPLACED`, then a new cold session recovers;
- provider errors with and without a matching `retryable` echo between
  successful calls while result order remains input order;
- provider result or complete work-order result exceeds its byte ceiling.
- insecure Socket directory, active duplicate listener, non-Socket path, and
  stale Socket without explicit replacement; a requested path within the byte
  limit whose canonical parent expands past it must fail as `HOST_CONFIG_INVALID`
  before listening;
- duplicate JSON key, extra request, oversized request, or mismatched response
  identity at the host protocol boundary;
- a 600-emoji Host error message is accepted by both schema and runtime, a
  1004-code-point message is rejected by both, and either remains subject to the
  complete serialized UTF-8 response budget;
- incomplete request disconnect without hidden work; response-reader
  abandonment after complete-request EOF followed by an ordinary successful
  call from a new client, with bounded admission and reusable provider state;
- service shutdown followed by zero owned provider processes and no owned
  Socket path.
- observation success, privacy projection, sink failure, insecure/symlink log,
  and full-log boundary while provider execution remains unchanged.
- two exact Capability providers remain two candidates without starting either
  adapter; unrelated configured providers and full schemas stay absent;
- exact digest and schema-byte constraints allow or reject mechanically;
- two live MCP contracts with the same tool name remain distinguishable by
  digest while the target tool is never invoked;
- missing exact binding returns a bounded empty result, and provider startup
  failure remains `unknown` rather than becoming an eligibility verdict;
- caller mutation after dispatch cannot alter the request snapshot or returned
  contract selection, and pre-start or in-flight cancellation terminates the
  complete resolution as `HOST_CANCELLED`;
- a projected MCP operation absent from the live contract is not counted or
  reported as an exact semantic candidate;
- a projected MCP envelope whose live contract is unavailable remains unknown,
  reports its operation identity as not observed, and is not counted exact;
- ordinary and projected MCP startup connection loss use the stable retryable
  Host unavailable error rather than an internal error;
- post-initialization MCP catalog connection loss uses the stable retryable
  Host transport error;
- invalid resolution fields and attempted Socket resolution fail closed.
- root and nested Proxy, accessor, hidden/symbol property, exotic prototype,
  sparse array, custom `toJSON`, cycle, depth, and lone-surrogate inputs reach
  no user-code trap and cannot change after the library call captures them;
- mutate source configuration arguments or an execution identity file after
  preparation, then require a frozen registry and `HOST_PROVIDER_REPLACED`
  before any new provider process starts; after an actual session snapshot,
  remove a declared executable and require the warm session to keep using its
  verified copy, a replacement cold start to fail, and restoration to recover;
- reference an identity file through a symlink or other alternate spelling in
  a declared argument: the warm session keeps reading frozen bytes after the
  link is repointed, the drifted reference fails closed as
  `HOST_PROVIDER_REPLACED` before any new provider process starts, and
  restoring the reference recovers cold;
- run a real relative workspace-path Procedure while its command and declared
  PATH executables use private staged bytes; require the business cwd to remain
  the original authorized provider root and reject any staging symlink as a
  substitute for that input root;
- alter a structurally valid resolution result so provider/selection/target,
  summary counts, exactness, or status precedence disagree, and require
  `validateResolutionResult` to reject it;
- call close with one active and one queued call, call close concurrently and
  repeatedly, then require both calls settled, admission empty, no live pid,
  and post-close work rejected;
- feed an invalid UTF-8 byte and a 5000-level JSON value through public parsing
  routes, then malformed UTF-8 and duplicate keys through a live MCP stdio
  response; all must return stable Host errors rather than accepting U+FFFD,
  taking the last duplicate key, or leaking a native `RangeError`.

## Validation lanes

- development regression: syntax, schemas, unit/integration tests, repository
  invariants, and CLI behavior;
- runtime direct flow: current three-provider development pilot through live
  Math Anchor MCP, Migratory Time Capability JSONL, and Dependency Preflight
  Procedure JSONL, plus a short-lived Dependency Preflight Capability check and
  both branches of Structured Data Preflight's conditional Procedure; the
  targeted Structured Data Preflight check additionally rebuilds temporary
  packaged adapters and covers stable provider/host failures, mixed partial
  results, cancellation and timeout recovery, and provider-response budget
  recovery;
- performance/load/economics: separate cold, warm, burst, cancellation/recovery,
  bytes, process/resource observations including after-close state, and
  zero-model runtime stage;
- packaged-host activation: isolated tarball installation, config-backed exact
  resolution without target execution, separate service and client processes,
  cold then warm provider session, and clean shutdown;
- installed-host activation: no global or login-startup installation is claimed;
- runtime human flow: diagnostic CLI only; no product UI is promised;
- business/experience acceptance: owner judgment, pending.

Every PASS must name the current command and observable. Timing observations are
not an SLO without a declared workload and threshold.
