import { Readable } from "node:stream";

import type {
  BlobDownloadResponseParsed,
  ContainerClient,
} from "@azure/storage-blob";
import {
  BlobSizeLimitError,
  BlobStoreError,
  BlobValidationError,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_OBJECT_BYTES,
  assertValidBlobKey,
  assertValidBlobPrefix,
  assertValidCacheControl,
  assertValidContentType,
  normalizeUserMetadata,
  type BlobGetResult,
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

const AZURE_LIST_CURSOR_PREFIX = "pegma-azure-blob-list-v1:";

export interface AzureBlobStoreOptions {
  /**
   * Preconfigured client for **one** container. The host owns credentials and
   * networking; this package never reads environment secrets itself.
   */
  readonly containerClient: ContainerClient;
  /**
   * Hard ceiling for object bodies. Defaults to
   * {@link DEFAULT_MAX_OBJECT_BYTES}.
   */
  readonly maxObjectBytes?: number;
  /**
   * When true (default), creates the container on first use if it is missing.
   * Set false when the host manages container lifecycle exclusively.
   */
  readonly createContainerIfMissing?: boolean;
}

interface AzureListCursor {
  readonly backendId: string;
  readonly continuation: string;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as {
    statusCode?: number;
    status?: number;
  };
  return candidate.statusCode ?? candidate.status;
}

function isStatus(error: unknown, code: number): boolean {
  return statusCode(error) === code;
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

function nodeStreamToWeb(
  nodeStream: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    Readable.from(nodeStream),
  ) as ReadableStream<Uint8Array>;
}

function encodeListCursor(backendId: string, continuation: string): string {
  return `${AZURE_LIST_CURSOR_PREFIX}${encodeURIComponent(
    JSON.stringify({ backendId, continuation } satisfies AzureListCursor),
  )}`;
}

function decodeListCursor(backendId: string, cursor: string): string {
  try {
    if (!cursor.startsWith(AZURE_LIST_CURSOR_PREFIX)) {
      throw new Error("wrong cursor kind");
    }
    const parsed = JSON.parse(
      decodeURIComponent(cursor.slice(AZURE_LIST_CURSOR_PREFIX.length)),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).sort().join(",") !== "backendId,continuation"
    ) {
      throw new Error("wrong cursor shape");
    }
    const value = parsed as Partial<AzureListCursor>;
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

function metadataFromAzure(
  metadata: Record<string, string> | undefined,
): Readonly<Record<string, string>> {
  if (metadata === undefined) {
    return Object.freeze({});
  }
  // Azure returns keys lowercased. Preserve as returned (already portable).
  return Object.freeze({ ...metadata });
}

function toObjectInfo(
  key: string,
  props: {
    contentLength: number | undefined;
    contentType: string | undefined;
    cacheControl: string | undefined;
    etag: string | undefined;
    metadata: Record<string, string> | undefined;
  },
): BlobObjectInfo {
  if (props.etag === undefined || props.etag.length === 0) {
    throw new BlobStoreError(
      `Azure returned no etag for object ${JSON.stringify(key)}.`,
    );
  }
  return {
    key,
    size: props.contentLength ?? 0,
    contentType: props.contentType ?? DEFAULT_CONTENT_TYPE,
    // Azurite reports a cleared cache-control as "" rather than absent.
    cacheControl:
      props.cacheControl === undefined || props.cacheControl.length === 0
        ? undefined
        : props.cacheControl,
    etag: props.etag,
    userMetadata: metadataFromAzure(props.metadata),
  };
}

/**
 * Creates a {@link BlobStore} bound to one Azure Blob container.
 *
 * Verified against Azurite in this repository. Pass a host-configured
 * {@link ContainerClient}; do not embed credentials in this package.
 */
export function createAzureBlobStore(
  options: AzureBlobStoreOptions,
): BlobStore {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  if (!Number.isInteger(maxObjectBytes) || maxObjectBytes < 0) {
    throw new BlobValidationError(
      "maxObjectBytes must be a non-negative integer.",
    );
  }

  const container = options.containerClient;
  const createIfMissing = options.createContainerIfMissing !== false;
  const containerName = container.containerName;
  // Credential-free identity so SAS query strings never enter list cursors.
  let endpoint = container.url;
  try {
    const parsed = new URL(container.url);
    parsed.search = "";
    parsed.hash = "";
    endpoint = parsed.toString();
  } catch {
    // Fall back to the raw URL if it is not absolute.
  }
  const backendId = `${container.accountName ?? "account"}|${endpoint}|${containerName}`;
  let ensureContainer: Promise<void> | undefined;

  async function ready(): Promise<void> {
    if (!createIfMissing) {
      return;
    }
    if (ensureContainer === undefined) {
      // Memoize only success: a cached rejection would replay the original
      // failure on every operation for the lifetime of the store.
      ensureContainer = container.createIfNotExists().then(
        () => undefined,
        (error: unknown) => {
          ensureContainer = undefined;
          throw error;
        },
      );
    }
    await ensureContainer;
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
      const cacheControl =
        putOptions?.cacheControl === undefined
          ? undefined
          : assertValidCacheControl(putOptions.cacheControl);
      const userMetadata = normalizeUserMetadata(putOptions?.userMetadata);
      const limitBytes = assertMaxBytes(putOptions?.maxBytes, maxObjectBytes);
      const bytes = await readBody(body, limitBytes);

      await ready();
      const blob = container.getBlockBlobClient(key);

      const conditions =
        ifNoneMatch === "*"
          ? { ifNoneMatch: "*" as const }
          : ifMatch !== undefined
            ? { ifMatch }
            : undefined;

      try {
        const uploadOptions: {
          blobHTTPHeaders: {
            blobContentType: string;
            blobCacheControl?: string;
          };
          metadata?: Record<string, string>;
          conditions?: { ifNoneMatch: "*" } | { ifMatch: string };
        } = {
          blobHTTPHeaders: { blobContentType: contentType },
        };
        if (cacheControl !== undefined) {
          uploadOptions.blobHTTPHeaders.blobCacheControl = cacheControl;
        }
        if (Object.keys(userMetadata).length > 0) {
          uploadOptions.metadata = { ...userMetadata };
        }
        if (conditions !== undefined) {
          uploadOptions.conditions = conditions;
        }
        const response = await blob.uploadData(
          Buffer.from(bytes),
          uploadOptions,
        );
        const etag = response.etag;
        if (etag === undefined || etag.length === 0) {
          throw new BlobStoreError(
            `Azure put returned no etag for ${JSON.stringify(key)}.`,
          );
        }
        return { ok: true, etag, size: bytes.byteLength };
      } catch (error) {
        if (isStatus(error, 409) || isStatus(error, 412)) {
          if (ifNoneMatch === "*") {
            return { ok: false, reason: "exists" };
          }
          if (ifMatch !== undefined) {
            if (isStatus(error, 404)) {
              return { ok: false, reason: "missing" };
            }
            // Distinguish missing vs changed only when HEAD succeeds or 404s.
            try {
              await blob.getProperties();
              return { ok: false, reason: "changed" };
            } catch (headError) {
              if (isStatus(headError, 404)) {
                return { ok: false, reason: "missing" };
              }
              throw new BlobStoreError(
                `Azure put condition diagnostic failed for ${JSON.stringify(key)}.`,
                { cause: headError },
              );
            }
          }
        }
        if (isStatus(error, 404) && ifMatch !== undefined) {
          return { ok: false, reason: "missing" };
        }
        throw new BlobStoreError(
          `Azure put failed for ${JSON.stringify(key)}.`,
          { cause: error },
        );
      }
    },

    async get(key) {
      assertValidBlobKey(key);
      await ready();
      const blob = container.getBlockBlobClient(key);
      let download: BlobDownloadResponseParsed;
      try {
        download = await blob.download(0);
      } catch (error) {
        if (isStatus(error, 404)) {
          return null;
        }
        throw new BlobStoreError(
          `Azure get failed for ${JSON.stringify(key)}.`,
          { cause: error },
        );
      }

      const info = toObjectInfo(key, {
        contentLength: download.contentLength,
        contentType: download.contentType,
        cacheControl: download.cacheControl,
        etag: download.etag,
        metadata: download.metadata,
      });

      const nodeBody = download.readableStreamBody;
      if (nodeBody === undefined) {
        return {
          ...info,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
        };
      }

      return {
        ...info,
        body: nodeStreamToWeb(nodeBody),
      };
    },

    async head(key) {
      assertValidBlobKey(key);
      await ready();
      const blob = container.getBlockBlobClient(key);
      try {
        const props = await blob.getProperties();
        return toObjectInfo(key, {
          contentLength: props.contentLength,
          contentType: props.contentType,
          cacheControl: props.cacheControl,
          etag: props.etag,
          metadata: props.metadata,
        });
      } catch (error) {
        if (isStatus(error, 404)) {
          return null;
        }
        throw new BlobStoreError(
          `Azure head failed for ${JSON.stringify(key)}.`,
          { cause: error },
        );
      }
    },

    async delete(key, deleteOptions?: DeleteOptions): Promise<DeleteResult> {
      assertValidBlobKey(key);
      const ifMatch = deleteOptions?.ifMatch;
      if (ifMatch !== undefined) {
        assertEtag(ifMatch, "ifMatch");
      }
      await ready();
      const blob = container.getBlockBlobClient(key);
      try {
        await blob.delete(
          ifMatch === undefined ? undefined : { conditions: { ifMatch } },
        );
        return { ok: true };
      } catch (error) {
        if (isStatus(error, 404)) {
          return { ok: false, reason: "missing" };
        }
        if (ifMatch !== undefined && isStatus(error, 412)) {
          // Azure often reports 412 for a missing blob under If-Match.
          try {
            await blob.getProperties();
            return { ok: false, reason: "changed" };
          } catch (headError) {
            if (isStatus(headError, 404)) {
              return { ok: false, reason: "missing" };
            }
            throw new BlobStoreError(
              `Azure delete condition diagnostic failed for ${JSON.stringify(key)}.`,
              { cause: headError },
            );
          }
        }
        throw new BlobStoreError(
          `Azure delete failed for ${JSON.stringify(key)}.`,
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

      await ready();

      try {
        const pageSettings: {
          maxPageSize: number;
          continuationToken?: string;
        } = {
          maxPageSize: listOptions.limit,
        };
        if (continuationToken !== undefined) {
          pageSettings.continuationToken = continuationToken;
        }
        const iterator = container
          .listBlobsFlat(prefix === undefined ? undefined : { prefix })
          .byPage(pageSettings);
        const page = await iterator.next();
        if (page.done || page.value === undefined) {
          return { objects: [], nextCursor: null };
        }

        const segment = page.value;
        const objects = (segment.segment.blobItems ?? []).map((item) => {
          const etag = item.properties.etag;
          if (etag === undefined || etag.length === 0) {
            throw new BlobStoreError(
              `Azure list returned no etag for ${JSON.stringify(item.name)}.`,
            );
          }
          return {
            key: item.name,
            size: item.properties.contentLength ?? 0,
            etag,
          };
        });

        const next =
          segment.continuationToken !== undefined &&
          segment.continuationToken.length > 0
            ? encodeListCursor(backendId, segment.continuationToken)
            : null;

        return { objects, nextCursor: next };
      } catch (error) {
        if (
          error instanceof BlobValidationError ||
          error instanceof BlobStoreError
        ) {
          throw error;
        }
        throw new BlobStoreError("Azure list failed.", { cause: error });
      }
    },
  };
}
