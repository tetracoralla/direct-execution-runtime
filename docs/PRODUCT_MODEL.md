# Product model

## User and task

The direct user is an Agent host, local automation, or developer that already
knows either the exact semantic target or the exact provider operation and has
structured input. Its task is to resolve that closed requirement against
explicit local bindings or hand closed work to a reliable execution layer,
instead of asking a model to rediscover the provider and reinterpret every
intermediate result.

The human-facing surface is intentionally a narrow diagnostic CLI. There is no
chat surface or product UI in this phase.

## Layer boundary

The runtime is host infrastructure:

- Capability Profiles and provider-native typed tools own domain input, output,
  exactness, warnings, and stable domain errors.
- Procedure Profiles own settled multi-stage professional method.
- This runtime owns configured candidate matching, current exact-identity
  observation where required, schema acquisition, admission, process or
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
  live session; or
- a specific operation inside a declared closed MCP operation envelope. The
  exact selected contract comes from either its listed discriminated branch or
  an explicitly bound read-only schema lookup tool. The work order carries both
  the public tool name and operation id, while provider input repeats the same
  operation id and is validated against only that live contract.

The outer work-order schema cannot describe every domain input. The runtime
therefore treats `input` as provisionally carried data only until it validates
that value against the selected operation schema before execution. This format
is an internal host boundary, not an Agent catalog.

One-shot work orders and results are ephemeral. A repository may track a
repeatable automation only when a named consumer owns its schema, validation,
freshness, migration, and tests. A settled dependent graph should reference a
Procedure instead of embedding arbitrary natural-language stages here.

## Closed requirement resolution

`openadam.direct-resolution-request.v0.1` carries one exact Capability
operation, Procedure, MCP tool, or projected MCP operation plus the fixed
read-only, local-process boundary. Optional constraints pin one contract digest,
cap contract schema bytes, or shorten the configured projection deadline. It
contains no prose query, tags, preferences, score weights, or open-ended policy.

The runtime checks only configured bindings that can carry the requested exact
semantic identity. For Capability, Procedure, and raw MCP tools, configuration
names that identity directly. For a projected MCP operation, configuration
names only the closed projection envelope; the operation identity becomes exact
only after the current live contract exposes it. The result therefore reports
configured matches separately from exact candidates and marks an unavailable
projected operation identity `not_observed`. It returns mechanical constraint
states, a point-in-time projection observation, and closed selection
coordinates for a later `project` call. It omits unrelated providers and full
schemas. It does not choose a winner, infer a near match, or invoke the selected
target operation.

Capability and Procedure JSONL projections come from already-validated
configured files and do not start their adapter, so execution availability is
not observed. MCP resolution starts a bounded session and reacquires the live
selected contract; this observes a contract session, not a successful target
call. Exact contract/Host-boundary failures are `ineligible`. Startup,
transport, or other unavailable observations remain `unknown`; startup
connection loss is a retryable Host unavailable observation, not an internal
failure, while a connection loss after initialization is a retryable Host
transport observation. An unavailable projected envelope remains a configured
match but is not counted as an exact operation candidate. All results are
point-in-time and require revalidation before reuse; they do not establish
credentials, hidden OS permissions, future availability, domain correctness,
quality, or adoption.

## Host carriers

The same runtime can be used as a library, a one-shot CLI process, or a local
Unix Socket service. The service exists so separate host clients can reuse one
bounded runtime and its provider sessions. It is an operator-managed current
host process, not an Agent shell modification and not an MCP server.

The Socket protocol accepts exactly one strict newline-terminated JSON request
and returns exactly one strict newline-terminated JSON response per connection.
A complete request line starts processing without waiting for client EOF so
installed clients may keep their write side open while awaiting the response.
Trailing bytes already buffered after that line are rejected before dispatch.
If additional bytes arrive after a read-only operation has started, the service
cancels that operation and waits for its runtime admission and provider cleanup
to settle before returning `HOST_PROTOCOL_ERROR`; this prevents the rejected
connection from racing the next ordinary client, but does not claim the first
read-only operation never began. Only `inspect`, `project`, `validate`, and
`run` are admitted. `project` returns one already-selected typed contract; it
never invokes the selected target operation and is not exposed as an Agent tool.
Live contract projection (`project`, `validate`, and closed resolution over
projected operations) may start a bounded contract session and, for a compact
projected envelope, may call only the explicitly bound read-only schema-lookup
tool to acquire the selected input schema. These projection interactions are
bounded by the service connection limit, whole-operation deadlines, and
response byte limits; unlike `run` calls they are not admitted through the
work-order admission controller and do not advance provider circuits. The Socket parent
must be owned by and accessible only to the current user; the created Socket is
mode `0600`. Both the requested path and the path reconstructed from the
canonical parent are checked against the platform's UTF-8 byte limit before
listening. An incomplete request has a bounded receive deadline and cannot start
work. Once a complete newline-terminated request line has been accepted, later
abandonment of the response-reading side is not a reliable Unix Socket
cancellation signal; that transferred run may finish and its eligible warm
provider session may be reused.
Graceful service shutdown still cancels all owned work, closes provider sessions,
and removes only the Socket inode created by the service. Host error-message
length follows JSON Schema Unicode code-point semantics; the complete response
envelope remains independently bounded by serialized UTF-8 bytes.

Closed resolution is library and config-backed CLI functionality in v0.1. It is
not added to the v0.1 Socket action set; a service form requires an explicit
protocol revision and compatibility route.

The library accepts an optional observation sink, and the CLI/service expose an
explicit absolute `--observation-log` path. Observation is operational metadata,
not a fourth execution carrier and not a semantic source. It records hashed
work-order/call identity, the already-selected semantic target and provider,
terminal state, stable error code, timing, serialized input/result byte counts,
session state, and binding digests. It does not retain work orders, inputs,
results, or error messages. Sink failure is visible but never changes provider
execution or result semantics.

