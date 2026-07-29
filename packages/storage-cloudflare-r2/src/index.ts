import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  BlobSizeLimitError,
  BlobStoreError,
  BlobValidationError,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_OBJECT_BYTES,
  assertValidBlobKey,
  assertValidBlobPrefix,
  assertValidContentType,
  normalizeUserMetadata,
  type BlobListPage,
  type BlobObjectInfo,
  type BlobStore,
  type DeleteOptions,
  type DeleteResult,
  type ListOptions,
  type PutOptions,
  type PutResult,
  MAX_LIST_PAGE_SIZE,
} from "@pegma/storage-blobs";

const R2_LIST_CURSOR_PREFIX = "pegma-cloudflare-r2-list-v1:";

export interface CloudflareR2BlobStoreOptions {
  /**
   * Preconfigured S3 client aimed at R2 (or an S3-compatible stand-in such as
   * LocalStack). The host owns credentials, endpoint, and networking; this
   * package never reads environment secrets itself.
   */
  readonly client: S3Client;
  /**
   * Bucket name for this store instance. One store = one bucket.
   */
  readonly bucket: string;
  /**
   * Hard ceiling for object bodies. Defaults to
   * {@link DEFAULT_MAX_OBJECT_BYTES}.
   */
  readonly maxObjectBytes?: number;
}

interface R2ListCursor {
  readonly backendId: string;
  readonly continuation: string;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as {
    $metadata?: { httpStatusCode?: number };
    statusCode?: number;
    status?: number;
  };
  return (
    candidate.$metadata?.httpStatusCode ??
    candidate.statusCode ??
    candidate.status
  );
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as { name?: string; Code?: string; code?: string };
  return candidate.name ?? candidate.Code ?? candidate.code;
}

function isNotFound(error: unknown): boolean {
  const code = statusCode(error);
  if (code === 404) {
    return true;
  }
  const name = errorName(error);
  return (
    name === "NotFound" ||
    name === "NoSuchKey" ||
    name === "NotFoundError" ||
    name === "NoSuchBucket"
  );
}

function isPreconditionFailed(error: unknown): boolean {
  if (statusCode(error) === 412) {
    return true;
  }
  const name = errorName(error);
  return name === "PreconditionFailed" || name === "PreconditionFailedError";
}

function isConflict(error: unknown): boolean {
  if (statusCode(error) === 409) {
    return true;
  }
  const name = errorName(error);
  return name === "Conflict" || name === "ConditionalRequestConflict";
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
}

function assertBucketName(bucket: string): void {
  if (typeof bucket !== "string" || bucket.length === 0) {
    throw new BlobValidationError("bucket must be a non-empty string.");
  }
}

function copyBytes(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

async function readBody(
  body: ReadableStream<Uint8Array> | Uint8Array,
  limitBytes: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > limitBytes) {
      throw new BlobSizeLimitError(limitBytes);
    }
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
        void reader.cancel().catch(() => {
          /* size error wins */
        });
        throw new BlobSizeLimitError(limitBytes);
      }
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

function encodeListCursor(backendId: string, continuation: string): string {
  return `${R2_LIST_CURSOR_PREFIX}${encodeURIComponent(
    JSON.stringify({ backendId, continuation } satisfies R2ListCursor),
  )}`;
}

function decodeListCursor(backendId: string, cursor: string): string {
  try {
    if (!cursor.startsWith(R2_LIST_CURSOR_PREFIX)) {
      throw new Error("wrong cursor kind");
    }
    const parsed = JSON.parse(
      decodeURIComponent(cursor.slice(R2_LIST_CURSOR_PREFIX.length)),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).sort().join(",") !== "backendId,continuation"
    ) {
      throw new Error("wrong cursor shape");
    }
    const value = parsed as Partial<R2ListCursor>;
    if (
      value.backendId !== backendId ||
      typeof value.continuation !== "string" ||
      value.continuation.length === 0
    ) {
      throw new Error("foreign cursor");
    }
    return value.continuation;
  } catch (error) {
    throw new BlobValidationError(
      "List cursor is malformed or does not belong to this store.",
      { cause: error },
    );
  }
}

function metadataFromS3(
  metadata: Record<string, string> | undefined,
): Readonly<Record<string, string>> {
  if (metadata === undefined) {
    return Object.freeze({});
  }
  // S3 lowercases user-metadata keys. Preserve as returned.
  return Object.freeze({ ...metadata });
}

