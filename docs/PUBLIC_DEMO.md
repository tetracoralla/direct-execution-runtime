# Public direct-execution demo

This demo runs a real public provider through Direct Execution Runtime without
an Agent relay. It is intentionally small: one exact result, one provider-owned
domain error, one host-side schema rejection, and cold/warm observations from
one persistent runtime.

## Prerequisites

- Node.js 22.12 or newer;
- Python 3.11 or newer;
- a Unix-like host;
- Git and network access for the initial source downloads.

Clone the two independent public repositories next to each other:

```sh
git clone https://github.com/tetracoralla/direct-execution-runtime.git
git clone https://github.com/tetracoralla/math-anchor.git
```

Install their source dependencies:

```sh
cd math-anchor
./script/bootstrap.sh
cd ../direct-execution-runtime
npm ci
```

Math Anchor remains a separately installed provider. The runtime neither
copies its source nor renames it.

## Run

From the Direct Execution Runtime checkout:

```sh
npm run demo:math-anchor -- --provider-root ../math-anchor
```

The command prints one JSON observation to stdout and writes nothing to either
repository. Its `semanticChecks` distinguish the exact provider result, a
provider-owned `E_NAME` error, and a host-owned `HOST_INPUT_INVALID` rejection.
Its measurements separate the first direct call from ten calls that reuse the
same provider session.

## Read the result honestly

`modelCallsInsideRuntime: 0` means only that this execution stage contains no
model invocation. `tokenUsage`, monetary cost, and the Agent route remain
unobserved. The current timings describe this run on this machine; they are not
an SLO, universal savings percentage, production-capacity result, or proof of
cross-provider substitution.

To compare an Agent-mediated route with the direct route, keep the model,
prompt, task, harness, and provider fixed and use the separately versioned
Controller evaluation adapter described in `docs/EVALS_DRIVER.md`.
