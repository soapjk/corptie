import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import test from "node:test";

import { saveAgentAvatar, saveWorkAvatar } from "../src/runtime/agentAvatar.mjs";

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

test("Agent avatars preserve the SVG extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-agent-avatar-svg-"));
  const source = join(directory, "avatar.svg");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="12"/></svg>';
  await writeFile(source, svg);

  try {
    const managed = await saveAgentAvatar("agent:svg", source, {
      corptieHome: join(directory, "corptie"),
      environmentName: "development"
    });
    assert.equal(dirname(managed).endsWith("/agents/agent:svg"), true);
    assert.equal(extname(managed), ".svg");
    assert.equal(await readFile(managed, "utf8"), svg);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("replacing a Role upload uses a new display-cache reference and failed imports preserve it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-role-avatar-replace-"));
  const source = join(directory, "image.png");
  const options = { corptieHome: join(directory, "corptie"), environmentName: "development" };
  try {
    await writeFile(source, "first-image");
    const first = await saveAgentAvatar("role:one", source, options);
    await assert.rejects(saveAgentAvatar("role:one", join(directory, "missing.png"), options));
    assert.equal(await readFile(first, "utf8"), "first-image");
    await writeFile(source, "second-image");
    const second = await saveAgentAvatar("role:one", source, options);
    assert.notEqual(first, second);
    assert.equal(await readFile(second, "utf8"), "second-image");
    const builtin = "corptie-role-avatar://v1/robot-03";
    assert.equal(await saveAgentAvatar("role:one", builtin, options), builtin);
    await assert.rejects(readFile(second));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
