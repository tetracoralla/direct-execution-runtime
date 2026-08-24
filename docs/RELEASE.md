# Source release checklist

This checklist prepares a GitHub source release. It does not authorize creating
a remote repository, pushing, publishing an npm package, or enabling hosted
settings.

1. Confirm the intended revision contains no local provider configuration,
   credentials, `.verify/` output, Socket files, or machine-specific paths.
2. Run `npm ci`, `npm run check`, `npm run audit:production`, and, on a machine
   with the maintainer pilot providers, `npm run check:local-pilots`.
3. Inspect `npm pack --json` and install the tarball in an empty directory.
   `npm run check:package` performs this mechanically, including the persistent
   service cold/warm route and clean shutdown.
4. Confirm `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md`, and the
   README are present in both source and package surfaces.
5. Review the actual Git history for secrets, personal data, generated output,
   large files, and misleading completion claims before the first push.
6. After hosting, require the CI and CodeQL workflows on protected branches and
   enable private vulnerability reporting. Hosted configuration is a separate
   observation and cannot be established by local files alone.
7. Create a tag or GitHub release only after the owner explicitly authorizes
   that additional publication step. A public source repository and its initial
   commit do not imply a tagged release. The package remains `private` and is
   not an npm release.
