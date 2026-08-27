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
   replacement.
4. The direct boundary accepts only read-only, non-destructive, idempotent,
   closed-world operations. Procedure admission requires aggregate
   `openWorld: false`; an older Profile or missing value is unsafe. Raw MCP
   additionally requires the operator's closed
   allowlist; live annotations are a veto, not proof of effect safety.
5. Bounded admission accounts for queued and executing work, preserves FIFO
   within a work order, and round-robins queued work orders; overload is a
   stable host error and cannot grow memory without bound.
6. The whole call deadline includes queue time. Queued and running cancellation
   release admission, and a poisoned session is replaced before reuse.
7. Correlation and input order survive concurrency and partial provider/host
   failure.
8. Provider errors and results are preserved; host errors do not claim portable
   domain meaning. Capability JSONL errors accept only exact `{code,message}`
   or `{code,message,retryable}` forms, and the Profile owns the returned
   retryability.
9. Complete request, raw provider response, stderr/protocol line, and final
   result envelopes are bounded without semantic truncation.
10. Repeated host failures open a per-provider circuit; only one half-open
    recovery call proceeds, while provider-owned errors do not trip it.
11. Closing or replacing the runtime terminates the owned provider processes;
    startup timeout and stderr overflow cannot leave a reusable poisoned child.
12. One-shot work orders, results, and measurements are not tracked normative
    repository inputs.
13. Provider processes remain trusted host-user code; binding validation is not
    represented as operating-system isolation or secret containment.
14. The local host service uses an absolute current-user-only Unix Socket,
    accepts one bounded strict request per connection, and never opens a
    network listener. Its read-only `project` action returns one selected
    contract and cannot execute a provider.
15. Separate client processes reuse eligible provider sessions; a disconnected
    client cancels its run, shutdown closes owned providers, and cleanup removes
    only the Socket inode created by this service.
16. Optional observation writes only the closed v0.1 metadata event to an
    absolute owner-only regular file. It contains no raw IDs, work order, input,
    result, or error message; it preserves zero model calls and null external
    token/money cost. Sink failure is visible and cannot change execution.
17. Observation storage is capped at 256 MiB. Symlink, insecure ownership/mode,
    invalid parent, and full-log cases fail the observation sink without
    altering provider results.

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
- live MCP schema rejects an extra or wrong-typed argument;
- queue burst beyond executing plus queued capacity;
- one large queued work order followed by a small independent work order;
- queued cancellation followed by an ordinary successful call;
- JSONL timeout terminates the process, then a new session recovers;
- MCP timeout/cancellation followed by session replacement and recovery;
- provider exits, emits malformed/oversized JSONL, or floods stderr;
- repeated host failures open the circuit, then one half-open call recovers;
- cold MCP startup timeout and runtime close leave no owned process;
- provider errors with and without a matching `retryable` echo between
  successful calls while result order remains input order;
- provider result or complete work-order result exceeds its byte ceiling.
- insecure Socket directory, active duplicate listener, non-Socket path, and
  stale Socket without explicit replacement;
- duplicate JSON key, extra request, oversized request, or mismatched response
  identity at the host protocol boundary;
- client disconnect during a provider call, followed by an ordinary successful
  call from a new client;
- service shutdown followed by zero owned provider processes and no owned
  Socket path.
- observation success, privacy projection, sink failure, insecure/symlink log,
  and full-log boundary while provider execution remains unchanged.

## Validation lanes

- development regression: syntax, schemas, unit/integration tests, repository
  invariants, and CLI behavior;
- runtime direct flow: current three-provider development pilot through live
  Math Anchor MCP, Migratory Time Capability JSONL, and Dependency Preflight
  Procedure JSONL, plus a short-lived Dependency Preflight Capability check and
  both branches of Structured Data Preflight's conditional Procedure;
- performance/load/economics: separate cold, warm, burst, cancellation/recovery,
  bytes, process/resource observations including after-close state, and
  zero-model runtime stage;
- packaged-host activation: isolated tarball installation, separate service
  and client processes, cold then warm provider session, and clean shutdown;
- installed-host activation: no global or login-startup installation is claimed;
- runtime human flow: diagnostic CLI only; no product UI is promised;
- business/experience acceptance: owner judgment, pending.

Every PASS must name the current command and observable. Timing observations are
not an SLO without a declared workload and threshold.
