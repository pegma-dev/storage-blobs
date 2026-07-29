import assert from "node:assert/strict";

import {
  BlobSizeLimitError,
  BlobValidationError,
  DEFAULT_CONTENT_TYPE,
  MAX_BLOB_KEY_BYTES,
  MAX_BLOB_KEY_SEGMENTS,
  MAX_LIST_PAGE_SIZE,
  MAX_USER_METADATA_TOTAL_BYTES,
  type BlobStore,
} from "./index.js";

/**
 * The behaviour every {@link BlobStore} implementation must exhibit.
 *
 * These cases are the specification. An adapter is finished when it passes
 * them against a real empty backend, and a behaviour that is not asserted here
 * is not something a component may rely on.
 *
 * The suite has no test-framework dependency so that it can run under
 * whatever runner an adapter already uses:
 *
 * ```ts
 * for (const testCase of conformanceCases) {
 *   it(testCase.name, () => testCase.run(() => createMyStore()));
 * }
 * ```
 */
export interface ConformanceCase {
  readonly name: string;
  /**
   * Stores returned during one case must share one initially empty physical
   * backend. Adapters should return a fresh store instance per call so cases
   * prove that guarantees do not depend on process-local state, unless the
   * factory intentionally reuses one backend for multi-instance checks.
   */
  run(createStore: () => BlobStore): Promise<void>;
}

function testCase(
  name: string,
  run: (store: BlobStore) => Promise<void>,
): ConformanceCase {
  return { name, run: (createStore) => run(createStore()) };
}

function storeFactoryCase(
  name: string,
  run: (createStore: () => BlobStore) => Promise<void>,
): ConformanceCase {
  return { name, run };
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  assert.equal(actual.byteLength, expected.byteLength);
  for (let index = 0; index < expected.byteLength; index += 1) {
    assert.equal(
      actual[index],
      expected[index],
      `byte mismatch at offset ${index}`,
    );
  }
}

function multiChunkStream(
  chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
}

