# Root dependency and license baseline

The C4 bootstrap installs no third-party runtime or development packages.

- Root package: private, `UNLICENSED`.
- `packages/contracts`: private, `UNLICENSED`.
- Root lockfile records: root package, `@unseen/contracts` workspace, and its workspace link; 0 external packages.
- Gate implementation: Node.js and Python standard libraries only.
- Imported historical package manifests are read-only provenance and are not members of the root workspace unless their paths match an explicitly listed future workspace.

Any later dependency requires the controller-approved root lockfile maintenance process, including necessity, exact version, license, security, and alternative analysis.
