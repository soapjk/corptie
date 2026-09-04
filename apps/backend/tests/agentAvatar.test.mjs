import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveWorkAvatar } from "../src/runtime/agentAvatar.mjs";

test("Work avatars preserve the SVG extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-work-avatar-svg-"));
  const source = join(directory, "avatar.svg");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24"/></svg>';
  await writeFile(source, svg);

  try {
    const managed = await saveWorkAvatar("work:svg", source, {
      corptieHome: join(directory, "corptie"),
      environmentName: "development"
    });
    assert.equal(managed.endsWith("/works/work:svg/avatar.svg"), true);
    assert.equal(await readFile(managed, "utf8"), svg);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
