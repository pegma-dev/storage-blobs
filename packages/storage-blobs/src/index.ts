/**
 * Provider-neutral object (blob) storage for Pegma components.
 *
 * Hosts inject a {@link BlobStore} bound to one container or bucket. Components
 * stream opaque bytes through it; structured metadata and authorization stay
 * outside this package.
 */

/** Largest object key length, measured in UTF-8 bytes. */
export const MAX_BLOB_KEY_BYTES = 1_024;

/** Largest page a prefix list may request. */
export const MAX_LIST_PAGE_SIZE = 1_000;

/**
 * Default maximum object body size when a store is created without
 * {@link MemoryBlobStoreOptions.maxObjectBytes}.
 */
export const DEFAULT_MAX_OBJECT_BYTES = 64 * 1_024 * 1_024;

/** Maximum number of user-metadata entries on one object. */
export const MAX_USER_METADATA_ENTRIES = 16;

/** Maximum UTF-8 byte length of a user-metadata key. */
export const MAX_USER_METADATA_KEY_BYTES = 64;

/** Maximum UTF-8 byte length of a user-metadata value. */
export const MAX_USER_METADATA_VALUE_BYTES = 256;

/**
 * Maximum combined UTF-8 byte length of all user-metadata keys and values
 * (S3's 2 KiB user-metadata budget is the tightest first-class backend).
 */
export const MAX_USER_METADATA_TOTAL_BYTES = 2 * 1_024;

/**
 * Maximum number of `/`-separated path segments in a key or prefix (Azure
 * Blob flat-namespace limit is the tightest first-class backend).
 */
export const MAX_BLOB_KEY_SEGMENTS = 254;

/** Maximum UTF-8 byte length of a stored content-type. */
export const MAX_CONTENT_TYPE_BYTES = 256;

/** Content-type applied when a put omits one. */
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** Published package name. Stable for smoke and release inventory checks. */
export const storageBlobsPackageName = "@pegma/storage-blobs" as const;

export class BlobStoreError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "BlobStoreError";
  }
}

/**
 * Thrown when a key, content-type, user metadata, or list argument fails
 * validation. Caller mistakes, not races.
 */
export class BlobValidationError extends BlobStoreError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "BlobValidationError";
  }
}