function requireEtag(etag: string | undefined, key: string): string {
  if (etag === undefined || etag.length === 0) {
    throw new BlobStoreError(
      `R2 returned no etag for object ${JSON.stringify(key)}.`,
    );
  }
  return etag;
}

function toObjectInfo(
  key: string,
  props: {
    contentLength: number | undefined;
    contentType: string | undefined;
    etag: string | undefined;
    metadata: Record<string, string> | undefined;
  },
): BlobObjectInfo {
  return {
    key,
    size: props.contentLength ?? 0,
    contentType: props.contentType ?? DEFAULT_CONTENT_TYPE,
    etag: requireEtag(props.etag, key),
    userMetadata: metadataFromS3(props.metadata),
  };
}

function emptyBodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Creates a {@link BlobStore} bound to one Cloudflare R2 bucket via the
 * S3-compatible API.
 *
 * Verified against LocalStack S3 (S3-compatible) in this repository. Pass a
 * host-configured {@link S3Client} aimed at R2; do not embed credentials in
 * this package.
 */
export function createCloudflareR2BlobStore(
  options: CloudflareR2BlobStoreOptions,
): BlobStore {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  if (!Number.isInteger(maxObjectBytes) || maxObjectBytes < 0) {
    throw new BlobValidationError(
      "maxObjectBytes must be a non-negative integer.",
    );
  }
  assertBucketName(options.bucket);

  const client = options.client;
  const bucket = options.bucket;
  // Bucket name is enough: each store instance is one bucket, and dual-store
  // conformance uses two distinct buckets so foreign cursors reject.
  const backendId = `r2|${bucket}`;

  async function headRaw(key: string): Promise<BlobObjectInfo | null> {
    try {
      const response = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return toObjectInfo(key, {
        contentLength: response.ContentLength,
        contentType: response.ContentType,
        etag: response.ETag,
        metadata: response.Metadata,
      });
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw new BlobStoreError(`R2 head failed for ${JSON.stringify(key)}.`, {
        cause: error,
      });
    }
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
      const bytes = await readBody(body, limitBytes);

      const input: {
        Bucket: string;
        Key: string;
        Body: Uint8Array;
        ContentType: string;
        Metadata?: Record<string, string>;
        IfNoneMatch?: string;
        IfMatch?: string;
      } = {
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      };
      if (Object.keys(userMetadata).length > 0) {
        input.Metadata = { ...userMetadata };
      }
      if (ifNoneMatch === "*") {
        input.IfNoneMatch = "*";
      } else if (ifMatch !== undefined) {
        input.IfMatch = ifMatch;
      }

      try {
        const response = await client.send(new PutObjectCommand(input));
        const etag = response.ETag;
        if (etag === undefined || etag.length === 0) {
          // Some S3-compatible servers omit ETag on put; re-read via HEAD.
          const head = await headRaw(key);
          if (head === null) {
            throw new BlobStoreError(
              `R2 put returned no etag and object is missing for ${JSON.stringify(key)}.`,
            );
          }
          return { ok: true, etag: head.etag, size: bytes.byteLength };
        }
        return { ok: true, etag, size: bytes.byteLength };
      } catch (error) {
        if (
          ifNoneMatch === "*" &&
          (isPreconditionFailed(error) || isConflict(error))
        ) {
          return { ok: false, reason: "exists" };
        }
        if (
          ifMatch !== undefined &&
          (isPreconditionFailed(error) || isNotFound(error))
        ) {
          if (isNotFound(error)) {
            return { ok: false, reason: "missing" };
          }
          try {
            const head = await headRaw(key);
            if (head === null) {
              return { ok: false, reason: "missing" };
            }
            return { ok: false, reason: "changed" };
          } catch (headError) {
            if (headError instanceof BlobStoreError) {
              throw headError;
            }
            throw new BlobStoreError(
              `R2 put condition diagnostic failed for ${JSON.stringify(key)}.`,
              { cause: headError },
            );
          }
        }
        throw new BlobStoreError(`R2 put failed for ${JSON.stringify(key)}.`, {
          cause: error,
        });
      }
    },

    async get(key) {
      assertValidBlobKey(key);
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        const info = toObjectInfo(key, {
          contentLength: response.ContentLength,
          contentType: response.ContentType,
          etag: response.ETag,
          metadata: response.Metadata,
        });
        const body = response.Body;
        if (body === undefined) {
          return { ...info, body: emptyBodyStream() };
        }
        // Aws sdk stream mixin exposes transformToWebStream in Node.
        const sdkBody = body as {
          transformToWebStream?: () => ReadableStream<Uint8Array>;
        };
        if (typeof sdkBody.transformToWebStream === "function") {
          return { ...info, body: sdkBody.transformToWebStream() };
        }
        // Fallback: treat as async iterable of bytes (older stream shapes).
        const iterable = body as AsyncIterable<Uint8Array>;
        return {
          ...info,
          body: new ReadableStream<Uint8Array>({
            async start(controller) {
              try {
                for await (const chunk of iterable) {
                  controller.enqueue(
                    chunk instanceof Uint8Array ? copyBytes(chunk) : chunk,
                  );
                }
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            },
          }),
        };
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw new BlobStoreError(`R2 get failed for ${JSON.stringify(key)}.`, {
          cause: error,
        });
      }
    },

    async head(key) {
      assertValidBlobKey(key);
      return headRaw(key);
    },

    async delete(key, deleteOptions?: DeleteOptions): Promise<DeleteResult> {
      assertValidBlobKey(key);
      const ifMatch = deleteOptions?.ifMatch;
      if (ifMatch !== undefined) {
        assertEtag(ifMatch, "ifMatch");
      }

      // S3 DeleteObject is idempotent (missing key still returns success) and
      // some S3-compatible servers ignore If-Match on delete. HEAD first so
      // missing/changed outcomes match the port; then prefer a conditional
      // delete when the caller supplied ifMatch.
      const existing = await headRaw(key);
      if (existing === null) {
        return { ok: false, reason: "missing" };
      }
      if (ifMatch !== undefined && existing.etag !== ifMatch) {
        return { ok: false, reason: "changed" };
      }

      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
            ...(ifMatch === undefined ? {} : { IfMatch: ifMatch }),
          }),
        );
        return { ok: true };
      } catch (error) {
        if (isNotFound(error)) {
          return { ok: false, reason: "missing" };
        }
        if (ifMatch !== undefined && isPreconditionFailed(error)) {
          const head = await headRaw(key);
          if (head === null) {
            return { ok: false, reason: "missing" };
          }
          return { ok: false, reason: "changed" };
        }
        // If-Match not supported: object still matched at HEAD time.
        if (
          ifMatch !== undefined &&
          (statusCode(error) === 400 || errorName(error) === "InvalidArgument")
        ) {
          try {
            await client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: key }),
            );
            return { ok: true };
          } catch (retryError) {
            throw new BlobStoreError(
              `R2 delete failed for ${JSON.stringify(key)}.`,
              { cause: retryError },
            );
          }
        }
        throw new BlobStoreError(
          `R2 delete failed for ${JSON.stringify(key)}.`,
          { cause: error },
        );
      }
    },

    async list(listOptions: ListOptions): Promise<BlobListPage> {
      assertListLimit(listOptions.limit);
      const prefix = listOptions.prefix;
      if (prefix !== undefined) {
        assertValidBlobPrefix(prefix);
      }

      let continuationToken: string | undefined;
      if (listOptions.cursor !== undefined) {
        if (
          typeof listOptions.cursor !== "string" ||
          listOptions.cursor === ""
        ) {
          throw new BlobValidationError(
            "List cursor must be a non-empty string when provided.",
          );
        }
        continuationToken = decodeListCursor(backendId, listOptions.cursor);
      }

      try {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            MaxKeys: listOptions.limit,
            ...(prefix === undefined ? {} : { Prefix: prefix }),
            ...(continuationToken === undefined
              ? {}
              : { ContinuationToken: continuationToken }),
          }),
        );

        const objects = (response.Contents ?? []).map((item) => {
          const key = item.Key;
          if (key === undefined || key.length === 0) {
            throw new BlobStoreError(
              "R2 list returned an object without a key.",
            );
          }
          return {
            key,
            size: item.Size ?? 0,
            etag: requireEtag(item.ETag, key),
          };
        });

        const next =
          response.IsTruncated === true &&
          response.NextContinuationToken !== undefined &&
          response.NextContinuationToken.length > 0
            ? encodeListCursor(backendId, response.NextContinuationToken)
            : null;

        return { objects, nextCursor: next };
      } catch (error) {
        if (
          error instanceof BlobValidationError ||
          error instanceof BlobStoreError
        ) {
          throw error;
        }
        throw new BlobStoreError("R2 list failed.", { cause: error });
      }
    },
  };
}
