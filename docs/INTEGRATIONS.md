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

The public Math Anchor path is executable through
[`docs/PUBLIC_DEMO.md`](PUBLIC_DEMO.md). It reacquires the provider's live MCP
schema and runs without tracked local configuration. This is a direct-route
demonstration, not an Agent comparison or compatibility claim for every Math
Anchor release.

## Maintainer-only local pilot

Dependency Preflight exercises Procedure JSONL and short-lived Capability JSONL
behavior in the current development workspace. Structured Data Preflight
exercises the conditional `org.openadam.structured-data.preflight@0.3.0`
Procedure over the current File Vitals and BatchTicket Capability adapters.
Neither Procedure implementation is advertised as an installed or public
integration of this runtime.

`npm run check:schema-parity` compares bundled compatibility schemas with their
current sibling source without starting a provider. `npm run check:local-pilots`
expects the provider sibling development checkouts. Both are optional
maintainer validation, not part of the standalone public build or installation
path. Generated observations stay in ignored `.verify/` and carry no durable
correctness, capacity, or savings claim. When a required provider checkout is
absent, the local pilot reports that provider route as `not_run` and exits
incomplete; a successful schema-parity subcheck is not promoted into a
provider-pilot PASS.

The targeted Structured Data Preflight route is:

```sh
npm run check:structured-data-procedure
```

It rebuilds the two Python wheels and the native File Vitals Capability adapter
from sibling source into a temporary root. A temporary compatibility manifest
binds the rebuilt `sdp-procedure` entry point while preserving the current
Procedure identity, Profile digest, exact three stage bindings, and contract
schema digests. This demonstrates that the Direct Runtime can execute that
rebuilt provider code for the named cases. The Python entry points still use
the sibling checkouts' dependency runtimes, so this is not a clean-host
dependency installation. It does not change the implementation repository's
tracked development manifest, establish a released installation, or show that
an Agent or Agent Host selected the route.

## Resolver boundary

The optional config-backed resolver consumes one exact semantic target and
closed Host constraints. It can return more than one configured provider match,
but counts a provider as exact only when its current binding exposes that exact
Capability operation, Procedure, MCP tool, or projected MCP operation. It does
not enumerate near matches, infer intent, rank providers, or call a target
operation.

An eligible result means only that the named target and requested contract
constraints passed the current deterministic projection route. A configured
Capability or Procedure projection does not start its adapter and therefore
does not observe execution availability. A live MCP projection observes the
contract session, not a successful target call. Provider startup and transport
failures remain `unknown`; they are not converted into semantic rejection.
For a projected MCP operation, a configured projection-envelope match is
reported separately and does not count as an exact candidate until the live
contract exposes that operation identity.
These point-in-time observations do not establish product quality, domain
correctness, future health, credentials, adoption, or substitution fitness.

The resolver returns the exact `openadam.direct-contract-selection.v0.1`
object for each candidate so an Agent or automation can expose only the chosen
task contract through `project`. Provider-owned contracts and semantics remain
outside this repository.

## Adding an integration

A provider belongs in the public table only after a current released or
publicly installable boundary has been exercised through this runtime. Record
its public product name, role, repository, stable runtime identity, carrier,
and exact version or contract binding. Being open source alone does not imply
that the provider is supported by this runtime.
