const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 12;
const MAX_ANSWER_LENGTH = 4_000;

export function normalizeCodexUserInputRequest(request) {
  if (request?.method !== "item/tool/requestUserInput") return null;
  const params = request.params ?? {};
  const requestId = request.requestId == null ? "" : String(request.requestId);
  const turnId = boundedText(params.turnId, 200);
  if (!requestId || requestId.length > 200 || !turnId) return null;
  if (!Array.isArray(params.questions) || params.questions.length < 1
    || params.questions.length > MAX_QUESTIONS) return null;
  const ids = new Set();
  const questions = [];
  for (const source of params.questions) {
    const id = boundedText(source?.id, 200);
    const question = boundedText(source?.question, 2_000);
    const header = source?.header === "" ? "" : boundedText(source?.header, 200);
    if (!id || ids.has(id) || !question || header == null
      || typeof source?.isOther !== "boolean" || typeof source?.isSecret !== "boolean") return null;
    ids.add(id);
    if (source.options != null && (!Array.isArray(source.options)
      || source.options.length < 1 || source.options.length > MAX_OPTIONS)) return null;
    const options = source.options == null ? null : [];
    const optionLabels = new Set();
    for (const option of source.options ?? []) {
      const label = boundedText(option?.label, 200);
      const description = option?.description === "" ? "" : boundedText(option?.description, 500);
      if (!label || description == null || optionLabels.has(label)) return null;
      optionLabels.add(label);
      options.push({ label, description });
    }
    questions.push({ id, header, question, isOther: source.isOther,
      isSecret: source.isSecret, options });
  }
  return { schemaVersion: 1, requestId,
    turnId,
    isBlocking: params.isBlocking === true, questions };
}

export function codexUserInputItem(threadId, request) {
  const userInput = normalizeCodexUserInputRequest(request);
  if (!userInput || typeof threadId !== "string" || !threadId) return null;
  return {
    id: `${threadId}:app-server-user-input:${userInput.requestId}`,
    turnId: userInput.turnId,
    turnStatus: userInput.isBlocking ? "blocked" : "inProgress",
    type: "userInput",
    title: "需要输入",
    text: userInput.questions[0].question,
    status: "pending",
    createdAt: request.params?.createdAt ?? null,
    // This is an adapter projection of question definitions, never answers.
    rawMetadataJSON: JSON.stringify({ userInput: {
      schemaVersion: userInput.schemaVersion,
      isBlocking: userInput.isBlocking,
      questions: userInput.questions
    } })
  };
}

export function codexUserInputResponse(request, answers) {
  const normalized = normalizeCodexUserInputRequest(request);
  if (!normalized || !answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw invalidAnswer("The Codex input request or answers are invalid.");
  }
  const expected = new Set(normalized.questions.map((question) => question.id));
  if (Object.keys(answers).length !== expected.size
    || Object.keys(answers).some((id) => !expected.has(id))) {
    throw invalidAnswer("Every Codex question needs exactly one answer entry.");
  }
  const result = Object.create(null);
  for (const question of normalized.questions) {
    const values = answers[question.id];
    if (!Array.isArray(values) || values.length < 1 || values.length > MAX_OPTIONS
      || values.some((value) => typeof value !== "string" || !value.trim()
        || value.length > MAX_ANSWER_LENGTH)) {
      throw invalidAnswer(`Answer for ${question.id} is invalid.`);
    }
    if (question.options && !question.isOther) {
      const labels = new Set(question.options.map((option) => option.label));
      if (values.some((value) => !labels.has(value))) {
        throw invalidAnswer(`Answer for ${question.id} is not a declared option.`);
      }
    }
    if (question.options == null && values.length !== 1) {
      throw invalidAnswer(`Free-text question ${question.id} needs one answer.`);
    }
    result[question.id] = { answers: values };
  }
  return { answers: result };
}

function boundedText(value, limit) {
  return typeof value === "string" && value.length <= limit && value.trim()
    ? value : null;
}

function invalidAnswer(message) {
  return Object.assign(new Error(message), { code: "INVALID_USER_INPUT_ANSWER" });
}
