import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PACKAGES,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  REVIEWED_NPM,
  REVIEWED_PNPM,
  assertPnpmLockfileSynchronized,
  decidePublication,
  digestManifest,
  parseArguments,
  resolveNpmCli,
  resolvedVersionSatisfies,
  unquoteYamlScalar,
  validateReleaseTag,
  validateRepository,
  verifyManifestDigest,
} from "../scripts/release-packages.mjs";

const git = process.platform === "win32" ? "git.exe" : "git";
const packageVersion = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "packages", "storage-blobs", "package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

function run(command: string, arguments_: string[], cwd?: string): string {
  return execFileSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("release package metadata", () => {
  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
    });
  });

  it("parses preparation without consumer smoke imports", () => {
    expect(parseArguments(["--skip-smoke"])).toEqual({ skipSmoke: true });
  });

  it("parses the expected prepared manifest digest", () => {
    expect(
      parseArguments(["--expected-manifest-digest", "a".repeat(64)]),
    ).toEqual({ expectedManifestDigest: "a".repeat(64) });
    expect(() => parseArguments(["--expected-manifest-digest"])).toThrow(
      "unknown or incomplete argument",
    );
  });

  it("keeps the exact public package inventory", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual([
      "@pegma/storage-blobs",
      "@pegma/storage-azure-blob",
      "@pegma/storage-cloudflare-r2",
      "@pegma/storage-s3",
    ]);
  });

  it("keeps workflow-owned publication constants aligned", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const packageBlock = /const packages = \[([\s\S]*?)\];/u.exec(
      workflow,
    )?.[1];
    expect(packageBlock).toBeDefined();
    const workflowPackages = [
      ...(packageBlock ?? "").matchAll(/"(@pegma\/[^"]+)"/gu),
    ].map((match) => match[1]);
    expect(workflowPackages).toEqual(RELEASE_PACKAGES.map(({ name }) => name));

    const schemaVersion = /manifest\.schemaVersion !== (\d+)/u.exec(
      workflow,
    )?.[1];
    expect(schemaVersion).toBe(String(RELEASE_MANIFEST_SCHEMA_VERSION));
    expect(workflow).toContain(`npmVersion !== "${REVIEWED_NPM.version}"`);
    for (const name of ["ComSpec", "COMSPEC", "PATHEXT", "WINDIR"]) {
      expect(workflow).toContain(`"${name}"`);
    }

    const tagPatterns = [
      ...workflow.matchAll(
        /if \[\[ ! "\$\{RELEASE_TAG\}" =~ ([^ ]+) \]\]; then/gu,
      ),
    ].map((match) => match[1]);
    expect(tagPatterns).toHaveLength(2);
    expect(new Set(tagPatterns).size).toBe(1);
    expect(workflow.match(/verify-tag/gu)).toHaveLength(2);
    expect(workflow.match(/merge-base --is-ancestor/gu)).toHaveLength(2);
  });

  it("validates package manifests and the lockfile together", async () => {
    await expect(validateRepository()).resolves.toBeDefined();
    const rootManifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { packageManager: string };
    expect(rootManifest.packageManager).toBe(`pnpm@${REVIEWED_PNPM.version}`);
  });

  it("never treats pnpm as the npm CLI", () => {
    const previous = process.env.npm_execpath;
    process.env.npm_execpath = "/tmp/corepack/v1/pnpm/10.34.5/bin/pnpm.cjs";
    try {
      const cli = resolveNpmCli();
      expect(cli).toMatch(/npm-cli\.js$/u);
      expect(cli).not.toMatch(/pnpm/iu);
    } finally {
      if (previous === undefined) {
        delete process.env.npm_execpath;
      } else {
        process.env.npm_execpath = previous;
      }
    }
  });

  it("matches each lockfile dependency to its own specifier and version", () => {
    const lockfile = `lockfileVersion: '9.0'

importers:

  packages/storage-azure-blob:
    dependencies:
      '@azure/storage-blob':
        specifier: ^12.29.1
        version: 12.33.0
      '@pegma/storage-blobs':
        specifier: 0.2.0
        version: link:../storage-blobs
`;
    expect(() =>
      assertPnpmLockfileSynchronized(lockfile, "packages/storage-azure-blob", {
        "@azure/storage-blob": "^12.29.1",
        "@pegma/storage-blobs": "0.2.0",
      }),
    ).not.toThrow();
    expect(() =>
      assertPnpmLockfileSynchronized(lockfile, "packages/storage-azure-blob", {
        "@azure/storage-blob": "^12.29.1",
        "@pegma/storage-blobs": "0.3.0",
      }),
    ).toThrow("@pegma/storage-blobs@0.3.0");
    const swappedVersion = lockfile.replace(
      "        version: link:../storage-blobs",
      "        version: 999.0.0",
    );
    expect(() =>
      assertPnpmLockfileSynchronized(
        swappedVersion,
        "packages/storage-azure-blob",
        {
          "@azure/storage-blob": "^12.29.1",
          "@pegma/storage-blobs": "0.2.0",
        },
      ),
    ).toThrow("@pegma/storage-blobs@0.2.0");
    const exactPin = lockfile.replace(
      "        specifier: ^12.29.1\n        version: 12.33.0",
      "        specifier: 12.29.1\n        version: 12.33.0",
    );
    expect(() =>
      assertPnpmLockfileSynchronized(exactPin, "packages/storage-azure-blob", {
        "@azure/storage-blob": "12.29.1",
        "@pegma/storage-blobs": "0.2.0",
      }),
    ).toThrow("@azure/storage-blob@12.29.1");
  });

  it("accepts a resolved version that satisfies a semver range", () => {
    expect(resolvedVersionSatisfies("^1.2.0", "1.2.3")).toBe(true);
    expect(resolvedVersionSatisfies("^1.2.0", "1.2.0")).toBe(true);
    expect(resolvedVersionSatisfies("^1.2.0", "2.0.0")).toBe(false);
    expect(resolvedVersionSatisfies("1.2.0", "1.2.0")).toBe(true);
    expect(resolvedVersionSatisfies("1.2.0", "1.2.3")).toBe(false);
    expect(resolvedVersionSatisfies("1.2.0", "1.2.0(@foo@1.0.0)")).toBe(true);
  });

  it("unquotes YAML scalars before comparing lockfile pins", () => {
    expect(unquoteYamlScalar("'*'")).toBe("*");
    expect(unquoteYamlScalar("'1'")).toBe("1");
    expect(unquoteYamlScalar('"1"')).toBe("1");
    const lockfile = `lockfileVersion: '9.0'

importers:

  packages/storage-blobs:
    dependencies:
      demo:
        specifier: '*'
        version: 1.2.3
      numbered:
        specifier: '1'
        version: '1.0.0'
`;
    expect(() =>
      assertPnpmLockfileSynchronized(lockfile, "packages/storage-blobs", {
        demo: "*",
        numbered: "1",
      }),
    ).not.toThrow();
  });

  it("includes peerDependencies in the lockfile pin check", () => {
    const lockfile = `lockfileVersion: '9.0'

importers:

  packages/storage-blobs:
    dependencies:
      '@azure/storage-blob':
        specifier: ^12.29.1
        version: 12.33.0
    peerDependencies:
      '@pegma/spine':
        specifier: ^0.1.0
        version: 0.1.2
`;
    expect(() =>
      assertPnpmLockfileSynchronized(lockfile, "packages/storage-blobs", {
        "@azure/storage-blob": "^12.29.1",
        "@pegma/spine": "^0.1.0",
      }),
    ).not.toThrow();
    expect(() =>
      assertPnpmLockfileSynchronized(lockfile, "packages/storage-blobs", {
        "@azure/storage-blob": "^12.29.1",
        "@pegma/spine": "^0.2.0",
      }),
    ).toThrow("@pegma/spine@^0.2.0");
  });

  it("requires the release tag to match a public package version", async () => {
    await expect(validateRepository({ releaseTag: "v9.9.9" })).rejects.toThrow(
      `release tag must be v${packageVersion}`,
    );
    await expect(
      validateRepository({
        releaseTag: `v${packageVersion}`,
        releasePrerelease: true,
      }),
    ).rejects.toThrow("prereleases cannot publish packages");
  });
});

