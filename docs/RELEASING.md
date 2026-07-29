# Release operations

Packages in this repository publish only from a stable GitHub release. Merging
a pull request never publishes, and the workflow has no manual-dispatch or
npm-token fallback.

## Required external configuration

Before the first release through this workflow, for each public package name
(initially `@pegma/storage-blobs`, later adapters as they are added):

- configure the package on npm with the GitHub Actions trusted publisher
  `pegma-dev/storage-blobs`, workflow `publish.yml`, environment `npm-publish`,
  and allowed action `npm publish`;
- create the GitHub `npm-publish` environment. A second reviewer is not
  required under Pegma's single-maintainer policy;
- create the repository Actions variable `RELEASE_ALLOWED_SIGNERS` containing
  the reviewed Git SSH allowed-signers entry for the maintainer's release key;
  this is public-key material, not a secret; and
- create an active tag ruleset targeting `v*` that prevents tag updates and
  deletions and limits tag creation to the release maintainer.

Do not add `NODE_AUTH_TOKEN`, an npm automation token, or another credential
fallback. After one trusted-publisher release is verified, disable any
remaining traditional npm publish tokens.

A brand-new package name that has never existed on npm may require a one-time
manual `npm publish` of a non-advertised bootstrap version before trusted
publishing can attach; follow the same pattern used by other Pegma components
and keep that bootstrap out of the normal OIDC lane.

## Release procedure

The version in each `packages/*/package.json` listed in
`scripts/release-packages.mjs` is the release version. Change versions through
an ordinary reviewed pull request and run the complete gate on Node 22 and 24.

After that pull request is merged, create a signed annotated tag at the exact
`origin/main` commit, push the tag, verify the fetched tag, and only then
create the GitHub release with `--verify-tag`. Do not let GitHub create the tag
and never move or recreate a release tag.

The release workflow verifies that the tag:

- is a stable annotated `vX.Y.Z` tag signed by an allowed signer;
- matches a public package version in the release inventory;
- points to the checkout and the GitHub release-event commit; and
- is contained in `origin/main`.

Its preparation job has no OIDC permission. It installs the reviewed npm
version without dependency caching, runs the full gate, builds and packs once,
smoke-tests the tarball from a clean consumer, records its SHA-1 and SHA-512
integrity, and uploads the exact prepared artifact.

Only the `npm-publish` job receives `id-token: write`. It installs no
dependencies, verifies the prepared manifest and tarball hashes against the
release commit, and publishes that tarball with npm provenance.

## Safe retry

The workflow is globally serialized. Re-run the failed release jobs against
the unchanged tag:

- an absent version is published;
- an existing version with identical `dist.integrity` is verified and skipped;
- a different integrity, or any registry error other than `E404`, stops the
  release.

Never unpublish and reuse a version. If any released byte must change, prepare
a new version and a new signed tag.

## Inventory

`scripts/release-packages.mjs` holds the reviewed public package list. Adding
an adapter package means adding it there, giving it its own README and LICENSE,
and extending trusted-publisher configuration before the first release that
includes it.
