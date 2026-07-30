import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import {
  concurrentConformanceCases,
  conformanceCases,
  dualStoreConformanceCases,
  sizeLimitConformanceCases,
} from "@pegma/storage-blobs/conformance";
import { describe, expect, it } from "vitest";

import { BLOB_PORT } from "../../../test/azurite.js";
import { createAzureBlobStore } from "./index.js";

/**
 * Azurite's well-known development credentials. Published emulator defaults;
 * they grant access only to the local process.
 */
const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONNECTION_STRING = [
  "DefaultEndpointsProtocol=http",
  `AccountName=${ACCOUNT}`,
  `AccountKey=${KEY}`,
  `BlobEndpoint=http://127.0.0.1:${BLOB_PORT}/${ACCOUNT};`,
].join(";");

let containerCounter = 0;

function nextContainerName(): string {
  containerCounter += 1;
  return `pegma-conf-${containerCounter}-p${process.pid}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 63);
}

function serviceClient(): BlobServiceClient {
  return BlobServiceClient.fromConnectionString(CONNECTION_STRING);
}

/** One empty container; factory returns fresh store handles to that container. */
function freshSharedBackend(maxObjectBytes = 2 * 1_024 * 1_024) {
  const name = nextContainerName();
  const container = serviceClient().getContainerClient(name);
  return {
    createStore: () =>
      createAzureBlobStore({
        containerClient: container,
        maxObjectBytes,
        createContainerIfMissing: true,
      }),
  };
}

describe("createAzureBlobStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const backend = freshSharedBackend();
      await testCase.run(() => backend.createStore());
    });
  }

  for (const testCase of sizeLimitConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run((limitBytes) => {
        const name = nextContainerName();
        const container = serviceClient().getContainerClient(name);
        return createAzureBlobStore({
          containerClient: container,
          maxObjectBytes: limitBytes,
          createContainerIfMissing: true,
        });
      });
    });
  }

  for (const testCase of concurrentConformanceCases) {
    it(testCase.name, async () => {
      const backend = freshSharedBackend();
      await testCase.run(() => backend.createStore());
    });
  }

  for (const testCase of dualStoreConformanceCases) {
    it(testCase.name, async () => {
      const a = freshSharedBackend();
      const b = freshSharedBackend();
      await testCase.run(
        () => a.createStore(),
        () => b.createStore(),
      );
    });
  }

  // Azurite cannot be made to fail createIfNotExists exactly once, so this
  // fault-injection case uses a stub client instead of the emulator.
  it("retries container creation after a failed first attempt", async () => {
    let createAttempts = 0;
    const notFound = () =>
      Object.assign(new Error("BlobNotFound"), { statusCode: 404 });
    const containerClient = {
      containerName: "retry-container",
      accountName: ACCOUNT,
      url: `http://127.0.0.1:${BLOB_PORT}/${ACCOUNT}/retry-container`,
      createIfNotExists: async () => {
        createAttempts += 1;
        if (createAttempts === 1) {
          throw new Error("transient container create failure");
        }
        return { succeeded: true };
      },
      getBlockBlobClient: () => ({
        getProperties: async () => {
          throw notFound();
        },
      }),
    } as unknown as ContainerClient;

    const store = createAzureBlobStore({
      containerClient,
      createContainerIfMissing: true,
    });

    await expect(store.head("some-key")).rejects.toThrow(
      "transient container create failure",
    );
    await expect(store.head("some-key")).resolves.toBeNull();
    expect(createAttempts).toBe(2);

    // Success stays memoized: further operations do not re-create.
    await expect(store.head("some-key")).resolves.toBeNull();
    expect(createAttempts).toBe(2);
  });
});
