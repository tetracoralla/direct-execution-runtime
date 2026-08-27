# Schema provenance

All schema files in this directory are distributed under this repository's
Apache-2.0 license. They fall into two roles.

## Runtime-owned schemas

Direct Execution Runtime owns the provider configuration, work order, contract
selection, host request, host response, host service observation, and
metadata-only execution observation schemas. They describe
this implementation's host boundary, not a universal Agent or provider ABI.

## Compatibility copies

- `capability-profile.schema.v0.3.json` and
  `provider-manifest.schema.v0.3.json` mirror the Apache-2.0
  `capability-contracts` sources.
- `capability-jsonl-envelope.schema.v0.1.json` mirrors the closed canonical
  adapter envelope from `capability-contracts`. Its error object permits exact
  `{code,message}` and `{code,message,retryable}` compatibility forms; the
  bound Capability Profile remains authoritative for retryability.
- `procedure-profile.schema.v0.5.json` and
  `procedure-implementation-manifest.schema.v0.5.json` mirror the Apache-2.0
  `procedure-contracts` sources.
- `evals-direct-driver-request.schema.json` and
  `evals-direct-driver-result.schema.json` mirror the direct-host adapter
  contract maintained in the separate `agent-tool-evals` development
  repository. openAdam releases these copies under Apache-2.0 in this
  distribution; this does not license or publish the rest of that repository.

Compatibility copies make the installable runtime self-contained. They do not
transfer semantic ownership to this project. The maintainer-only local pilot
compares the current copies byte-for-byte with the sibling sources before
exercising the cross-repository route. Older bundled schema copies are retained
only as historical package inputs; provider configuration v0.2 does not select
them for execution.
