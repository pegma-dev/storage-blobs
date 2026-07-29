# Security Scan — storage-blobs

Date: 2026-07-29
Scope: repository `storage-blobs` (Pegma `@pegma/storage-*` packages)

## Phase 0 — Recon

### Stack

- Monorepo (npm workspaces), TypeScript, ESM-only, Node >= 22, vitest.
- Packages:
  - `@pegma/storage-blobs` — port, memory store, conformance suite (no runtime deps).
  - `@pegma/storage-azure-blob` — Azure Blob adapter (Azurite in CI).
  - `@pegma/storage-cloudflare-r2` — Cloudflare R2 adapter (S3-compatible, LocalStack in CI).
  - `@pegma/storage-s3` — S3 adapter (LocalStack in CI).
- Tooling: typescript, prettier, vitest, azurite (devDependencies).
- CI: GitHub Actions (`.github/workflows/ci.yml`, `codeql.yml`, `publish.yml`).

### Trust boundaries

This is a **library**, not an application. There are no public HTTP endpoints,
no auth middleware, and no direct exposure to untrusted callers. Per AGENTS.md,
`BlobStore` stores/returns bytes for **trusted server code** that already
authorized the caller. Attacker-relevant surfaces:

1. **Caller-supplied inputs to the port** — object keys, byte payloads,
   metadata passed by host components (which may themselves handle untrusted
   user content, e.g. support-ticket attachments). Injection/key-traversal at
   the adapter layer matters here.
2. **Cloud SDK credentials & endpoints** — adapters hold account keys /
   connection strings / presigned endpoints; mishandling could leak them.
3. **CI/CD** — GitHub Actions workflows, release script
   (`scripts/release-packages.mjs`), trusted-publisher (OIDC) publishing.
4. **Test harnesses** — `test/azurite.ts`, `test/localstack.ts` spawn
   containers/processes; lower stakes but still code that runs on dev/CI
   machines.

### In-scope directories

- `packages/*/src` (including `*.test.ts` for secrets/pattern review)
- `scripts/`
- `test/`, `tests/`
- `.github/workflows/`
- Root config files (package.json, tsconfig*, vitest.config.ts)
- `.tmp-sc/` (present in working tree — will check nature)

### Excluded

- `node_modules/`, `package-lock.json`, `dist/`, `*.tsbuildinfo` (generated)
- `docs/*.md`, READMEs (documentation)

### Phase 1 — Mechanized sweeps (raw output summarized)

- `npm audit`: 12 vulnerabilities (0 critical, 5 high, 7 moderate). Every chain
  terminates at the root **devDependency `azurite`** (test emulator). No
  finding traces to a shipped runtime dependency
  (`@aws-sdk/client-s3`, `@azure/storage-blob`) or to the zero-dependency port.
  See Finding 1.
- Grep sweeps for `eval(`, `new Function`, DOM XSS sinks, SQL concat, CORS
  wildcards, private-key material, AWS key patterns: **no hits** in scope.
- `child_process` use: `scripts/release-packages.mjs` (spawnSync, fixed
  argument arrays, `shell: false` except `npm.cmd` on win32 with static args),
  `test/azurite.ts` / `test/localstack.ts` (spawn of `process.execPath` /
  `docker` with static args), `tests/release-packages.test.ts` (execFileSync,
  static args). No caller-controlled input reaches any of these.
- Secrets sweep: only the Azurite **well-known public emulator key** in
  `packages/storage-azure-blob/src/index.test.ts:18-19` and LocalStack
  `test`/`test` credentials in `test/localstack.ts:18-19`. Both are documented
  public emulator defaults that grant access to local throwaway services only.
  Not a finding.
- `Math.random` single hit at `packages/storage-blobs/src/index.ts:666`
  (memory-store `storeId`). Used only to bind list cursors to a store
  instance; no security decision depends on it. Not a finding.
- `process.env` reads: none in any shipped package source. Adapters take
  host-configured clients (by design, per AGENTS.md). Env reads exist only in
  the release script (CI-provided vars) and README examples.
- `.tmp-sc/` is an untracked, git-ignored scratch copy of the storage-core
  README/code in the working tree; `.grok/` contains only an empty worktrees
  dir. Neither is committed. Housekeeping note only.

### Phase 2 — Layer-by-layer review

- **Port (`@pegma/storage-blobs`)**: key/prefix/content-type/metadata
  validation is strict (control chars, surrogates, byte budgets, `.`/`..`
  rejected as keys); bodies are copied so callers cannot mutate stored bytes
  (Buffer.slice aliasing explicitly avoided); list cursors are typed,
  store-bound, and reject foreign/malformed input; size ceilings enforced
  while streaming with cancellation. No findings.
- **Azure adapter**: credentials host-injected via `ContainerClient`; SAS query
  strings are stripped from the URL before it enters cursor `backendId`
  (index.ts:269-278); conditionals map 409/412/404 carefully. No findings.
- **S3 / R2 adapters**: credentials host-injected; `backendId`/`endpoint`
  required so cursors cannot cross accounts; missing-bucket is never confused
  with a free key (`assertBucketPresent`); conditional delete never falls back
  to unconditional. No findings.
