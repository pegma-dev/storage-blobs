import { describe, expect, it } from "vitest";

import { storageBlobsPackageName } from "./index.js";

describe("@pegma/storage-blobs", () => {
  it("exports its package identity", () => {
    expect(storageBlobsPackageName).toBe("@pegma/storage-blobs");
  });
});
