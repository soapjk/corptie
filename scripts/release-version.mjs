import { readFile, writeFile, rename, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
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

async function readCounter(root) {
  try {
    return JSON.parse(await readFile(join(root, "release-version.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Fresh checkouts have no local packaging counter. Keep reads free of
    // writes; only successful packaging materializes the next version.
    return { version: "0.5.14", buildNumber: 9 };
  }
}

export async function readNextRelease(root) {
  return nextReleaseVersion(await readCounter(root));
}

// The packaging caller holds .corptie/release-version.lock until cleanup.
// Commit only after both installers succeed; reject edits made during a build.
async function writeCounter(root, next) {
  const temporary = join(root, ".corptie/release-version.lock/version.next");
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, join(root, "release-version.json"));
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function commitRelease(root, expected) {
  const next = await readNextRelease(root);
  if (next.version !== expected.version || next.buildNumber !== expected.buildNumber) {
    throw new Error("Release version changed during packaging; refusing to overwrite it");
  }
  await writeCounter(root, next);
}

// Release orchestrator flow: GitHub tags are the version source of truth and are
// passed in from outside; only the build number stays monotonic locally.
export async function adoptRelease(root, expected) {
  const current = await readCounter(root);
  const match = typeof expected?.version === "string"
    && expected.version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match || !Number.isSafeInteger(expected.buildNumber) || expected.buildNumber < 1
      || expected.buildNumber > 9999 || expected.buildNumber !== current.buildNumber + 1) {
    throw new Error("Invalid adopt version or stale build number in release-version.json");
  }
  await writeCounter(root, { version: expected.version, buildNumber: expected.buildNumber });
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const [command, root, version, build] = process.argv.slice(2);
  try {
    if (command === "next" && root && !version) {
      const next = await readNextRelease(root);
      console.log(`${next.version} ${next.buildNumber}`);
    } else if (command === "next-build" && root && !version) {
      const current = await readCounter(root);
      if (!Number.isSafeInteger(current.buildNumber) || current.buildNumber < 1
          || current.buildNumber >= 9999) {
        throw new Error("Invalid or exhausted build number in release-version.json");
      }
      console.log(String(current.buildNumber + 1));
    } else if (command === "commit" && root && version && build) {
      await commitRelease(root, { version, buildNumber: Number(build) });
    } else if (command === "adopt" && root && version && build) {
      await adoptRelease(root, { version, buildNumber: Number(build) });
    } else {
      throw new Error("Usage: release-version.mjs next ROOT | next-build ROOT | commit ROOT VERSION BUILD | adopt ROOT VERSION BUILD");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
