import { describe, expect, it } from "vitest";

import {
  concurrentConformanceCases,
  conformanceCases,
  sizeLimitConformanceCases,
} from "./conformance.js";
import {
  BlobValidationError,
  createMemoryBlobStore,
  storageBlobsPackageName,
} from "./index.js";

describe("@pegma/storage-blobs", () => {
  it("exports its package identity", () => {
    expect(storageBlobsPackageName).toBe("@pegma/storage-blobs");
  });
});

describe("createMemoryBlobStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const store = createMemoryBlobStore({ maxObjectBytes: 1_024 * 1_024 });
      await testCase.run(() => store);
    });
  }

  for (const testCase of sizeLimitConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run((limitBytes) =>
        createMemoryBlobStore({ maxObjectBytes: limitBytes }),
      );
    });
  }

  for (const testCase of concurrentConformanceCases) {
    it(testCase.name, async () => {
      const store = createMemoryBlobStore({ maxObjectBytes: 1_024 * 1_024 });
      await testCase.run(() => store);
    });
  }
});

describe("memory store isolation", () => {
  it("gives each store its own objects", async () => {
    const first = createMemoryBlobStore();
    const second = createMemoryBlobStore();
    await first.put("only-in-first", new TextEncoder().encode("secret"));
    expect(await second.get("only-in-first")).toBeNull();
  });

  it("rejects a list cursor issued by a different memory store", async () => {
    const first = createMemoryBlobStore();
    const second = createMemoryBlobStore();
    await first.put("page/a", new TextEncoder().encode("a"));
    await first.put("page/b", new TextEncoder().encode("b"));
    const page = await first.list({ prefix: "page/", limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    await expect(
      second.list({
        prefix: "page/",
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(BlobValidationError);
  });
});

describe("memory etag lifecycle", () => {
  it("never reuses an etag after replace or delete", async () => {
    const store = createMemoryBlobStore();
    const etags = new Set<string>();

    for (let index = 0; index < 100; index += 1) {
      const put = await store.put("churn", new Uint8Array([index & 0xff]));
      expect(put.ok).toBe(true);
      if (!put.ok) {
        return;
      }
      expect(etags.has(put.etag)).toBe(false);
      etags.add(put.etag);

      if (index % 2 === 0) {
        expect(await store.delete("churn")).toEqual({ ok: true });
      }
    }

    expect(etags.size).toBe(100);
  });
});

describe("createMemoryBlobStore options", () => {
  it("rejects a non-integer maxObjectBytes", () => {
    expect(() => createMemoryBlobStore({ maxObjectBytes: 1.5 })).toThrow(
      BlobValidationError,
    );
  });
});
