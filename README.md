# Direct Execution Runtime

Direct Execution Runtime is a local, host-owned execution layer for work that
an Agent or automation has already reduced to closed structured provider calls.
It validates those calls, keeps eligible provider processes and MCP sessions
warm, applies host limits, and returns ordered correlated results without
asking a model to reinterpret each step.

It is the bounded host-execution component of the
[Agent-Host Execution Architecture](https://github.com/tetracoralla/agent-host-execution-architecture),
whose other layers remain independently adoptable repositories.

The runtime does not replace or patch an Agent shell. The layers stay separate:

```text
Agent shell or automation
        |
        | closes a semantic requirement or creates a typed work order
        v
Direct Execution Runtime (library, one-shot CLI, or local Unix Socket service)
        |
        | resolves exact local candidates or validates a pinned binding and domain schema
        v
Capability / Procedure / MCP provider
```

An Agent shell owns conversation, intent, judgment, and presentation. Its
harness configuration may teach it when to create a work order. This runtime
owns only deterministic host execution after that decision. Provider contracts
continue to own domain meaning.

## Scope

The current v0.1 slice supports:

- Capability Profile v0.3 plus Provider Manifest v0.3-bound
  `openadam.capability-jsonl.v0.1` sessions;
- Profile-and-implementation-bound `openadam.procedure-jsonl.v0.2` sessions;
- live-schema-bound stdio MCP sessions;
- operation-level live MCP contract projection after an operation is selected,
  from either a listed discriminated union or an explicitly bound read-only
  schema lookup tool,
  including declared native-batch item validation;
- config-backed resolution of one already-closed typed requirement into a
  finite list of local configured matches and separately counted exact
  candidates, with point-in-time contract checks and explicit ineligible or
  unknown outcomes;
- persistent and per-call provider lifecycles;
- bounded fair admission, deadlines, cancellation, circuit breaking, session
  replacement, ordered correlation, and partial failure;
- complete request, provider-response, stderr, protocol-line, and result limits;
- trap-free ordinary-data snapshots at every JavaScript library boundary,
  strict fatal UTF-8 decoding and duplicate-key rejection across CLI, Socket,
  JSONL, and MCP stdio JSON, plus a finite 256-level nesting ceiling;
- a JavaScript library, one-shot CLI, and current-user-only Unix Socket service;
- optional owner-local metadata-only execution observations for Agent Tool
  Observer.

It deliberately has no natural-language parser, provider registry or marketplace,
credential store, model-facing generic `invoke` tool, arbitrary workflow
language, or side-effect authorization layer.

## Provider identity

Providers remain independent products and repositories. Direct Execution
Runtime does not copy their source, rename them, or publish them as part of this
project. Public documentation uses each provider's public product name together
with a short role description; configuration uses its stable provider,
Capability, Procedure, or MCP identifiers.

The current public integration pilots are Math Anchor (deterministic
mathematics over MCP) and Migratory Time (time-zone conversion over Capability
JSONL). Dependency Preflight and Structured Data Preflight are unpublished
local development pilots, not public dependencies or advertised installation
routes. See
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for the exact boundary.

## Requirements and installation

- Node.js 22.12 or newer;
- a Unix-like host for the local Socket service;
- explicitly installed provider executables and current provider contracts.

For development or a source installation:

```sh
npm ci
npm run check
```

The package remains marked `private` to prevent accidental npm publication.
That does not restrict an Apache-2.0 GitHub source release. `npm pack` produces
an installable tarball and `npm run check:package` verifies that tarball in an
isolated consumer directory.

## Public five-minute path

The smallest real-provider walkthrough uses the public
[Math Anchor](https://github.com/tetracoralla/math-anchor) MCP provider. After
installing both repositories' dependencies, run:

```sh
npm run demo:math-anchor -- --provider-root /absolute/path/to/math-anchor
```

It prints one current JSON observation containing an exact result, a
provider-owned error, a host-side schema rejection, and separate first-call and
persistent-session timings. It invokes no model, writes no report, and does not
claim that an unmeasured Agent route saved tokens. See
[`docs/PUBLIC_DEMO.md`](docs/PUBLIC_DEMO.md) for the complete clone-to-run path
and interpretation boundary.

## Provider configuration

Provider configuration is current-machine state and normally stays outside
source control. Copy `examples/provider-config.example.json` into an ignored
local location, then replace its placeholder paths with absolute paths to the
installed providers. See `docs/CONFIGURATION.md` for the binding rules.

## One-shot execution

One-shot mode starts and closes its own runtime:

```sh
openadam-direct-exec inspect --config /absolute/path/providers.local.json
openadam-direct-exec resolve --config /absolute/path/providers.local.json --requirement resolution.json
openadam-direct-exec project --config /absolute/path/providers.local.json --selection selection.json
openadam-direct-exec validate --config /absolute/path/providers.local.json --work-order request.json
openadam-direct-exec run --config /absolute/path/providers.local.json --work-order request.json
```

Use `--work-order -` to read one work order from stdin. Output is one compact
JSON object on stdout. Work orders and results are not written to the repository.
To emit privacy-bounded operational metadata, add an absolute owner-local path:

```sh
openadam-direct-exec run \
  --config /absolute/path/providers.local.json \
  --work-order request.json \
  --observation-log "$HOME/Library/Application Support/OpenAdam/Direct Execution Runtime/observations.jsonl"
```

`resolve` is optional Host infrastructure for callers that have already chosen
an exact Capability, Procedure, MCP tool, or projected MCP operation. Its closed
request can require one contract digest and schema-byte ceiling. It never
searches by prose, scores provider quality, expands the catalog, or calls the
selected target operation. It returns only configured target matches, marks and
counts exact identities separately, and includes the existing `project`
selection needed for later task-scoped contract exposure.
For projected MCP operations, a configured projection-envelope match is
reported separately and becomes exact only after the current live contract
exposes that operation identity.

For Capability and Procedure JSONL, resolution rechecks the configured contract
but deliberately does not start the provider process; execution availability is
therefore `not_observed`. For MCP it starts a bounded contract session and
reacquires the selected live contract, but does not invoke the selected target;
that is not a successful-call observation. Startup or transport uncertainty
stays `unknown`, while exact contract or Host-boundary mismatches are
`ineligible`. If a projected-operation contract is unavailable, its configured
envelope remains visible but `semanticIdentity` is `not_observed` and
`exactCandidates` does not increase. Startup connection loss is returned as a
retryable Host unavailable observation; connection loss after initialization is
a retryable Host transport observation. Every result is point-in-time and says
that reuse requires revalidation. It does not establish business correctness,
credentials, hidden OS permissions, future availability, or Agent adoption.

Library resolution snapshots the caller's closed request before asynchronous
projection. Later caller mutation cannot change a returned candidate or
selection, and caller cancellation terminates the complete resolution instead
of becoming a provider eligibility result.
The exported `validateResolutionResult` function applies both the public
structural schema and runtime-owned cross-field relations: request, candidate,
selection, provider, counts, exactness, and status precedence must agree.

Resolution is config-backed only in v0.1. The existing Socket protocol remains
unchanged rather than silently gaining a new action.

## Persistent local service

For repeated calls, start one operator-managed service in a directory owned and
writable only by the current user:

```sh
runtime_dir="$(mktemp -d)"
chmod 700 "$runtime_dir"
openadam-direct-exec serve \
  --config /absolute/path/providers.local.json \
  --socket "$runtime_dir/direct-exec.sock" \
  --observation-log "$HOME/Library/Application Support/OpenAdam/Direct Execution Runtime/observations.jsonl"
```

The first stdout line is a structured readiness observation. Separate client
processes can then reuse the provider sessions:

```sh
openadam-direct-exec inspect --socket "$runtime_dir/direct-exec.sock"
openadam-direct-exec project --socket "$runtime_dir/direct-exec.sock" --selection selection.json
openadam-direct-exec run --socket "$runtime_dir/direct-exec.sock" --work-order request.json
```

Stop the service with `SIGINT` or `SIGTERM`. It cancels owned work, closes
provider processes, and removes only the Socket it created. The service refuses
an insecure parent directory, an active second listener, or a stale Socket
unless replacement is explicitly requested. It has no network listener and no
automatic login/startup installation.

The optional observation log is a bounded owner-only JSONL file. Each
`openadam.direct-execution-observation.v0.1` event contains hashed work-order and
call identity, semantic target/provider identity, state, timing, payload byte
counts, cold/warm session state, and binding digests. It never contains work
order IDs, call IDs, inputs, results, or error messages. Observation failure is
reported in the direct result but cannot change provider execution semantics.
The log has a 256 MiB ceiling and stops accepting new observations at that
boundary; an operator must archive or replace it deliberately.

## Controller evaluation adapter

`openadam-direct-evals-driver` implements the separately versioned
`agent-tool-evals` direct-host v0.1 protocol. Its command arguments pin one
provider, observed provider version, target binding digest, target kind, and
operation. It is a Controller-only adapter, not a model-facing catalog or
generic invoke tool. See `docs/EVALS_DRIVER.md`.

## Verification

```sh
npm run check
npm run check:schema-parity
npm run check:local-pilots
npm run check:structured-data-procedure
npm run audit:production
```

`npm run check` covers source syntax, strict schemas, unit and adversarial
integration tests, legal inventory drift, repository invariants, and an
installed-tarball config-backed resolution plus cold/warm service flow.
`npm run check:schema-parity` is the separable byte-for-byte comparison of the
seven bundled compatibility schemas with their sibling development sources.
`npm run check:local-pilots` is a
maintainer-only integration check: it uses the current sibling development
checkouts without modifying them and writes a current-run observation to
ignored `.verify/`. It is not required to build or use the public repository,
and its observation is not an SLA or a universal cost-savings claim.
If a required sibling provider checkout such as Calculator/Math Anchor is
absent, the command reports the schema comparison separately and exits with
the provider pilot explicitly `not_run`; it never aggregates that state into a
PASS.
Maintainers may explicitly set `OPENADAM_DIRECT_OBSERVATION_LOG` while running
the local pilot to emit the same privacy-bounded execution events for local
Agent Tool Observer ingestion; the variable is otherwise inactive.

`npm run check:structured-data-procedure` is the narrower Procedure vertical
slice. It rebuilds Structured Data Preflight and BatchTicket wheels plus the
File Vitals Capability adapter into a temporary directory, binds
`org.openadam.structured-data.preflight@0.3.0`, and checks both completion
branches, stable failures, mixed partial results, cancellation/recovery, the
whole-call timeout, the provider-response limit, and current cold/warm direct
timings. The generated compatibility manifest changes only the concrete
packaged adapter command; the Procedure identity, Profile digest, stage
bindings, and result schemas remain the current declarations. Its ignored
observation is a current development
measurement, not an installed-host, Agent-adoption, portability, or SLO claim.
The Python adapter code is imported from those rebuilt wheels, while its
third-party dependencies still come from the sibling development runtimes;
this check is not a clean-host dependency installation.

The review boundary and source-release steps are documented in
`docs/REVIEW_CONTRACT.md` and `docs/RELEASE.md`.

## Security and license

Configured providers are trusted local programs running with the current user's
permissions; this project is not an operating-system sandbox. Keep credentials
out of provider configuration and work orders. See `SECURITY.md` for reporting
and the complete trust boundary.

Licensed under the Apache License, Version 2.0. See `LICENSE`, `NOTICE`, and
`THIRD_PARTY_NOTICES.md`.
