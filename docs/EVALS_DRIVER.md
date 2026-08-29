# Agent Tool Evals adapter

`openadam-direct-evals-driver` is a narrow Controller adapter for
`agent-tool-evals` direct-host protocol v0.1. It is not an Agent tool and is not
intended for model-facing discovery. One evaluator process reads one strict
`direct-driver-request.v0.1` document from stdin, sends one pinned call to an
already-running local Direct Execution Runtime service, and writes one
`direct-driver-result.v0.1` document to stdout.

The driver arguments pin the service Socket, provider id and observed version,
target id and binding digest, target kind, operation, and any Capability or
Procedure identity. The incoming evaluator request must match every pinned
identity. After execution, the returned runtime binding must match the pinned
provider version and target digest before the driver echoes the evaluated
runtime identity.

For an ordinary MCP tool, `--target-kind mcp-tool` keeps the historical rule
that `--operation-id` names the tool. For a declared multi-operation MCP tool,
the driver instead requires `--target-kind mcp-operation`, `--tool-name` for the
carrier tool, and `--operation-id` for the selected typed branch. The evaluator
task must repeat that selected operation id. This preserves operation identity
through grading and prevents the driver from bypassing the Runtime's projected
contract with the raw wide tool.

Host, transport, identity, and protocol failures make the driver exit nonzero
so the evaluator records an infrastructure failure. A provider-owned domain
error becomes a valid driver result with `status: error`. The adapter does not
invent a cost observation.

The bundled `evals-direct-driver-request.schema.json` and
`evals-direct-driver-result.schema.json` are compatibility copies. The local
three-provider check compares them byte-for-byte with the current sibling
`agent-tool-evals` schemas before running its isolated smoke.

The copies distributed in this repository are released by openAdam under this
repository's Apache-2.0 license. That grant applies to these copies only and
does not change the publication or licensing status of the separate
`agent-tool-evals` repository. The adapter remains optional Controller
integration; evaluation semantics and conclusions do not belong to this
runtime.
