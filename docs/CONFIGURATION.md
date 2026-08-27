# Provider configuration

Provider configuration is explicit current-host state and should normally stay
outside source control.

Provider configuration uses `openadam.direct-provider-config.v0.2`.

For a Capability JSONL provider, configure its root, external current
Capability Profile v0.3, Provider Manifest v0.3, provider-owned execution
identity files, and input/output schema files for each admitted operation. The
runtime resolves Profile schemas, verifies the complete `profileDigest`, checks
configured and manifest schema digests, derives annotations from Profile
semantics, requires both manifest binding lists to exactly cover the Profile
operation set, and enforces its read-only idempotent closed-world boundary before
starting the adapter. It uses the manifest's adapter command, arguments, and
working-directory declaration. Legacy manifests are rejected because they do
not bind the complete Profile semantics.

For a Procedure JSONL provider, configure the external current Procedure
Profile plus the provider-contained implementation manifest and canonical
input/output schemas, together with provider-owned execution identity files.
The runtime requires Procedure Profile v0.5 and implementation manifest v0.5,
then verifies Procedure identity, complete Profile digest, read-only idempotent
semantics, conditional causal order and completion, rejects required
dependencies on conditional stages, verifies exact stage-to-Capability
alignment, contract digests, and execution identity before startup.
It requires aggregate `openWorld: false`; a v0.3/v0.4 Profile remains a
standards compatibility input but is insufficient for this closed-world host.

For stdio MCP, configure the provider root, exact executable, working directory,
arguments, declared provider-owned identity files, expected live MCP server
name/version, and a closed operator allowlist of tools. The runtime binds those
static execution inputs and reacquires the selected input/output schemas and
safety annotations from every live session. For raw MCP, annotations are a
runtime veto in addition to the operator allowlist, not an independently
verified Capability semantic claim.

An optional `operationProjections` entry declares a closed operation envelope
inside one allowed MCP tool. `toolName`, `operationField`, and `argumentsField`
must match the live envelope. The listed tool must expose either a discriminated
union or a closed operation enum together with `schemaLookup`. A schema lookup
explicitly binds a distinct allowed read-only tool, the field used to request
one operation, and the response path containing that operation's exact input
schema. The runtime invokes it only after the operation is selected, validates
its live response, and caches the resulting contract for that MCP session.
Calls use the explicit `mcp-operation` target and repeat the same operation id
in provider input. Optional `batchToolName` and `batchItemsField` bind a
distinct allowed native batch tool whose items use the same acquired operation
contracts. The runtime does not infer this mapping, auto-batch unrelated work,
or hide provider input and error semantics behind an opaque invocation API.

The MCP server identity is a transport observation; it is not automatically the
provider package or product release version. The runtime does not accept
environment overrides, secrets, shell commands, or
unlisted side-effecting tools in v0.1. Executables and referenced files must be
absolute, exist, and remain inside the configured provider root. A bare adapter
executable from a Capability or Procedure manifest is resolved through the
host's current safe PATH and included in binding diagnostics. Provider-owned
entry files and any other files needed to distinguish the runnable build must
be listed explicitly in `identityFiles`; the runtime does not infer them from
command arguments.

Configured provider executables are trusted local code and run with the host
user's ordinary filesystem and process permissions. These binding checks do
not create an operating-system sandbox or credential boundary. Deployments
that require isolation must supply it outside this runtime and must not place
secrets in provider configuration or work orders.

`examples/provider-config.example.json` is intentionally non-runnable. Copy it
to a local ignored location and replace every `/opt/provider/...` value with an
installed path. Do not commit machine-specific availability or credentials.

## Local service configuration

The service has no tracked configuration beyond the provider file and command
arguments. Supply an absolute Socket path under a pre-existing private
directory. The runtime rejects a parent directory that is not owned by and
accessible only to the current user. It also rejects a live
listener and will replace a stale Socket only when
`--replace-stale-socket` is present.

`--max-connections` bounds simultaneous client connections from 1 through
1024; the default is 64. Work admission remains separately bounded by the
limits in provider configuration. The service does not persist work orders,
results, credentials, or provider availability state.

## Optional execution observation

Pass `--observation-log /absolute/private/path/observations.jsonl` to a one-shot
config-backed `run` or to `serve`. Socket clients cannot override the serving
runtime's observation path. The runtime creates a missing parent with owner-only
permissions, rejects symlinks and insecure ownership/modes, and caps the file at
256 MiB. It appends one closed metadata event per completed/failed call and does
not persist work-order IDs, call IDs, inputs, results, or error messages.

For the local Agent Tool Observer default, use:

```text
~/Library/Application Support/OpenAdam/Direct Execution Runtime/observations.jsonl
```

Observation failure appears in `execution.observation` for a config-backed run;
it cannot change the provider call status or payload. Rotation/archival is an
explicit operator action because silently replacing the file could lose events
before a collector advances its cursor.
