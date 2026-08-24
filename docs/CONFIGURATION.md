# Provider configuration

Provider configuration is explicit current-host state and should normally stay
outside source control.

For a Capability JSONL provider, configure its root, current v0.1 or v0.2
Provider Manifest, provider-owned execution identity files, and the input/output
schema files for each admitted operation. The runtime verifies schema digests
and, for v0.2, adapter-operation bindings before starting the adapter. It uses
the manifest's adapter command, arguments, and working-directory declaration.

For a Procedure JSONL provider, configure the external current Procedure
Profile plus the provider-contained implementation manifest and canonical
input/output schemas, together with provider-owned execution identity files.
The runtime verifies Procedure identity, read-only idempotent semantics, exact
stage-to-Capability alignment, contract digests, and execution identity before
startup.

For stdio MCP, configure the provider root, exact executable, working directory,
arguments, declared provider-owned identity files, expected live MCP server
name/version, and a closed allowlist of tools. The runtime binds those static
execution inputs and acquires the selected input/output schemas and safety
annotations from every live session.

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
