import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  concurrentConformanceCases,
  conformanceCases,
  dualStoreConformanceCases,
  sizeLimitConformanceCases,
} from "@pegma/storage-blobs/conformance";
import { afterAll, describe, it } from "vitest";

import {
  LOCALSTACK_ACCESS_KEY,
  LOCALSTACK_ENDPOINT,
  LOCALSTACK_SECRET_KEY,
} from "../../../test/localstack.js";
import { createCloudflareR2BlobStore } from "./index.js";

const HARNESS_ENDPOINT = LOCALSTACK_ENDPOINT;

let bucketCounter = 0;
const createdBuckets: string[] = [];

function nextBucketName(): string {
  bucketCounter += 1;
  // S3/R2 bucket naming: 3–63 chars, lowercase, digits, hyphens.
  return `pegma-r2-${bucketCounter}-p${process.pid}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 63);
}

function serviceClient(): S3Client {
  return new S3Client({
    region: "us-east-1",
    endpoint: LOCALSTACK_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: LOCALSTACK_ACCESS_KEY,
      secretAccessKey: LOCALSTACK_SECRET_KEY,
    },
  });
}

async function ensureEmptyBucket(name: string): Promise<void> {
  const client = serviceClient();
  try {
    await client.send(new CreateBucketCommand({ Bucket: name }));
  } catch (error) {
    const errorName =
      typeof error === "object" && error !== null
        ? ((error as { name?: string }).name ?? "")
        : "";
    if (
      errorName !== "BucketAlreadyOwnedByYou" &&
      errorName !== "BucketAlreadyExists"
    ) {
      throw error;
    }
  } finally {
    client.destroy();
  }
  createdBuckets.push(name);
}

async function destroyBucket(name: string): Promise<void> {
  const client = serviceClient();
  try {
    let token: string | undefined;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: name,
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      );
      const keys = (listed.Contents ?? [])
        .map((item) => item.Key)
        .filter((key): key is string => typeof key === "string");
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: name,
            Delete: {
              Objects: keys.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token !== undefined);
    await client.send(new DeleteBucketCommand({ Bucket: name }));
  } catch {
    // Best-effort teardown; LocalStack container is removed after the suite.
  } finally {
    client.destroy();
  }
}

/** One empty bucket; factory returns fresh store handles to that bucket. */
async function freshSharedBackend(maxObjectBytes = 2 * 1_024 * 1_024) {
  const name = nextBucketName();
  await ensureEmptyBucket(name);
  const client = serviceClient();
  return {
    createStore: () =>
      createCloudflareR2BlobStore({
        client,
        bucket: name,
        endpoint: HARNESS_ENDPOINT,
        maxObjectBytes,
      }),
    close: async () => {
      client.destroy();
    },
  };
}

afterAll(async () => {
  for (const name of createdBuckets) {
    await destroyBucket(name);
  }
});

describe("createCloudflareR2BlobStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const backend = await freshSharedBackend();
      try {
        await testCase.run(() => backend.createStore());
      } finally {
        await backend.close();
      }
    });
  }

  for (const testCase of sizeLimitConformanceCases) {
    it(testCase.name, async () => {
      // Factory must return BlobStore synchronously; pre-create empty buckets.
      const pool: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const name = nextBucketName();
        await ensureEmptyBucket(name);
        pool.push(name);
      }
      let next = 0;
      const client = serviceClient();
      try {
        await testCase.run((limitBytes) => {
          const name = pool[next];
          next += 1;
          if (name === undefined) {
            throw new Error("Size-limit bucket pool exhausted.");
          }
          return createCloudflareR2BlobStore({
            client,
            bucket: name,
            endpoint: HARNESS_ENDPOINT,
            maxObjectBytes: limitBytes,
          });
        });
      } finally {
        client.destroy();
      }
    });
  }

  for (const testCase of concurrentConformanceCases) {
    it(testCase.name, async () => {
      const backend = await freshSharedBackend();
      try {
        await testCase.run(() => backend.createStore());
      } finally {
        await backend.close();
      }
    });
  }

  for (const testCase of dualStoreConformanceCases) {
    it(testCase.name, async () => {
      const a = await freshSharedBackend();
      const b = await freshSharedBackend();
      try {
        await testCase.run(
          () => a.createStore(),
          () => b.createStore(),
        );
      } finally {
        await a.close();
        await b.close();
      }
    });
  }
});
