import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Runs LocalStack's S3 service so the Cloudflare R2 adapter is verified against
 * a faithful S3-compatible implementation (R2's object API), not a mock SDK.
 *
 * MinIO was considered but rejects single path segments over 255 characters and
 * counts `x-amz-meta-` prefix bytes against the 2 KiB metadata budget, which is
 * stricter than AWS S3 / R2 and fails the frozen suite. LocalStack matches the
 * S3 limits the port is built around.
 *
 * Port is not LocalStack's default, so a local instance already running for
 * other work does not collide with this harness.
 */
export const LOCALSTACK_PORT = 10_101;
export const LOCALSTACK_ACCESS_KEY = "test";
export const LOCALSTACK_SECRET_KEY = "test";
export const LOCALSTACK_ENDPOINT = `http://127.0.0.1:${LOCALSTACK_PORT}`;

const CONTAINER_NAME = `pegma-storage-blobs-localstack-${process.pid}`;
const IMAGE = "localstack/localstack:4.3";

let startedContainer = false;

function portAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const settle = (accepting: boolean) => {
      socket.destroy();
      resolve(accepting);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1000, () => settle(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portAccepting(port)) {
      return;
    }
    await delay(250);
  }
  throw new Error(
    `LocalStack did not start listening on port ${port} within ${timeoutMs}ms.`,
  );
}

async function waitForS3Ready(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${LOCALSTACK_PORT}/_localstack/health`,
      );
      if (response.ok) {
        const body = (await response.json()) as {
          services?: Record<string, string>;
        };
        const s3 = body.services?.s3;
        if (s3 === "available" || s3 === "running") {
          return;
        }
      }
    } catch {
      /* retry */
    }
    await delay(250);
  }
  throw new Error(
    `LocalStack S3 was not healthy within ${timeoutMs}ms on port ${LOCALSTACK_PORT}.`,
  );
}

function runDocker(args: string[]): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    proc.once("error", reject);
    proc.once("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

export async function setup(): Promise<void> {
  if (await portAccepting(LOCALSTACK_PORT)) {
    await waitForS3Ready(30_000);
    return;
  }

  await runDocker(["rm", "-f", CONTAINER_NAME]).catch(() => {
    /* ignore */
  });

  const result = await runDocker([
    "run",
    "--rm",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-p",
    `${LOCALSTACK_PORT}:4566`,
    "-e",
    "SERVICES=s3",
    "-e",
    "DEBUG=0",
    IMAGE,
  ]);

  if (result.status !== 0) {
    throw new Error(
      `Failed to start LocalStack via Docker (exit ${String(result.status)}). ` +
        `Is Docker available? stderr: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  startedContainer = true;
  await waitForPort(LOCALSTACK_PORT, 120_000);
  await waitForS3Ready(120_000);
}

export async function teardown(): Promise<void> {
  if (!startedContainer) {
    return;
  }
  await runDocker(["rm", "-f", CONTAINER_NAME]).catch(() => {
    /* best-effort */
  });
  startedContainer = false;
}