- **CI/CD**: actions pinned by SHA, top-level `permissions: contents: read`,
  OIDC only in the publish job, protected `npm-publish` environment, signed
  annotated tag + origin/main ancestry + exact commit enforced by
  `validateReleaseTag`, `timingSafeEqual` for all digest comparisons. See
  Finding 2 for the one gap.
- **Dependencies**: Finding 1.

---

## Findings

### [MEDIUM] Dev-only dependency chain (azurite) carries 12 known vulnerabilities
- **Location:** root `package.json:28` (`"azurite": "^3.36.0"`); full chains in
  `npm audit` output (appendix below).
- **Evidence:** 5 high — `brace-expansion` (GHSA-mh99-v99m-4gvg, DoS via
  unbounded expansion) feeding `minimatch` → `glob` → `rimraf` → `azurite`;
  7 moderate — `uuid` <11.1.1 (GHSA-w5hq-g745-h8pq, buffer bounds in v3/v5/v6)
  via `@azure/ms-rest-js`/`sequelize`, and `@opentelemetry/core` baggage
  memory allocation (GHSA-8988-4f7v-96qf) via `applicationinsights`.
- **Exploitability:** reachable only when a developer or CI runner executes
  the Azurite test harness; nothing is shipped to consumers (azurite is a
  root devDependency, never in any package's `dependencies`). Exploiting the
  DoS issues requires feeding hostile input to the emulator's own code paths
  during a local/CI test run — low practical impact.
- **Confidence:** Confirmed (audit output; dev-only scope verified against
  each package.json).
- **Fix:** Track an azurite release that drops the vulnerable transitives and
  bump the devDependency when available (npm currently proposes azurite
  3.33.0 as the "fix", which is a downgrade — verify before applying). Add
  `npm audit --omit=dev` (expected clean) to CI so a *runtime* advisory fails
  the build, and keep dev-chain advisories as a tracked, non-gating item.

### [LOW] Publish pipeline trusts the cross-job artifact's self-consistency
- **Location:** `.github/workflows/publish.yml:74-86, 113-120`;
  `scripts/release-packages.mjs:509-560` (`verifyPreparedManifest`).
- **Evidence:** the `publish` job downloads `.release/` (tarballs plus
  `package-manifest.json`) and `verifyPreparedManifest` checks that each
  tarball's hashes match **the manifest that shipped in the same artifact**.
  The manifest is not independently anchored to the `prepare` job's output.
- **Exploitability:** an actor able to modify in-run workflow artifacts
  (which requires write access to Actions on this repo) could replace both
  tarballs and manifest with a self-consistent set; the commit checks
  (`prepared.gitCommit`, release-event commit) use public values and would
  still pass. Residual exposure is further bounded by the protected
  `npm-publish` environment and npm provenance, which binds the published
  package to this workflow run. No path from a fork/PR actor exists.
- **Confidence:** Confirmed (logic read end-to-end); exploitability gated
  behind repo write access, hence Low.
- **Fix:** Anchor the manifest across the job boundary: have `prepare` emit
  the SHA-256 of `package-manifest.json` as a step **output**
  (`$GITHUB_OUTPUT`), pass it to the `publish` job via `needs.prepare.outputs`,
  and fail in `release:publish` if the downloaded manifest's digest differs.
  (The digest is already written to the step summary at publish.yml:86, but
  summaries are not machine-checked.)

---

## Phase 3 — Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 1 |

| Layer | Status |
| ----- | ------ |
| Frontend | Not present (library repo) |
| Port (`@pegma/storage-blobs`) | Clean — strict validation, copy-on-store, store-bound cursors |
| Adapters (azure-blob, s3, cloudflare-r2) | Clean — credentials host-injected, no env reads, SAS stripped from cursors |
| Data layer | Not present (no query language; opaque object storage) |
| Config & CI | Strong — pinned actions, least-privilege permissions, OIDC trusted publishing, signed-tag enforcement; one Low on artifact handoff |
| Dependencies | Medium — 12 advisories, all confined to the dev-only azurite chain |

### Unverified / Needs Manual Review

- **`.tmp-sc/` working-tree scratch copy of storage-core** — untracked and
  git-ignored, so it cannot ship, but confirm it is intentional local scratch
  and delete if stale.
- **npm audit "fix" for azurite (3.33.0)** — flagged semver-major and is a
  version *downgrade*; needs manual verification against the azurite changelog
  before applying.

### Appendix — npm audit (raw, trimmed)

```
vulnerabilities: 12 total (5 high, 7 moderate, 0 critical)
high:   azurite, brace-expansion (GHSA-mh99-v99m-4gvg), glob, minimatch, rimraf
moderate: @azure/ms-rest-js, @opentelemetry/core (GHSA-8988-4f7v-96qf),
        @opentelemetry/resources, @opentelemetry/sdk-trace-base,
        applicationinsights, sequelize, uuid (GHSA-w5hq-g745-h8pq)
all chains: effects terminate at devDependency "azurite"
prod deps audited: 68 (no advisories)
```
