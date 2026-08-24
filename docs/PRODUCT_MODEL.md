# Product model

## User and task

The direct user is an Agent host, local automation, or developer that already
knows the exact provider operation and has structured input. Its task is to hand
that closed work to a reliable execution layer once, instead of asking a model
to rediscover the provider and reinterpret every intermediate result.

The human-facing surface is intentionally a narrow diagnostic CLI. There is no
chat surface or product UI in this phase.

## Layer boundary

The runtime is host infrastructure:

- Capability Profiles and provider-native typed tools own domain input, output,
  exactness, warnings, and stable domain errors.
- Procedure Profiles own settled multi-stage professional method.
- This runtime owns current binding, schema acquisition, admission, process or
  session reuse, deadline, cancellation, recovery, and bounded result delivery.
- An Agent or another router remains responsible for unresolved intent,
  judgment, presentation, and external authorization.

Transport grouping of independent calls does not create a Capability or a
Procedure. The runtime does not expose a generic model-facing tool.

## Closed work order

`openadam.direct-work-order.v0.1` contains an id and ordered independent calls.
Each call selects either:

- a specific Capability id, version, and operation whose provider manifest and
  input/output schema digests are verified; or
- a specific Procedure id and version whose current Profile, implementation
  manifest, stage bindings, adapter entry, and contract digests agree; or
- a specific MCP tool whose input and output schemas are reacquired from the
  live session.

The outer work-order schema cannot describe every domain input. The runtime
therefore treats `input` as provisionally carried data only until it validates
that value against the selected operation schema before execution. This format
is an internal host boundary, not an Agent catalog.

One-shot work orders and results are ephemeral. A repository may track a
repeatable automation only when a named consumer owns its schema, validation,
freshness, migration, and tests. A settled dependent graph should reference a
Procedure instead of embedding arbitrary natural-language stages here.

## Host carriers

The same runtime can be used as a library, a one-shot CLI process, or a local
Unix Socket service. The service exists so separate host clients can reuse one
bounded runtime and its provider sessions. It is an operator-managed current
host process, not an Agent shell modification and not an MCP server.

The Socket protocol accepts exactly one strict JSON request and returns exactly
one strict JSON response per connection. Only `inspect`, `validate`, and `run`
are admitted. The Socket parent must be owned by and accessible only to the
current user; the created Socket is mode `0600`. An incomplete request has a
bounded receive deadline. A client
disconnect cancels its owned run. Graceful shutdown cancels all owned work,
closes provider sessions, and removes only the Socket inode created by the
service.

## Provider configuration

Provider configuration is current host state. It explicitly points at one
installed or development provider root and never becomes a portable semantic
claim.

Capability JSONL bindings are accepted only when a current Provider Manifest
v0.1 or v0.2, selected implementation, operation annotations, contract schema
files, declared digests, and provider-owned execution identity files agree. A
v0.2 manifest must also bind every configured operation to the JSONL adapter.
Procedure JSONL bindings additionally require exact Profile and
implementation-stage alignment plus explicit execution identity files. MCP
binding identity includes the executable, arguments, working directory, and
declared provider-owned identity files, then reacquires selected tools and
schemas after every session replacement. v0.1 admits only read-only,
non-destructive, idempotent, closed-world execution.

These are host binding checks and runtime observations, not Capability L0/L1
conformance or installed-package proof. A spawned JSONL process is reported as
unprobed until a correlated response is actually observed; an MCP schema listing
establishes only the live contract that was acquired.

Tracked product files contain examples, never this machine's live checkout
paths, credentials, or availability state.

## Execution and failure semantics

The runtime preserves input order and call ids. Independent calls may execute
concurrently. Admission is bounded and keeps FIFO order within each work order
while rotating queued work orders so a single large order cannot monopolize the
host. Each call returns `ok`, `provider_error`, or `host_error`. A provider
error remains provider-owned. A host error is limited to this runtime's own
configuration, validation, admission, transport, timeout, cancellation,
protocol, or output-boundary failure.

There is no automatic retry in v0.1. A timed out or cancelled JSONL session is
terminated because that protocol has no per-call cancellation. An MCP request
uses protocol cancellation and the session is replaced after ambiguous
transport failure. Later recovery is verified with a new ordinary call.
Other calls pending on a terminated JSONL session receive
`HOST_PROVIDER_REPLACED`, never a false claim that their own caller cancelled
them. v0.1 does not retry those calls automatically.

Repeated host-level provider failures open a bounded per-provider circuit.
After cooldown, only one half-open call probes recovery. Provider-owned domain
errors and caller-selected short deadlines do not open the shared circuit, and
a successful provider response closes it.

Request bytes, call count, queued plus executing calls, provider response bytes,
stderr, protocol lines, and the complete returned envelope are bounded. If a
read-only call completes but its result cannot fit, the host returns an explicit
output-limit error rather than truncating semantic data.

## Cost boundary

The runtime invokes no model, so its own execution stage records zero model
calls. Token use and money outside the runtime remain `null`/unobserved. Cold
Agent, cold direct, warm direct, and native provider batch are separate routes;
one cannot be converted into a universal savings percentage from a single
provider or machine.

## Non-goals

- natural-language understanding or provider selection;
- a model-facing `invoke(provider, operation, opaqueInput)` tool;
- provider discovery marketplace, installation, or credential vault;
- an operating-system sandbox for trusted local provider executables;
- a universal readiness Capability or universal provider error taxonomy;
- dependency graphs, arbitrary workflows, or a new Procedure language;
- side-effecting provider authorization;
- UI, daemon auto-start, network service, npm publication, or deployment.
