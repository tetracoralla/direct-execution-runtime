# Integration boundary

Direct Execution Runtime invokes separately installed providers. Provider
source code, releases, licenses, configuration, credentials, and domain
semantics remain outside this repository.

Human-facing documentation uses a provider's public product name plus a short
role description. Runtime configuration uses stable machine identifiers. A
local checkout directory is never a public product identity.

## Current public integration pilots

| Product | Role | Public repository | Runtime identity | Carrier |
| --- | --- | --- | --- | --- |
| Math Anchor | Deterministic mathematics | [tetracoralla/math-anchor](https://github.com/tetracoralla/math-anchor) | `io.github.tetracoralla.math-anchor` | stdio MCP |
| Migratory Time | Time-zone conversion | [tetracoralla/migratory-time](https://github.com/tetracoralla/migratory-time) | `io.github.tetracoralla.migratory-time` | Capability JSONL |

These names identify independent products; they do not make either provider a
dependency bundled with this runtime. Users must install and configure the
provider separately.

## Maintainer-only local pilot

Dependency Preflight exercises Procedure JSONL and short-lived Capability JSONL
behavior in the current development workspace. It has no public source or
installation route in this release and is not advertised as an open-source
integration.

`npm run check:local-pilots` expects these sibling development checkouts and
also compares bundled compatibility schemas with their current source
repositories. It is optional maintainer validation, not part of the standalone
public build or installation path. Generated observations stay in ignored
`.verify/` and carry no durable correctness, capacity, or savings claim.

## Adding an integration

A provider belongs in the public table only after a current released or
publicly installable boundary has been exercised through this runtime. Record
its public product name, role, repository, stable runtime identity, carrier,
and exact version or contract binding. Being open source alone does not imply
that the provider is supported by this runtime.
