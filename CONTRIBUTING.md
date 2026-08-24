# Contributing

Contributions are welcome when they preserve the narrow product boundary in
`docs/PRODUCT_MODEL.md` and the invariants in `docs/REVIEW_CONTRACT.md`.

## Development

Use Node.js 22.12 or newer, then run:

```sh
npm ci
npm run check
```

Changes to provider/session behavior should include the smallest failing
regression and a recovery assertion. Changes to `package-lock.json` must also
run `npm run generate:third-party-notices`. `npm run check:local-pilots` is a
maintainer-only integration check because it expects sibling provider
checkouts that are not part of this repository. Contributors are not expected
to have those checkouts to run the complete public `npm run check` path.

## Pull requests

Keep a pull request focused. Describe the exact host-level behavior changed,
the commands rerun, and any unverified runtime or distribution boundary. Do not
commit local provider paths, credentials, `.verify/` observations, Socket files,
or generated runtime results.

By submitting a contribution, you agree that it is licensed under the Apache
License, Version 2.0, consistent with this repository's `LICENSE`.