export const conformanceCases: readonly ConformanceCase[] = [
  testCase(
    "get returns null for a key that was never written",
    async (store) => {
      assert.equal(await store.get("missing-object"), null);
    },
  ),

  testCase(
    "head returns null for a key that was never written",
    async (store) => {
      assert.equal(await store.head("missing-object"), null);
    },
  ),

  testCase(
    "put then get round-trips bytes and default content-type",
    async (store) => {
      const body = textBytes("hello-blob");
      const put = await store.put("docs/readme.txt", body);
      assert.equal(put.ok, true);
      if (!put.ok) {
        return;
      }
      assert.equal(put.size, body.byteLength);
      assert.equal(typeof put.etag, "string");
      assert.notEqual(put.etag, "");

      const got = await store.get("docs/readme.txt");
      assert.ok(got);
      assert.equal(got.key, "docs/readme.txt");
      assert.equal(got.size, body.byteLength);
      assert.equal(got.contentType, DEFAULT_CONTENT_TYPE);
      assert.equal(got.etag, put.etag);
      assert.deepEqual(got.userMetadata, {});
      assertBytesEqual(await readAll(got.body), body);
    },
  ),

  testCase("put stores content-type and user metadata", async (store) => {
    const body = textBytes('{"ok":true}');
    const put = await store.put("meta/payload.json", body, {
      contentType: "application/json",
      userMetadata: { source: "conformance", attempt: "1" },
    });
    assert.equal(put.ok, true);

    const head = await store.head("meta/payload.json");
    assert.ok(head);
    assert.equal(head.contentType, "application/json");
    assert.deepEqual(head.userMetadata, {
      source: "conformance",
      attempt: "1",
    });
    assert.equal(head.size, body.byteLength);
  }),

  testCase(
    "put replaces an existing object and changes etag",
    async (store) => {
      const first = await store.put("replace/me", textBytes("one"));
      assert.equal(first.ok, true);
      if (!first.ok) {
        return;
      }
      const second = await store.put("replace/me", textBytes("two"));
      assert.equal(second.ok, true);
      if (!second.ok) {
        return;
      }
      assert.notEqual(second.etag, first.etag);

      const got = await store.get("replace/me");
      assert.ok(got);
      assert.equal(got.etag, second.etag);
      assertBytesEqual(await readAll(got.body), textBytes("two"));
    },
  ),

  testCase("put accepts an empty body", async (store) => {
    const put = await store.put("empty/object", new Uint8Array(0), {
      contentType: "application/x-empty",
    });
    assert.equal(put.ok, true);
    if (!put.ok) {
      return;
    }
    assert.equal(put.size, 0);

    const got = await store.get("empty/object");
    assert.ok(got);
    assert.equal(got.size, 0);
    assert.equal(got.contentType, "application/x-empty");
    assertBytesEqual(await readAll(got.body), new Uint8Array(0));
  }),

  testCase(
    "put from a multi-chunk stream preserves exact bytes",
    async (store) => {
      const chunks = [
        textBytes("alpha-"),
        textBytes("beta-"),
        textBytes("gamma"),
      ];
      const expected = textBytes("alpha-beta-gamma");
      const put = await store.put("streams/multi", multiChunkStream(chunks), {
        contentType: "text/plain",
      });
      assert.equal(put.ok, true);
      if (!put.ok) {
        return;
      }
      assert.equal(put.size, expected.byteLength);

      const got = await store.get("streams/multi");
      assert.ok(got);
      assertBytesEqual(await readAll(got.body), expected);
    },
  ),

  testCase("create-only put succeeds when the key is free", async (store) => {
    const put = await store.put("create/only", textBytes("fresh"), {
      ifNoneMatch: "*",
    });
    assert.equal(put.ok, true);
  }),

  testCase("create-only put refuses when the key exists", async (store) => {
    await store.put("create/taken", textBytes("first"));
    const put = await store.put("create/taken", textBytes("second"), {
      ifNoneMatch: "*",
    });
    assert.deepEqual(put, { ok: false, reason: "exists" });

    const got = await store.get("create/taken");
    assert.ok(got);
    assertBytesEqual(await readAll(got.body), textBytes("first"));
  }),

  testCase("if-match put replaces when the etag matches", async (store) => {
    const first = await store.put("cond/replace", textBytes("v1"));
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    const second = await store.put("cond/replace", textBytes("v2"), {
      ifMatch: first.etag,
    });
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    const got = await store.get("cond/replace");
    assert.ok(got);
    assertBytesEqual(await readAll(got.body), textBytes("v2"));
    assert.equal(got.etag, second.etag);
  }),

  testCase("if-match put refuses a stale etag", async (store) => {
    const first = await store.put("cond/stale", textBytes("v1"));
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    const second = await store.put("cond/stale", textBytes("v2"));
    assert.equal(second.ok, true);

    const refused = await store.put("cond/stale", textBytes("v3"), {
      ifMatch: first.etag,
    });
    assert.deepEqual(refused, { ok: false, reason: "changed" });

    const got = await store.get("cond/stale");
    assert.ok(got);
    assertBytesEqual(await readAll(got.body), textBytes("v2"));
  }),

  testCase("if-match put refuses a missing key", async (store) => {
    const put = await store.put("cond/missing", textBytes("nope"), {
      ifMatch: "etag-that-was-never-issued",
    });
    assert.deepEqual(put, { ok: false, reason: "missing" });
    assert.equal(await store.head("cond/missing"), null);
  }),

  testCase("delete removes an existing object", async (store) => {
    await store.put("delete/me", textBytes("gone"));
    const result = await store.delete("delete/me");
    assert.deepEqual(result, { ok: true });
    assert.equal(await store.get("delete/me"), null);
  }),

  testCase(
    "unconditional delete of a missing key reports missing",
    async (store) => {
      assert.deepEqual(await store.delete("delete/absent"), {
        ok: false,
        reason: "missing",
      });
    },
  ),

  testCase("if-match delete removes when the etag matches", async (store) => {
    const put = await store.put("delete/cond", textBytes("x"));
    assert.equal(put.ok, true);
    if (!put.ok) {
      return;
    }
    assert.deepEqual(await store.delete("delete/cond", { ifMatch: put.etag }), {
      ok: true,
    });
    assert.equal(await store.head("delete/cond"), null);
  }),

  testCase("if-match delete refuses a stale etag", async (store) => {
    const first = await store.put("delete/stale", textBytes("v1"));
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    await store.put("delete/stale", textBytes("v2"));
    assert.deepEqual(
      await store.delete("delete/stale", { ifMatch: first.etag }),
      { ok: false, reason: "changed" },
    );
    assert.ok(await store.head("delete/stale"));
  }),

  testCase("if-match delete refuses a missing key", async (store) => {
    assert.deepEqual(
      await store.delete("delete/cond-missing", {
        ifMatch: "etag-that-was-never-issued",
      }),
      { ok: false, reason: "missing" },
    );
  }),

  testCase(
    "list returns objects under a prefix in key order",
    async (store) => {
      await store.put("list/b", textBytes("b"));
      await store.put("list/a", textBytes("a"));
      await store.put("other/z", textBytes("z"));
      await store.put("list/c", textBytes("c"));

      const page = await store.list({ prefix: "list/", limit: 10 });
      assert.equal(page.nextCursor, null);
      assert.deepEqual(
        page.objects.map((entry) => entry.key),
        ["list/a", "list/b", "list/c"],
      );
      for (const entry of page.objects) {
        assert.equal(typeof entry.etag, "string");
        assert.notEqual(entry.etag, "");
        assert.equal(entry.size, 1);
      }
    },
  ),

  storeFactoryCase("list pages with opaque cursors", async (createStore) => {
    // Seed through one handle; continue the cursor through a fresh handle to
    // the same physical backend so adapters cannot embed process-local state.
    const writer = createStore();
    for (const key of ["page/a", "page/b", "page/c", "page/d"]) {
      await writer.put(key, textBytes(key));
    }

    const first = await writer.list({ prefix: "page/", limit: 2 });
    assert.deepEqual(
      first.objects.map((entry) => entry.key),
      ["page/a", "page/b"],
    );
    assert.notEqual(first.nextCursor, null);

    const second = await createStore().list({
      prefix: "page/",
      limit: 2,
      cursor: first.nextCursor!,
    });
    assert.deepEqual(
      second.objects.map((entry) => entry.key),
      ["page/c", "page/d"],
    );
    assert.equal(second.nextCursor, null);
  }),

  testCase("list without a prefix enumerates every key", async (store) => {
    await store.put("z-last", textBytes("z"));
    await store.put("a-first", textBytes("a"));
    const page = await store.list({ limit: 10 });
    assert.deepEqual(
      page.objects.map((entry) => entry.key),
      ["a-first", "z-last"],
    );
  }),

  testCase("list rejects a non-positive or oversized limit", async (store) => {
    await assert.rejects(
      () => store.list({ limit: 0 }),
      (error: unknown) => error instanceof BlobValidationError,
    );
    await assert.rejects(
      () => store.list({ limit: MAX_LIST_PAGE_SIZE + 1 }),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase("list rejects a foreign or malformed cursor", async (store) => {
    await store.put("cursor/a", textBytes("a"));
    await assert.rejects(
      () => store.list({ limit: 1, cursor: "not-a-real-cursor" }),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase("rejects an empty key", async (store) => {
    await assert.rejects(
      () => store.put("", textBytes("x")),
      (error: unknown) => error instanceof BlobValidationError,
    );
    await assert.rejects(
      () => store.get(""),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase("rejects the exact keys . and ..", async (store) => {
    for (const key of [".", ".."]) {
      await assert.rejects(
        () => store.put(key, textBytes("x")),
        (error: unknown) => error instanceof BlobValidationError,
      );
      await assert.rejects(
        () => store.get(key),
        (error: unknown) => error instanceof BlobValidationError,
      );
    }
  }),

  testCase("rejects a key containing a control character", async (store) => {
    const key = `bad${String.fromCharCode(0)}key`;
    await assert.rejects(
      () => store.put(key, textBytes("x")),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase("rejects a key longer than the byte ceiling", async (store) => {
    const key = "k".repeat(MAX_BLOB_KEY_BYTES + 1);
    await assert.rejects(
      () => store.put(key, textBytes("x")),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase("rejects put with both ifMatch and ifNoneMatch", async (store) => {
    await assert.rejects(
      () =>
        store.put("both/conds", textBytes("x"), {
          ifMatch: "etag",
          ifNoneMatch: "*",
        }),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase("rejects illegal user-metadata keys", async (store) => {
    await assert.rejects(
      () =>
        store.put("meta/bad", textBytes("x"), {
          userMetadata: { "not-valid": "yes" },
        }),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase("rejects non-ASCII user-metadata values", async (store) => {
    await assert.rejects(
      () =>
        store.put("meta/nonascii", textBytes("x"), {
          userMetadata: { label: "caf\u00e9" },
        }),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase("rejects non-ASCII content-type values", async (store) => {
    await assert.rejects(
      () =>
        store.put("meta/ctype", textBytes("x"), {
          contentType: "application/x-\u20ac",
        }),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase(
    "rejects content-type and metadata values with surrounding whitespace",
    async (store) => {
      await assert.rejects(
        () =>
          store.put("meta/ws-ctype", textBytes("x"), {
            contentType: " application/pdf ",
          }),
        (error: unknown) => error instanceof BlobValidationError,
      );
      await assert.rejects(
        () =>
          store.put("meta/ws-meta", textBytes("x"), {
            userMetadata: { label: " draft " },
          }),
        (error: unknown) => error instanceof BlobValidationError,
      );
    },
  ),

  testCase(
    "rejects user metadata over the aggregate byte budget",
    async (store) => {
      // 8 entries of 256-byte values exceed the 2 KiB S3 budget.
      const userMetadata: Record<string, string> = {};
      for (let index = 0; index < 8; index += 1) {
        userMetadata[`k${index}`] = "v".repeat(256);
      }
      let total = 0;
      for (const [key, value] of Object.entries(userMetadata)) {
        total += new TextEncoder().encode(key).byteLength;
        total += new TextEncoder().encode(value).byteLength;
      }
      assert.equal(total > MAX_USER_METADATA_TOTAL_BYTES, true);
      await assert.rejects(
        () => store.put("meta/too-big", textBytes("x"), { userMetadata }),
        (error: unknown) => error instanceof BlobValidationError,
      );
    },
  ),

  testCase(
    "accepts user metadata that totals exactly the aggregate byte budget",
    async (store) => {
      // Eight keys "k0".."k7" (2 bytes each) and values filling the budget.
      // 8 * 2 key bytes = 16; remaining 2032 value bytes => 254 per value.
      const userMetadata: Record<string, string> = {};
      for (let index = 0; index < 8; index += 1) {
        userMetadata[`k${index}`] = "v".repeat(254);
      }
      let total = 0;
      for (const [key, value] of Object.entries(userMetadata)) {
        total += new TextEncoder().encode(key).byteLength;
        total += new TextEncoder().encode(value).byteLength;
      }
      assert.equal(total, MAX_USER_METADATA_TOTAL_BYTES);
      const put = await store.put("meta/exact", textBytes("x"), {
        userMetadata,
      });
      assert.equal(put.ok, true);
      const head = await store.head("meta/exact");
      assert.ok(head);
      assert.equal(head.userMetadata["k0"], "v".repeat(254));
    },
  ),

  testCase("rejects a key with too many path segments", async (store) => {
    const key = `${"a/".repeat(MAX_BLOB_KEY_SEGMENTS)}z`;
    assert.equal(key.split("/").length, MAX_BLOB_KEY_SEGMENTS + 1);
    await assert.rejects(
      () => store.put(key, textBytes("x")),
      (error: unknown) => error instanceof BlobValidationError,
    );
  }),

  testCase(
    "put copies body bytes so later mutation is invisible",
    async (store) => {
      const body = new Uint8Array([1, 2, 3, 4]);
      const put = await store.put("copy/me", body);
      assert.equal(put.ok, true);
      body[0] = 99;
      const got = await store.get("copy/me");
      assert.ok(got);
      assertBytesEqual(await readAll(got.body), new Uint8Array([1, 2, 3, 4]));
    },
  ),

  testCase(
    "put copies stream chunks that reuse one scratch buffer",
    async (store) => {
      const scratch = new Uint8Array(1);
      let next = 1;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (next > 3) {
            controller.close();
            return;
          }
          scratch[0] = next;
          next += 1;
          controller.enqueue(scratch);
        },
      });
      const put = await store.put("copy/stream", stream);
      assert.equal(put.ok, true);
      const got = await store.get("copy/stream");
      assert.ok(got);
      assertBytesEqual(await readAll(got.body), new Uint8Array([1, 2, 3]));
    },
  ),
];

/**
 * Cases that need two independent empty backends (not two handles to one).
 *
 * Adapters should pass factories bound to two distinct empty containers/buckets.
 */
export interface DualStoreConformanceCase {
  readonly name: string;
  run(
    createStoreA: () => BlobStore,
    createStoreB: () => BlobStore,
  ): Promise<void>;
}

export const dualStoreConformanceCases: readonly DualStoreConformanceCase[] = [
  {
    name: "list rejects a cursor issued by a different backend",
    async run(createStoreA, createStoreB) {
      const first = createStoreA();
      const second = createStoreB();
      await first.put("page/a", textBytes("a"));
      await first.put("page/b", textBytes("b"));
      await second.put("page/a", textBytes("a"));
      await second.put("page/b", textBytes("b"));
      const page = await first.list({ prefix: "page/", limit: 1 });
      assert.notEqual(page.nextCursor, null);
      await assert.rejects(
        () =>
          second.list({
            prefix: "page/",
            limit: 1,
            cursor: page.nextCursor!,
          }),
        (error: unknown) => error instanceof BlobValidationError,
      );
    },
  },
];

/**
 * Extra cases that need a store constructed with a known size ceiling.
 *
 * Adapters wire these by constructing a backend with `maxObjectBytes`
 * (or equivalent) equal to `limitBytes`.
 */
export interface SizeLimitConformanceCase {
  readonly name: string;
  run(createStore: (limitBytes: number) => BlobStore): Promise<void>;
}

export const sizeLimitConformanceCases: readonly SizeLimitConformanceCase[] = [
  {
    name: "put throws BlobSizeLimitError when the body exceeds the store maximum",
    async run(createStore) {
      const limitBytes = 16;
      const store = createStore(limitBytes);
      await assert.rejects(
        () => store.put("too/large", new Uint8Array(limitBytes + 1)),
        (error: unknown) =>
          error instanceof BlobSizeLimitError &&
          error.limitBytes === limitBytes,
      );
      assert.equal(await store.head("too/large"), null);
    },
  },
  {
    name: "put throws when a multi-chunk stream crosses the size ceiling",
    async run(createStore) {
      const limitBytes = 10;
      const store = createStore(limitBytes);
      const stream = multiChunkStream([
        new Uint8Array(6).fill(1),
        new Uint8Array(6).fill(2),
      ]);
      await assert.rejects(
        () => store.put("too/streamy", stream),
        (error: unknown) =>
          error instanceof BlobSizeLimitError &&
          error.limitBytes === limitBytes,
      );
    },
  },
  {
    name: "put still throws BlobSizeLimitError when stream cancel never settles",
    async run(createStore) {
      const limitBytes = 4;
      const store = createStore(limitBytes);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(limitBytes + 1));
        },
        cancel() {
          // Never settle — size rejection must not wait on teardown.
          return new Promise(() => {
            /* intentionally unresolved */
          });
        },
      });
      await assert.rejects(
        () => store.put("too/hung-cancel", stream),
        (error: unknown) =>
          error instanceof BlobSizeLimitError &&
          error.limitBytes === limitBytes,
      );
    },
  },
  {
    name: "per-call maxBytes may only lower the store maximum",
    async run(createStore) {
      const store = createStore(100);
      await assert.rejects(
        () => store.put("call/limit", new Uint8Array(1), { maxBytes: 101 }),
        (error: unknown) => error instanceof BlobValidationError,
      );
      const put = await store.put("call/limit", new Uint8Array(4), {
        maxBytes: 4,
      });
      assert.equal(put.ok, true);
      await assert.rejects(
        () => store.put("call/limit2", new Uint8Array(5), { maxBytes: 4 }),
        (error: unknown) =>
          error instanceof BlobSizeLimitError && error.limitBytes === 4,
      );
    },
  },
];

/**
 * Concurrent create-only race: at most one put may report success.
 *
 * Requires a store whose put is safe under parallel create-only writers.
 */
export const concurrentConformanceCases: readonly ConformanceCase[] = [
  storeFactoryCase(
    "concurrent create-only puts: at most one succeeds",
    async (createStore) => {
      // Each call must return a handle to the same empty physical backend so
      // adapters cannot pass via instance-local serialization alone.
      const key = "race/create-only";
      const attempts = Array.from({ length: 8 }, (_, index) =>
        createStore().put(key, textBytes(`writer-${index}`), {
          ifNoneMatch: "*",
        }),
      );
      const results = await Promise.all(attempts);
      const successes = results.filter((result) => result.ok);
      assert.equal(successes.length, 1);
      const failures = results.filter((result) => !result.ok);
      assert.equal(failures.length, results.length - 1);
      for (const failure of failures) {
        assert.equal(failure.ok, false);
        if (!failure.ok) {
          assert.equal(failure.reason, "exists");
        }
      }
      const got = await createStore().get(key);
      assert.ok(got);
      assert.equal(got.size > 0, true);
    },
  ),
];