## Provider configuration

Provider configuration is current host state. It explicitly points at one
installed or development provider root and never becomes a portable semantic
claim.

Capability JSONL bindings are accepted only when a current Capability Profile
v0.3, Provider Manifest v0.3, selected implementation, complete Profile digest,
semantics-derived operation annotations, contract schema files, declared
digests, complete public and adapter operation sets, and provider-owned
execution identity files agree. A host configuration may select a safe subset
for execution, but the Provider Manifest itself must still bind every operation
in the selected Profile.
Procedure JSONL bindings require Procedure Profile v0.5, implementation
manifest v0.5, complete Profile digest, conditional causal/completion validity,
exact stage alignment, no required dependency on an optional stage, and
explicit execution identity files. MCP
binding identity includes the executable, arguments, working directory, and
declared provider-owned identity files, then reacquires selected tools and
schemas after every session replacement. Live catalog acquisition follows the
provider's declared pagination until every allowed tool is found or the bounded
catalog terminates, and a catalog whose pagination does not advance fails
closed before any tool is admitted. An operator may additionally declare
one closed MCP operation envelope as operation-projectable and bind one native
batch tool to the same item envelope. A compact envelope may additionally bind
a distinct allowed read-only schema lookup tool and the exact response path for
one operation input schema. The runtime then compiles only selected operation
contracts, requires the target and input operation ids to agree, and validates
each native batch item against its own contract before execution. v0.1
admits only read-only,
non-destructive, idempotent, closed-world execution. Procedure admission also
requires aggregate `openWorld: false`; a legacy omission is not a safe default.

Capability and Procedure Profile digests bind semantic fields and stable errors
as well as schemas. Manifest annotations cannot weaken Capability semantics.
Raw MCP tools remain provider-native bindings: their explicit operator
allowlist and live annotations are policy inputs, not Capability conformance or
proof that effects cannot occur.

Immediately before spawn, the Host copies the resolved command and declared
identity files into one private per-session execution view and verifies their
prepared digests while copying. Actual launch uses that frozen command;
identity-file arguments — classified once at binding preparation by their
symlink-resolved target and rewritten from that record rather than by
launch-time spelling — and PATH-resolved declared executables are redirected
to their frozen copies. The canonical configured working directory stays on the
original authorized provider root, and request values are not path-rewritten.
This separates fixed provider execution bytes from business input paths. A warm
session can continue after its source identity file is replaced, while a new
cold session fails current-source revalidation until the declared identity is
restored; an identity argument whose reference no longer resolves to the
recorded declared identity fails that same revalidation.

The execution view is not a sandbox or a complete filesystem snapshot.
Undeclared imports, interpreter binaries and libraries, adjacent package-loader
content, operating-system state, and provider workspace data remain trusted
dependencies outside the binding digest. They must not be described as frozen,
isolated, or proven merely because declared identities were staged.

At the Capability JSONL v0.1 boundary, provider errors have exact fields
`{code,message}` or `{code,message,retryable}`. Retryability belongs to the
bound Capability Profile. The runtime accepts an older adapter that omits the
echo, rejects a conflicting echo or any extra field, and always returns the
Profile-derived value to its caller.

The runtime does not repair semantic version drift. A cataloged Capability or
Procedure identity is immutable; changed effects, errors, causal order, or
completion enter under a new semantic version and the host configuration moves
explicitly. Process reuse, scheduling, fairness, cancellation, and other
implementation improvements may evolve without a semantic version change only
when the selected contract remains conserved.

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
During shared persistent MCP startup, cancellation or timeout releases only
that caller's wait while another admitted caller still depends on the same
startup. If every startup waiter has left, the runtime terminates the child;
an actual replacement remains a retryable `HOST_PROVIDER_REPLACED` observation
for any collateral caller, never provider unavailability fabricated by another
caller's cancellation.
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

Calling `close()` atomically moves the runtime to `closing`: new admissions and
sessions fail closed, the runtime-owned cancellation signal reaches queued and
active work, and provider shutdown begins only after every admitted library
operation has settled. Repeated close calls share that terminal lifecycle. A
session close invalidates startup ownership and awaits any in-flight launch
snapshot creation and disposal before it resolves. A resolved runtime close
therefore leaves neither a runtime-owned live provider process nor a private
launch-staging directory, and later work is rejected as `HOST_RUNTIME_CLOSED`.

## Cost boundary

The runtime invokes no model, so its own execution stage records zero model
calls. Token use and money outside the runtime remain `null`/unobserved. Cold
Agent, cold direct, warm direct, and native provider batch are separate routes;
one cannot be converted into a universal savings percentage from a single
provider or machine.

An optional execution observation preserves the same zero-model/null-external-
cost boundary and adds only numeric payload sizes and runtime timing. Agent Tool
Observer can aggregate these events, but neither component allocates an Agent
turn's token use or monetary cost to one direct call.

Contract projection and closed resolution can reduce host-side acquisition and
validation after a semantic target has been selected. They do not retroactively
reduce the initial tool catalog already supplied by an Agent shell. Shells that
do not expose a public dynamic-schema hook continue to receive the provider's
compact ordinary MCP catalog.

## Non-goals

- natural-language understanding, fuzzy matching, provider ranking, or winner selection;
- a model-facing `invoke(provider, operation, opaqueInput)` tool;
- provider discovery marketplace, installation, or credential vault;
- an operating-system sandbox for trusted local provider executables;
- a universal readiness Capability or universal provider error taxonomy;
- dependency graphs, arbitrary workflows, or a new Procedure language;
- side-effecting provider authorization;
- UI, daemon auto-start, network service, npm publication, or deployment.
