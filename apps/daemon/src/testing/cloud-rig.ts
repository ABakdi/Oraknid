import { spawnSync } from "node:child_process";
import { findRclone } from "../cloud/rclone.ts";
import { container, docker, hasDocker, until } from "./backup-rig.ts";

// Cloud storage's test rig (ADR-046): a real rclone (on the PATH, or
// ORAKNID_TEST_RCLONE), a real MinIO in a throwaway unprivileged
// container (removed after).

/** The rclone the tests run, or null (those tests are skipped, saying so). */
export const testRclone = (() => {
  const pinned = process.env.ORAKNID_TEST_RCLONE;
  if (pinned) return findRclone({ ORAKNID_RCLONE: pinned });
  return findRclone();
})();

/** MinIO's image: MinIO stopped publishing to Docker Hub; Chainguard builds it. */
export const MINIO_IMAGE =
  process.env.ORAKNID_TEST_MINIO_IMAGE ?? "cgr.dev/chainguard/minio:latest";

export const hasMinio = (() => {
  if (!hasDocker) return false;
  if (spawnSync("docker", ["image", "inspect", MINIO_IMAGE]).status === 0) return true;
  return spawnSync("docker", ["pull", "-q", MINIO_IMAGE], { timeout: 300_000 }).status === 0;
})();

export const cloudSkip = !testRclone
  ? "rclone isn't installed here (set ORAKNID_TEST_RCLONE to an rclone binary): the cloud storage tests against MinIO are skipped."
  : !hasMinio
    ? `Docker or the ${MINIO_IMAGE} image isn't available: the cloud storage tests against MinIO are skipped.`
    : null;
if (cloudSkip) console.warn(cloudSkip);

/** A MinIO server: its address and its root login. */
export async function minio() {
  const user = `minio-${Math.random().toString(36).slice(2, 8)}`;
  const password = `Mn-S3cr3t-${Math.random().toString(36).slice(2, 12)}`;
  const name = container("minio", [
    "-p",
    "127.0.0.1::9000",
    "-e",
    `MINIO_ROOT_USER=${user}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${password}`,
    MINIO_IMAGE,
    "server",
    "/data",
  ]);
  const port = Number(docker("port", name, "9000").split("\n")[0]?.split(":").pop());
  const endpoint = `http://127.0.0.1:${port}`;
  await until("minio", () => {
    const r = spawnSync("curl", ["-sf", `${endpoint}/minio/health/live`]);
    return r.status === 0;
  });
  return { name, endpoint, user, password };
}
