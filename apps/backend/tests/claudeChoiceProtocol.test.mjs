import test from "node:test";
import assert from "node:assert/strict";
import { buildToolChoice, optionResolution, advanceAskUserChoice } from "../src/adapters/claudeChoiceProtocol.mjs";

test("always allow preserves suggested permissions and adds only the missing tool rule", () => {
  const choice = buildToolChoice("Bash", {}, { toolUseID: "tool", suggestions: [] });
  const result = optionResolution(choice, { id: "allow-always" });
  assert.equal(result.behavior, "allow");
  assert.equal(result.toolUseID, "tool");
  assert.deepEqual(result.updatedPermissions, [{
    type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session"
  }]);
  const denial = optionResolution(choice, { id: "deny" });
  assert.equal(denial.behavior, "deny");
});

test("multi-question advancement retains answers and publishes the next pending choice", () => {
  const choice = buildToolChoice("AskUserQuestion", { questions: [
    { question: "First?", options: [{ label: "One" }] },
    { question: "Second?", options: [{ label: "Two" }] }
  ] });
  choice.id = "old-choice";
  const pendingDecision = { choice };
  const session = {
    id: "session", nextItemSeq: 5,
    pendingChoices: new Map([[choice.id, pendingDecision]])
  };
  const calls = [];
  const ports = {
    markPendingChoiceItemsSelected: (...args) => calls.push(["selected", ...args]),
    appendItem: (...args) => calls.push(["append", ...args])
  };
  assert.equal(advanceAskUserChoice(session, pendingDecision, choice.options[0], ports), true);
  assert.equal(session.pendingChoices.has("old-choice"), false);
  assert.equal(session.pendingChoices.get("session:choice:5"), pendingDecision);
  assert.equal(choice.answers["First?"], "One");
  assert.equal(session.turnState, "requires_action");
  assert.deepEqual(calls.map(([kind]) => kind), ["selected", "append"]);
  assert.equal(advanceAskUserChoice(session, pendingDecision, choice.options[0], ports), false);
  assert.deepEqual(optionResolution(choice, choice.options[0]).updatedInput.answers, {
    "First?": "One", "Second?": "Two"
  });
});
