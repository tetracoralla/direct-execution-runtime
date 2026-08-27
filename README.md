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
        | creates a typed work order
        v
Direct Execution Runtime (library, one-shot CLI, or local Unix Socket service)
        |
        | validates a pinned provider binding and domain schema
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
- persistent and per-call provider lifecycles;
- bounded fair admission, deadlines, cancellation, circuit breaking, session
  replacement, ordered correlation, and partial failure;
- complete request, provider-response, stderr, protocol-line, and result limits;
- a JavaScript library, one-shot CLI, and current-user-only Unix Socket service;
- optional owner-local metadata-only execution observations for Agent Tool
  Observer.

It deliberately has no natural-language parser, provider marketplace,
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
JSONL). Dependency Preflight is an unpublished local development pilot, not a
public dependency or advertised installation route. See
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
npm run check:local-pilots
npm run audit:production
```

`npm run check` covers source syntax, strict schemas, unit and adversarial
integration tests, legal inventory drift, repository invariants, and an
installed-tarball cold/warm service flow. `npm run check:local-pilots` is a
maintainer-only integration check: it uses the current sibling development
checkouts without modifying them and writes a current-run observation to
ignored `.verify/`. It is not required to build or use the public repository,
and its observation is not an SLA or a universal cost-savings claim.
Maintainers may explicitly set `OPENADAM_DIRECT_OBSERVATION_LOG` while running
the local pilot to emit the same privacy-bounded execution events for local
Agent Tool Observer ingestion; the variable is otherwise inactive.

The review boundary and source-release steps are documented in
`docs/REVIEW_CONTRACT.md` and `docs/RELEASE.md`.

## Security and license

Configured providers are trusted local programs running with the current user's
permissions; this project is not an operating-system sandbox. Keep credentials
out of provider configuration and work orders. See `SECURITY.md` for reporting
and the complete trust boundary.

Licensed under the Apache License, Version 2.0. See `LICENSE`, `NOTICE`, and
`THIRD_PARTY_NOTICES.md`.
