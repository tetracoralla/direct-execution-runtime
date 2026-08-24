# Review contract

Review current source and runtime; do not inherit `.verify/` observations as a
current verdict.

## Invariants

1. No model-facing generic invoke tool or MCP server exists.
2. Unknown fields, duplicate JSON keys, unknown providers, unknown operations,
   and schema-invalid inputs fail before the selected operation executes.
3. Capability schema digests match the selected current Provider Manifest;
   Procedure Profile identity, implementation stages, adapter entry, and schema
   digests agree; MCP execution identity covers arguments, working directory,
   provider-owned identity files, and the live schemas reacquired after every
   replacement.
4. v0.1 accepts only read-only, non-destructive, idempotent, closed-world
   operations.
5. Bounded admission accounts for queued and executing work, preserves FIFO
   within a work order, and round-robins queued work orders; overload is a
   stable host error and cannot grow memory without bound.
6. The whole call deadline includes queue time. Queued and running cancellation
   release admission, and a poisoned session is replaced before reuse.
7. Correlation and input order survive concurrency and partial provider/host
   failure.
8. Provider errors and results are preserved; host errors do not claim portable
   domain meaning.
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
    network listener.
15. Separate client processes reuse eligible provider sessions; a disconnected
    client cancels its run, shutdown closes owned providers, and cleanup removes
    only the Socket inode created by this service.

## Adversarial sequences

- duplicate call id or duplicate JSON key;
- manifest/provider/capability/version/schema-digest drift;
- Procedure Profile/version/stage/implementation-manifest/adapter-entry drift;
- MCP argument, working-directory, identity-file, or live-contract drift;
- unknown Capability operation or unlisted MCP tool;
- live MCP schema rejects an extra or wrong-typed argument;
- queue burst beyond executing plus queued capacity;
- one large queued work order followed by a small independent work order;
- queued cancellation followed by an ordinary successful call;
- JSONL timeout terminates the process, then a new session recovers;
- MCP timeout/cancellation followed by session replacement and recovery;
- provider exits, emits malformed/oversized JSONL, or floods stderr;
- repeated host failures open the circuit, then one half-open call recovers;
- cold MCP startup timeout and runtime close leave no owned process;
- provider error between successful calls while result order remains input order;
- provider result or complete work-order result exceeds its byte ceiling.
- insecure Socket directory, active duplicate listener, non-Socket path, and
  stale Socket without explicit replacement;
- duplicate JSON key, extra request, oversized request, or mismatched response
  identity at the host protocol boundary;
- client disconnect during a provider call, followed by an ordinary successful
  call from a new client;
- service shutdown followed by zero owned provider processes and no owned
  Socket path.

## Validation lanes

- development regression: syntax, schemas, unit/integration tests, repository
  invariants, and CLI behavior;
- runtime direct flow: current three-provider development pilot through live
  Math Anchor MCP, Migratory Time Capability JSONL, and Dependency Preflight
  Procedure JSONL, plus a short-lived Dependency Preflight Capability check;
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