describe("release source authentication", () => {
  it("rejects release tags outside the stable package series", () => {
    expect(() =>
      validateReleaseTag({
        releaseTag: "v0.0.1",
        expectedReleaseCommit: "a".repeat(40),
      }),
    ).toThrow("stable release tag");
  });

  it("accepts only an approved signed annotated tag at the event commit", () => {
    const root = mkdtempSync(join(tmpdir(), "storage-blobs-release-tag-"));
    try {
      run(git, ["init", "--quiet"], root);
      run(git, ["config", "user.name", "Release Test"], root);
      run(git, ["config", "user.email", "release@example.com"], root);
      writeFileSync(join(root, "README.md"), "release test\n");
      run(git, ["add", "README.md"], root);
      run(git, ["commit", "--quiet", "-m", "release"], root);
      run(git, ["branch", "-M", "main"], root);
      run(git, ["update-ref", "refs/remotes/origin/main", "HEAD"], root);
      const releaseCommit = run(git, ["rev-parse", "HEAD"], root);

      const signingKey = join(root, "release-signing-key");
      run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "release@example.com",
        "-f",
        signingKey,
      ]);
      const allowedSigners = join(root, "allowed-signers");
      writeFileSync(
        allowedSigners,
        `release@example.com ${readFileSync(`${signingKey}.pub`, "utf8").trim()}\n`,
      );
      run(git, ["config", "gpg.format", "ssh"], root);
      run(git, ["config", "user.signingkey", signingKey], root);
      run(git, ["config", "gpg.ssh.allowedSignersFile", allowedSigners], root);

      run(git, ["tag", "--sign", "v0.1.0", "--message", "signed"], root);
      expect(
        validateReleaseTag({
          root,
          releaseTag: "v0.1.0",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toEqual({ headCommit: releaseCommit, releaseTag: "v0.1.0" });

      run(git, ["tag", "v0.1.1"], root);
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.1.1",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("annotated tag object");

      run(
        git,
        [
          "-c",
          "commit.gpgsign=false",
          "tag",
          "--annotate",
          "v0.1.2",
          "--message",
          "unsigned",
        ],
        root,
      );
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.1.2",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("not valid for an approved signer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps preparation and consumer smoke outside the publisher job", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const jobsMarker = "\njobs:\n";
    const jobsIndex = workflow.indexOf(jobsMarker);
    expect(jobsIndex).toBeGreaterThanOrEqual(0);
    const header = workflow.slice(0, jobsIndex);
    const jobs = workflow.slice(jobsIndex + jobsMarker.length);
    const prepareStart = jobs.indexOf("  prepare:");
    const smokeStart = jobs.indexOf("\n  smoke:");
    const publishStart = jobs.indexOf("\n  publish:");
    expect(header).not.toContain("id-token: write");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(smokeStart).toBeGreaterThan(prepareStart);
    expect(publishStart).toBeGreaterThan(smokeStart);
    const prepare = jobs.slice(prepareStart, smokeStart);
    const smoke = jobs.slice(smokeStart, publishStart);
    const publish = jobs.slice(publishStart);
    expect(prepare).not.toContain("id-token: write");
    expect(smoke).not.toContain("id-token: write");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("pnpm install");
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("npm install");
    expect(publish).not.toContain("pnpm");
    expect(publish).not.toContain("corepack");
    expect(publish).not.toContain("actions/checkout");
    expect(publish).not.toContain("scripts/release-packages.mjs");
    expect(publish).toContain(
      'script_path="${RUNNER_TEMP}/publish-release.mjs"',
    );
    expect(prepare).toContain("--skip-smoke");
    expect(prepare).toContain("include-hidden-files: false");
    expect(prepare).toContain("path: ${{ steps.manifest.outputs.files }}");
    expect(prepare).not.toContain("path: .release/");
    expect(smoke).toContain("release-packages.mjs smoke");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("retention-days: 30");
  });
});

describe("prepared manifest anchoring", () => {
  const manifestBytes = `${JSON.stringify({
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
  })}\n`;
  const digest = digestManifest(manifestBytes);

  it("accepts the digest recorded by the preparation job", () => {
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(verifyManifestDigest(manifestBytes, digest)).toBe(digest);
    expect(verifyManifestDigest(Buffer.from(manifestBytes), digest)).toBe(
      digest,
    );
  });

  it("rejects a manifest replaced alongside its tarballs", () => {
    const replacement = `${JSON.stringify({
      schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    })} \n`;
    expect(() => verifyManifestDigest(replacement, digest)).toThrow(
      "does not match the digest recorded by the preparation job",
    );
  });

  it("refuses to publish without a usable expected digest", () => {
    expect(() => verifyManifestDigest(manifestBytes, undefined)).toThrow(
      "an expected prepared manifest digest is required",
    );
    expect(() => verifyManifestDigest(manifestBytes, "")).toThrow(
      "an expected prepared manifest digest is required",
    );
    expect(() => verifyManifestDigest(manifestBytes, "not-a-digest")).toThrow(
      "must be SHA-256 hexadecimal",
    );
    expect(() =>
      verifyManifestDigest(manifestBytes, digest.toUpperCase()),
    ).toThrow("must be SHA-256 hexadecimal");
  });

  it("carries the digest across the job boundary in run metadata", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const jobsMarker = "\njobs:\n";
    const jobsIndex = workflow.indexOf(jobsMarker);
    expect(jobsIndex).toBeGreaterThanOrEqual(0);
    const jobs = workflow.slice(jobsIndex + jobsMarker.length);
    const prepareStart = jobs.indexOf("  prepare:");
    const smokeStart = jobs.indexOf("\n  smoke:");
    const publishStart = jobs.indexOf("\n  publish:");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(smokeStart).toBeGreaterThan(prepareStart);
    expect(publishStart).toBeGreaterThan(prepareStart);
    const prepare = jobs.slice(prepareStart, smokeStart);
    const publish = jobs.slice(publishStart);
    expect(prepare).toContain(
      "manifest-digest: ${{ steps.manifest.outputs.digest }}",
    );
    expect(publish).toContain(
      "RELEASE_MANIFEST_DIGEST: ${{ needs.prepare.outputs.manifest-digest }}",
    );
    expect(publish).toContain("RELEASE_MANIFEST_DIGEST");
    expect(prepare).toContain(
      "artifact-digest: ${{ steps.upload.outputs.artifact-digest }}",
    );
  });
});

describe("retry-safe publication", () => {
  const integrity = "sha512-cHJlcGFyZWQtdGFyYmFsbA==";

  it("publishes an absent version", () => {
    expect(decidePublication(integrity, null)).toBe("publish");
  });

  it("skips a byte-identical existing version", () => {
    expect(decidePublication(integrity, integrity)).toBe("skip");
  });

  it("rejects an existing version with different bytes", () => {
    expect(() => decidePublication(integrity, "sha512-ZGlmZmVyZW50")).toThrow(
      "different tarball integrity",
    );
  });
});
