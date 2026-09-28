export function buildToolChoice(toolName, input, context = {}) {
  if (toolName === "AskUserQuestion") {
    const questions = normalizeAskUserQuestions(input);
    if (questions.length > 0 && questions[0].options.length > 0) {
      const firstQuestion = questions[0];
      return {
        kind: "ask-user",
        title: "Claude needs input",
        text: askUserQuestionText(firstQuestion, 0, questions.length),
        questions,
        originalQuestions: Array.isArray(input?.questions) ? input.questions : null,
        questionIndex: 0,
        answers: {},
        options: askUserQuestionOptions(firstQuestion, 0)
      };
    }
    const question = typeof input?.question === "string" ? input.question.trim() : "Claude needs your input.";
    return {
      kind: "ask-user-unsupported",
      title: "Claude needs input",
      text: `${question}\n\nCurrent Corptie build only supports option-style AskUserQuestion prompts.`,
      options: [
        { id: "deny", label: "Cancel", role: "deny", index: 0, selected: false }
      ]
    };
  }

  const decisionReason = typeof context?.decisionReason === "string" && context.decisionReason.trim()
    ? context.decisionReason.trim()
    : (typeof input?.decisionReason === "string" && input.decisionReason.trim() ? input.decisionReason.trim() : null);
  const blockedPath = typeof context?.blockedPath === "string" && context.blockedPath.trim()
    ? context.blockedPath.trim()
    : (typeof input?.blockedPath === "string" && input.blockedPath.trim() ? input.blockedPath.trim() : null);
  const title = typeof context?.title === "string" && context.title.trim()
    ? context.title.trim()
    : `Allow Claude Code to use tool \`${toolName}\`?`;
  const description = typeof context?.description === "string" && context.description.trim()
    ? context.description.trim()
    : null;
  const details = [
    title,
    description,
    decisionReason,
    blockedPath ? `Path: ${blockedPath}` : null
  ].filter(Boolean).join("\n\n");

  return {
    kind: "tool-approval",
    title: "Claude tool approval",
    text: details,
    toolName,
    toolUseID: context?.toolUseID ?? null,
    suggestions: Array.isArray(context?.suggestions) ? context.suggestions : undefined,
    options: [
      { id: "allow", label: "Allow Once", role: "approve", index: 0, selected: false },
      { id: "allow-always", label: "Always Allow", role: "approve_always", index: 1, selected: false },
      { id: "deny", label: "Deny", role: "deny", index: 2, selected: false }
    ]
  };
}

export function optionResolution(choice, option) {
  if (choice.kind === "tool-approval") {
    if (option.id === "allow") {
      return {
        behavior: "allow",
        updatedInput: {},
        toolUseID: choice.toolUseID ?? undefined
      };
    }
    if (option.id === "allow-always") {
      return {
        behavior: "allow",
        updatedInput: {},
        toolUseID: choice.toolUseID ?? undefined,
        updatedPermissions: permissionUpdatesForAlwaysAllow(choice)
      };
    }
    return {
      behavior: "deny",
      message: "User denied this tool request in Corptie.",
      toolUseID: choice.toolUseID ?? undefined
    };
  }

  if (choice.kind === "ask-user") {
    const question = choice.questions?.[choice.questionIndex ?? 0];
    const key = question?.question ?? "answer";
    return {
      behavior: "allow",
      updatedInput: {
        questions: choice.originalQuestions ?? choice.questions,
        answers: {
          ...(choice.answers ?? {}),
          [key]: option.value ?? option.label
        }
      }
    };
  }

  return { behavior: "deny", message: "This Claude prompt type is not supported in Corptie yet." };
}

function normalizeAskUserQuestions(input = {}) {
  const nested = Array.isArray(input?.questions) ? input.questions : [];
  const source = nested.length > 0
    ? nested
    : (typeof input?.question === "string" ? [{ question: input.question, options: input.options }] : []);
  return source
    .map((question, questionIndex) => ({
      question: String(question?.question ?? "").trim(),
      header: String(question?.header ?? "").trim(),
      multiSelect: question?.multiSelect === true,
      options: (Array.isArray(question?.options) ? question.options : []).map((option, optionIndex) => ({
        label: String(option?.label ?? option?.title ?? option?.value ?? `Option ${optionIndex + 1}`),
        description: String(option?.description ?? "").trim(),
        value: option?.value ?? option?.id ?? option?.label ?? optionIndex
      })),
      sourceIndex: questionIndex
    }))
    .filter((question) => question.question && question.options.length > 0);
}

function askUserQuestionText(question, index, total) {
  const progress = total > 1 ? `Question ${index + 1} of ${total}\n\n` : "";
  const header = question.header ? `${question.header}\n\n` : "";
  const descriptions = question.options
    .filter((option) => option.description)
    .map((option) => `${option.label}: ${option.description}`)
    .join("\n");
  return `${progress}${header}${question.question}${descriptions ? `\n\n${descriptions}` : ""}`;
}

function askUserQuestionOptions(question, questionIndex) {
  return question.options.map((option, optionIndex) => ({
    id: `question-${questionIndex}-option-${optionIndex}`,
    label: option.label,
    role: "message-choice",
    index: optionIndex,
    selected: false,
    value: option.value
  }));
}

export function advanceAskUserChoice(session, pendingDecision, option, { markPendingChoiceItemsSelected, appendItem }) {
  const choice = pendingDecision.choice;
  const questionIndex = choice.questionIndex ?? 0;
  const question = choice.questions?.[questionIndex];
  const nextQuestion = choice.questions?.[questionIndex + 1];
  if (!question || !nextQuestion) {
    return false;
  }

  choice.answers = {
    ...(choice.answers ?? {}),
    [question.question]: String(option.value ?? option.label)
  };
  markPendingChoiceItemsSelected(session, option.id, choice.id);
  session.pendingChoices.delete(choice.id);
  choice.questionIndex = questionIndex + 1;
  choice.id = `${session.id}:choice:${session.nextItemSeq}`;
  choice.text = askUserQuestionText(nextQuestion, choice.questionIndex, choice.questions.length);
  choice.options = askUserQuestionOptions(nextQuestion, choice.questionIndex);
  session.pendingChoices.set(choice.id, pendingDecision);
  session.pendingChoice = choice;
  session.pendingDecision = pendingDecision;
  session.turnState = "requires_action";
  session.phase = "waiting_approval";
  session.updatedAt = new Date().toISOString();
  appendItem(session, {
    id: choice.id,
    type: "choice",
    title: choice.title,
    text: choice.text,
    status: "pending",
    options: choice.options
  });
  return true;
}

function permissionUpdatesForAlwaysAllow(choice) {
  const updates = Array.isArray(choice.suggestions) ? choice.suggestions.slice() : [];
  const toolName = String(choice.toolName ?? "").trim();
  if (toolName && !updates.some((update) => update?.type === "addRules" && update?.behavior === "allow" && Array.isArray(update.rules) && update.rules.some((rule) => rule?.toolName === toolName))) {
    updates.push({
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session"
    });
  }
  return updates.length > 0 ? updates : undefined;
}
