# Schema provenance

All schema files in this directory are distributed under this repository's
Apache-2.0 license. They fall into two roles.

## Runtime-owned schemas

Direct Execution Runtime owns the provider configuration, work order, host
request, host response, and host service observation schemas. They describe
this implementation's host boundary, not a universal Agent or provider ABI.

## Compatibility copies

- `provider-manifest.schema.v0.1.json` and
  `provider-manifest.schema.v0.2.json` mirror the Apache-2.0
  `capability-contracts` sources.
- `procedure-profile.schema.v0.3.json` and
  `procedure-implementation-manifest.schema.v0.4.json` mirror the Apache-2.0
  `procedure-contracts` sources.
- `evals-direct-driver-request.schema.json` and
  `evals-direct-driver-result.schema.json` mirror the direct-host adapter
  contract maintained in the separate `agent-tool-evals` development
  repository. openAdam releases these copies under Apache-2.0 in this
  distribution; this does not license or publish the rest of that repository.

Compatibility copies make the installable runtime self-contained. They do not
transfer semantic ownership to this project. The maintainer-only local pilot
compares them byte-for-byte with the current sibling sources before exercising
the cross-repository route.