/** Thrown when a put would exceed the store or per-call size ceiling. */
export class BlobSizeLimitError extends BlobStoreError {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Object exceeds the configured maximum of ${limitBytes} bytes.`);
    this.name = "BlobSizeLimitError";
    this.limitBytes = limitBytes;
  }
}

/**
 * Immutable view of an object without its body.
 *
 * `etag` is opaque and meaningful only to the store that issued it. Pass it
 * back to conditional put/delete. `userMetadata` is what was stored; this
 * package does not interpret it.
 */
export interface BlobObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  readonly etag: string;
  readonly userMetadata: Readonly<Record<string, string>>;
}

/** A {@link get} success: metadata plus a web-standard body stream. */
export interface BlobGetResult extends BlobObjectInfo {
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * Why a conditional put did not store bytes.
 *
 * `exists` — create-only found the key taken.
 * `missing` — if-match found nothing.
 * `changed` — if-match found a different etag.
 */
export type PutRejection = "exists" | "missing" | "changed";

export type PutResult =
  | { readonly ok: true; readonly etag: string; readonly size: number }
  | { readonly ok: false; readonly reason: PutRejection };

/**
 * Why a delete did not remove an object.
 *
 * `missing` — nothing at the key (unconditional or if-match).
 * `changed` — if-match found a different etag.
 */
export type DeleteRejection = "missing" | "changed";

export type DeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DeleteRejection };

export interface PutOptions {
  /**
   * MIME type to store with the object. Defaults to
   * {@link DEFAULT_CONTENT_TYPE}. Not a security decision — policy belongs
   * to the host.
   */
  readonly contentType?: string;
  /**
   * Small string map stored with the object. Keys and values are constrained
   * so every first-class backend can round-trip them.
   */
  readonly userMetadata?: Readonly<Record<string, string>>;
  /**
   * Create only when the key is free. Must be the literal `"*"`. Mutually
   * exclusive with {@link ifMatch}.
   */
  readonly ifNoneMatch?: "*";
  /**
   * Replace only when the current etag matches. Mutually exclusive with
   * {@link ifNoneMatch}.
   */
  readonly ifMatch?: string;
  /**
   * Per-call size ceiling in bytes. Must not exceed the store maximum; may
   * only lower it.
   */
  readonly maxBytes?: number;
}

export interface DeleteOptions {
  /** Delete only when the current etag matches. */
  readonly ifMatch?: string;
}

export interface ListOptions {
  /** Keys that start with this string (after key validation of the prefix). */
  readonly prefix?: string;
  /** Positive integer no larger than {@link MAX_LIST_PAGE_SIZE}. */
  readonly limit: number;
  /**
   * Opaque store-issued continuation from the preceding page.
   *
   * Omit to begin a new listing. Pass back unchanged; foreign or malformed
   * cursors fail with {@link BlobValidationError}.
   */
  readonly cursor?: string;
}

/** One object in a list page. Content-type is not listed (backend intersection). */
export interface BlobListEntry {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
}

export interface BlobListPage {
  readonly objects: readonly BlobListEntry[];
  /** Continuation for the next page, or null when the listing is complete. */
  readonly nextCursor: string | null;
}

/**
 * One binding to one container or bucket.
 *
 * Trusted server code calls this after the host has already authorized the
 * caller. Conditionals that lose a race return a result; illegal arguments and
 * oversize bodies throw.
 */
export interface BlobStore {
  /**
   * Stores bytes at `key`, replacing any existing object unless a condition
   * refuses the write.
   *
   * `body` may be a `Uint8Array` or a `ReadableStream` of chunks. On success
   * the stream is fully consumed. If the body exceeds the size ceiling, the
   * remaining stream may be cancelled rather than drained. Stored bytes are
   * exactly the concatenation of chunks; empty bodies are allowed.
   */
  put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options?: PutOptions,
  ): Promise<PutResult>;

  /**
   * Returns metadata and a body stream, or null when the key is free.
   *
   * Each successful call yields an independent stream over a snapshot of the
   * object as of the read. Concurrent replaces do not change a stream already
   * returned.
   */
  get(key: string): Promise<BlobGetResult | null>;

  /** Like {@link get} without a body. */
  head(key: string): Promise<BlobObjectInfo | null>;

  /**
   * Removes the object at `key`.
   *
   * Unconditional delete of a missing key is `ok: false` with reason
   * `missing`, not an error. Conditional delete uses the same shape for
   * missing and changed etags.
   */
  delete(key: string, options?: DeleteOptions): Promise<DeleteResult>;

  /**
   * Lists objects under an optional prefix, one bounded page at a time.
   *
   * Not a snapshot: concurrent puts and deletes may produce duplicates or
   * defer a key to a later page. GC must use conditional delete with the etag
   * it observed.
   */
  list(options: ListOptions): Promise<BlobListPage>;
}

export interface MemoryBlobStoreOptions {
  /**
   * Hard ceiling for object bodies in this store. Defaults to
   * {@link DEFAULT_MAX_OBJECT_BYTES}.
   */
  readonly maxObjectBytes?: number;
}

interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
  readonly userMetadata: Readonly<Record<string, string>>;
}

const MEMORY_LIST_CURSOR_PREFIX = "pegma-memory-blob-list-v1:";

interface MemoryListCursor {
  readonly storeId: string;
  readonly afterKey: string;
}

const textEncoder = new TextEncoder();

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new BlobValidationError(
          `${label} must be well-formed Unicode (unpaired surrogate).`,
        );
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new BlobValidationError(
        `${label} must be well-formed Unicode (unpaired surrogate).`,
      );
    }
  }
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function hasDisallowedControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Shared character/length rules for keys and list prefixes (no exact-key
 * exclusions such as `.` / `..`).
 */
function assertBlobPathString(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new BlobValidationError(`${label} must be a non-empty string.`);
  }
  assertWellFormedUnicode(value, label);
  if (hasDisallowedControl(value)) {
    throw new BlobValidationError(
      `${label} must not contain control characters.`,
    );
  }
  if (utf8ByteLength(value) > MAX_BLOB_KEY_BYTES) {
    throw new BlobValidationError(
      `${label} exceeds ${MAX_BLOB_KEY_BYTES} UTF-8 bytes.`,
    );
  }
  // Azure Blob rejects names with more than 254 path segments.
  const segments = value.split("/").length;
  if (segments > MAX_BLOB_KEY_SEGMENTS) {
    throw new BlobValidationError(
      `${label} may have at most ${MAX_BLOB_KEY_SEGMENTS} path segments.`,
    );
  }
}

/** True when every code unit is a printable ASCII character (0x20–0x7E). */
function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

/**
 * Header-backed fields (content-type, metadata values) must not have leading
 * or trailing whitespace: HTTP header parsers strip it and adapters would
 * either reject or return a different value than memory.
 */
function assertNoSurroundingWhitespace(value: string, label: string): void {
  if (value !== value.trim()) {
    throw new BlobValidationError(
      `${label} must not have leading or trailing whitespace.`,
    );
  }
}

/**
 * Copies bytes without calling the input's `slice` method. Node `Buffer.slice`
 * returns a shared view; callers must not be able to mutate stored objects.
 */
function copyBytes(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

/**
 * Validates an object key against the intersection every first-class adapter
 * can honour.
 *
 * Keys are non-empty, at most {@link MAX_BLOB_KEY_BYTES} UTF-8 bytes, free of
 * C0 controls and DEL, well-formed Unicode, and must not be `.` or `..`.
 */
export function assertValidBlobKey(key: string): void {
  assertBlobPathString(key, "Blob key");
  if (key === "." || key === "..") {
    throw new BlobValidationError(
      `Blob key ${JSON.stringify(key)} is not allowed.`,
    );
  }
}

/**
 * Validates a list prefix. Empty string means “no prefix” and is rejected here
 * so callers use `undefined` instead of `""`.
 *
 * Unlike object keys, the exact strings `.` and `..` are allowed as prefixes
 * so keys such as `.hidden` remain listable.
 */
export function assertValidBlobPrefix(prefix: string): void {
  assertBlobPathString(prefix, "List prefix");
}

/** Validates and returns a portable content-type string. */
export function assertValidContentType(contentType: string): string {
  if (typeof contentType !== "string" || contentType.length === 0) {
    throw new BlobValidationError("Content-type must be a non-empty string.");
  }
  // Must be portable as an HTTP Content-Type header across first-class backends.
  if (!isPrintableAscii(contentType)) {
    throw new BlobValidationError("Content-type must be printable ASCII.");
  }
  assertNoSurroundingWhitespace(contentType, "Content-type");
  if (utf8ByteLength(contentType) > MAX_CONTENT_TYPE_BYTES) {
    throw new BlobValidationError(
      `Content-type exceeds ${MAX_CONTENT_TYPE_BYTES} UTF-8 bytes.`,
    );
  }
  return contentType;
}

/**
 * Portable user-metadata keys. Lowercase only: S3 lowercases metadata names,
 * so mixed-case keys are not an honest intersection.
 */
const USER_METADATA_KEY = /^[a-z][a-z0-9_]*$/;

/** Validates and freezes user metadata for portable storage. */
export function normalizeUserMetadata(
  input: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (input === undefined) {
    return Object.freeze({});
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_USER_METADATA_ENTRIES) {
    throw new BlobValidationError(
      `User metadata may have at most ${MAX_USER_METADATA_ENTRIES} entries.`,
    );
  }
  const normalized: Record<string, string> = {};
  let totalBytes = 0;
  for (const [rawKey, value] of entries) {
    if (!USER_METADATA_KEY.test(rawKey)) {
      throw new BlobValidationError(
        `User metadata key ${JSON.stringify(rawKey)} must match ${USER_METADATA_KEY.source}.`,
      );
    }
    const keyBytes = utf8ByteLength(rawKey);
    if (keyBytes > MAX_USER_METADATA_KEY_BYTES) {
      throw new BlobValidationError(
        `User metadata key exceeds ${MAX_USER_METADATA_KEY_BYTES} UTF-8 bytes.`,
      );
    }
    if (typeof value !== "string") {
      throw new BlobValidationError(
        `User metadata value for ${JSON.stringify(rawKey)} must be a string.`,
      );
    }
    // Azure Blob metadata values must be ASCII; keep the port honest.
    if (!isPrintableAscii(value)) {
      throw new BlobValidationError(
        `User metadata value for ${JSON.stringify(rawKey)} must be printable ASCII.`,
      );
    }
    assertNoSurroundingWhitespace(
      value,
      `User metadata value for ${JSON.stringify(rawKey)}`,
    );
    const valueBytes = utf8ByteLength(value);
    if (valueBytes > MAX_USER_METADATA_VALUE_BYTES) {
      throw new BlobValidationError(
        `User metadata value for ${JSON.stringify(rawKey)} exceeds ${MAX_USER_METADATA_VALUE_BYTES} UTF-8 bytes.`,
      );
    }
    if (Object.hasOwn(normalized, rawKey)) {
      throw new BlobValidationError(
        `User metadata key ${JSON.stringify(rawKey)} is duplicated.`,
      );
    }
    totalBytes += keyBytes + valueBytes;
    if (totalBytes > MAX_USER_METADATA_TOTAL_BYTES) {
      throw new BlobValidationError(
        `User metadata exceeds ${MAX_USER_METADATA_TOTAL_BYTES} UTF-8 bytes in total.`,
      );
    }
    normalized[rawKey] = value;
  }
  return Object.freeze(normalized);
}

function assertListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_PAGE_SIZE) {
    throw new BlobValidationError(
      `List limit must be an integer from 1 through ${MAX_LIST_PAGE_SIZE}.`,
    );
  }
}

function assertMaxBytes(
  maxBytes: number | undefined,
  storeMax: number,
): number {
  if (maxBytes === undefined) {
    return storeMax;
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new BlobValidationError(
      "Per-call maxBytes must be a non-negative integer.",
    );
  }
  if (maxBytes > storeMax) {
    throw new BlobValidationError(
      `Per-call maxBytes ${maxBytes} exceeds the store maximum of ${storeMax}.`,
    );
  }
  return maxBytes;
}

function assertEtag(etag: string, label: string): void {
  if (typeof etag !== "string" || etag.length === 0) {
    throw new BlobValidationError(`${label} must be a non-empty string.`);
  }
  if (hasDisallowedControl(etag)) {
    throw new BlobValidationError(
      `${label} must not contain control characters.`,
    );
  }
}

function encodeMemoryListCursor(storeId: string, afterKey: string): string {
  return `${MEMORY_LIST_CURSOR_PREFIX}${encodeURIComponent(
    JSON.stringify({ storeId, afterKey } satisfies MemoryListCursor),
  )}`;
}

function decodeMemoryListCursor(storeId: string, cursor: string): string {
  try {
    if (!cursor.startsWith(MEMORY_LIST_CURSOR_PREFIX)) {
      throw new Error("wrong cursor kind");
    }
    const parsed = JSON.parse(
      decodeURIComponent(cursor.slice(MEMORY_LIST_CURSOR_PREFIX.length)),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).sort().join(",") !== "afterKey,storeId"
    ) {
      throw new Error("wrong cursor shape");
    }
    const value = parsed as Partial<MemoryListCursor>;
    if (
      typeof value.afterKey !== "string" ||
      typeof value.storeId !== "string"
    ) {
      throw new Error("foreign cursor");
    }
    if (value.storeId !== storeId) {
      throw new Error("foreign store");
    }
    return value.afterKey;
  } catch (error) {
    throw new BlobValidationError(
      "List cursor is malformed or does not belong to this store.",
      { cause: error },
    );
  }
}

async function readBody(
  body: ReadableStream<Uint8Array> | Uint8Array,
  limitBytes: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > limitBytes) {
      throw new BlobSizeLimitError(limitBytes);
    }
    // Copy so the caller cannot mutate stored bytes through the input buffer.
    // Avoid `body.slice()`: Node Buffer.slice returns a shared view.
    return copyBytes(body);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new BlobValidationError(
          "Body stream chunks must be Uint8Array values.",
        );
      }
      total += value.byteLength;
      if (total > limitBytes) {
        // Do not await cancel: a hung cancel hook must not block the size error.
        void reader.cancel().catch(() => {
          // Ignore cancel failures; the size error is what the caller needs.
        });
        throw new BlobSizeLimitError(limitBytes);
      }
      // Copy immediately: streams may reuse one scratch buffer for every chunk.
      chunks.push(copyBytes(value));
    }
  } catch (error) {
    if (
      error instanceof BlobSizeLimitError ||
      error instanceof BlobValidationError
    ) {
      throw error;
    }
    throw new BlobStoreError("Failed to read object body stream.", {
      cause: error,
    });
  }

  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return copyBytes(chunks[0]!);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  // Snapshot copy so a later replace does not mutate an outstanding stream.
  const snapshot = copyBytes(bytes);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= snapshot.byteLength) {
        controller.close();
        return;
      }
      // Emit in chunks so multi-chunk fidelity is exercised in conformance.
      const end = Math.min(offset + 64 * 1024, snapshot.byteLength);
      controller.enqueue(snapshot.subarray(offset, end));
      offset = end;
    },
  });
}

function toObjectInfo(key: string, stored: StoredBlob): BlobObjectInfo {
  return {
    key,
    size: stored.bytes.byteLength,
    contentType: stored.contentType,
    etag: stored.etag,
    userMetadata: stored.userMetadata,
  };
}

/**
 * Creates an in-process {@link BlobStore} that keeps everything in memory.
 *
 * This is the reference implementation. It enforces the same key, size,
 * conditional, and listing rules as production adapters, so components tested
 * against it behave the same way in production. Prefer it for unit tests and
 * local composition before a cloud backend is configured.
 */
export function createMemoryBlobStore(
  options?: MemoryBlobStoreOptions,
): BlobStore {
  const maxObjectBytes = options?.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  if (!Number.isInteger(maxObjectBytes) || maxObjectBytes < 0) {
    throw new BlobValidationError(
      "maxObjectBytes must be a non-negative integer.",
    );
  }

  const storeId = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const objects = new Map<string, StoredBlob>();
  let etagGeneration = 0n;

  function nextEtag(): string {
    etagGeneration += 1n;
    return `mem-${etagGeneration.toString(10)}`;
  }

  return {
    async put(key, body, putOptions) {
      assertValidBlobKey(key);

      const ifNoneMatch = putOptions?.ifNoneMatch;
      const ifMatch = putOptions?.ifMatch;
      if (ifNoneMatch !== undefined && ifMatch !== undefined) {
        throw new BlobValidationError(
          "Put cannot set both ifNoneMatch and ifMatch.",
        );
      }
      if (ifNoneMatch !== undefined && ifNoneMatch !== "*") {
        throw new BlobValidationError('ifNoneMatch must be the literal "*".');
      }
      if (ifMatch !== undefined) {
        assertEtag(ifMatch, "ifMatch");
      }

      const contentType = assertValidContentType(
        putOptions?.contentType ?? DEFAULT_CONTENT_TYPE,
      );
      const userMetadata = normalizeUserMetadata(putOptions?.userMetadata);
      const limitBytes = assertMaxBytes(putOptions?.maxBytes, maxObjectBytes);

      // Evaluate existence conditions after validating options but before
      // consuming a large body when the refusal is already knowable.
      const existing = objects.get(key);
      if (ifNoneMatch === "*" && existing !== undefined) {
        return { ok: false, reason: "exists" };
      }
      if (ifMatch !== undefined) {
        if (existing === undefined) {
          return { ok: false, reason: "missing" };
        }
        if (existing.etag !== ifMatch) {
          return { ok: false, reason: "changed" };
        }
      }

      const bytes = await readBody(body, limitBytes);

      // Re-check conditions after the body is fully read so a concurrent
      // create-only put still refuses the loser.
      const current = objects.get(key);
      if (ifNoneMatch === "*" && current !== undefined) {
        return { ok: false, reason: "exists" };
      }
      if (ifMatch !== undefined) {
        if (current === undefined) {
          return { ok: false, reason: "missing" };
        }
        if (current.etag !== ifMatch) {
          return { ok: false, reason: "changed" };
        }
      }

      const etag = nextEtag();
      objects.set(key, {
        bytes,
        contentType,
        etag,
        userMetadata,
      });
      return { ok: true, etag, size: bytes.byteLength };
    },

    async get(key) {
      assertValidBlobKey(key);
      const stored = objects.get(key);
      if (stored === undefined) {
        return null;
      }
      return {
        ...toObjectInfo(key, stored),
        body: bytesToStream(stored.bytes),
      };
    },

    async head(key) {
      assertValidBlobKey(key);
      const stored = objects.get(key);
      if (stored === undefined) {
        return null;
      }
      return toObjectInfo(key, stored);
    },

    async delete(key, deleteOptions) {
      assertValidBlobKey(key);
      const ifMatch = deleteOptions?.ifMatch;
      if (ifMatch !== undefined) {
        assertEtag(ifMatch, "ifMatch");
      }

      const stored = objects.get(key);
      if (stored === undefined) {
        return { ok: false, reason: "missing" };
      }
      if (ifMatch !== undefined && stored.etag !== ifMatch) {
        return { ok: false, reason: "changed" };
      }
      objects.delete(key);
      return { ok: true };
    },

    async list(listOptions) {
      assertListLimit(listOptions.limit);
      const prefix = listOptions.prefix;
      if (prefix !== undefined) {
        assertValidBlobPrefix(prefix);
      }

      let afterKey: string | undefined;
      if (listOptions.cursor !== undefined) {
        if (
          typeof listOptions.cursor !== "string" ||
          listOptions.cursor === ""
        ) {
          throw new BlobValidationError(
            "List cursor must be a non-empty string when provided.",
          );
        }
        afterKey = decodeMemoryListCursor(storeId, listOptions.cursor);
      }

      const keys = [...objects.keys()].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      const page: BlobListEntry[] = [];
      for (const key of keys) {
        if (prefix !== undefined && !key.startsWith(prefix)) {
          continue;
        }
        if (afterKey !== undefined && key <= afterKey) {
          continue;
        }
        const stored = objects.get(key);
        if (stored === undefined) {
          continue;
        }
        page.push({
          key,
          size: stored.bytes.byteLength,
          etag: stored.etag,
        });
        if (page.length === listOptions.limit) {
          break;
        }
      }

      if (page.length === 0) {
        return { objects: [], nextCursor: null };
      }
      const last = page[page.length - 1]!;
      // Determine whether any later matching key remains.
      let hasMore = false;
      for (const key of keys) {
        if (prefix !== undefined && !key.startsWith(prefix)) {
          continue;
        }
        if (key > last.key) {
          hasMore = true;
          break;
        }
      }
      return {
        objects: page,
        nextCursor: hasMore ? encodeMemoryListCursor(storeId, last.key) : null,
      };
    },
  };
}
