import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function nextReleaseVersion(current) {
  const match = typeof current?.version === "string"
    && current.version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match || !match.slice(1).every(value => Number.isSafeInteger(Number(value)))
      || !Number.isSafeInteger(current.buildNumber) || current.buildNumber < 1
      || current.buildNumber >= 9999 || !Number.isSafeInteger(Number(match[3]) + 1)) {
    throw new Error("Invalid or exhausted release version/build number in release-version.json");
  }
  return {
    version: `${match[1]}.${match[2]}.${Number(match[3]) + 1}`,
    buildNumber: current.buildNumber + 1,
  };
}

export async function readNextRelease(root) {
  return nextReleaseVersion(JSON.parse(await readFile(join(root, "release-version.json"), "utf8")));
}

// The packaging caller holds .corptie/release-version.lock until cleanup.
// Commit only after both installers succeed; reject edits made during a build.
export async function commitRelease(root, expected) {
  const next = await readNextRelease(root);
  if (next.version !== expected.version || next.buildNumber !== expected.buildNumber) {
    throw new Error("Release version changed during packaging; refusing to overwrite it");
  }
  const temporary = join(root, ".corptie/release-version.lock/version.next");
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, join(root, "release-version.json"));
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, root, version, build] = process.argv.slice(2);
  try {
    if (command === "next" && root && !version) {
      const next = await readNextRelease(root);
      console.log(`${next.version} ${next.buildNumber}`);
    } else if (command === "commit" && root && version && build) {
      await commitRelease(root, { version, buildNumber: Number(build) });
    } else {
      throw new Error("Usage: release-version.mjs next ROOT | commit ROOT VERSION BUILD");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
