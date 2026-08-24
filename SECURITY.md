# Security policy

## Supported versions

Until the first tagged release, security fixes apply to the current `main`
branch only. A tagged-version support table will be added when more than one
released line exists.

## Reporting a vulnerability

Use GitHub private vulnerability reporting when it is enabled for the hosted
repository. Do not place credentials, private provider paths, exploit payloads,
or other sensitive details in a public issue. If private reporting is not
available, contact the repository owner through the hosting account before
sharing details publicly.

Include the affected revision or package version, host platform, impact,
minimum reproduction, and whether an untrusted work order or provider is
required. Reports should receive an initial acknowledgement within seven days;
that target is a project policy, not a guaranteed service level.

## Trust boundary

The runtime validates closed structured requests and pinned provider bindings,
but configured provider executables are trusted local code. They run with the
same operating-system permissions as the runtime. The project does not sandbox
providers, store credentials, authorize side effects, accept network clients,
or make arbitrary model-selected operations safe.

The Unix Socket service accepts only an absolute path inside a directory owned
by and accessible only to the current user. It applies mode
`0600` to the Socket. Deployments needing stronger isolation must add it outside
this process, for example with a dedicated operating-system account or container.
