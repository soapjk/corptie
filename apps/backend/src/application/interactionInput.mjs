export function validateInteractionAnswers(userInput, answers) {
  if (userInput?.schemaVersion !== 1 || !Array.isArray(userInput.questions)
    || userInput.questions.length < 1 || userInput.questions.length > 10
    || !answers || typeof answers !== "object" || Array.isArray(answers)) return false;
  const questions = userInput.questions;
  const ids = new Set(questions.map((question) => question?.id));
  if (ids.size !== questions.length || [...ids].some((id) => typeof id !== "string" || !id)
    || Object.keys(answers).length !== questions.length
    || Object.keys(answers).some((id) => !ids.has(id))) return false;
  for (const question of questions) {
    const values = answers[question.id];
    if (!Array.isArray(values) || values.length < 1 || values.length > 12
      || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 4_000)) return false;
    if (question.options == null) {
      if (values.length !== 1) return false;
    } else {
      if (!Array.isArray(question.options) || question.options.length < 1 || question.options.length > 12) return false;
      const labels = new Set(question.options.map((option) => option?.label));
      if ([...labels].some((label) => typeof label !== "string" || !label)) return false;
      if (question.isOther !== true && values.some((value) => !labels.has(value))) return false;
    }
  }
  return true;
}

export function publicUserInput(userInput) {
  if (userInput?.schemaVersion !== 1 || !Array.isArray(userInput.questions)
    || userInput.questions.length < 1 || userInput.questions.length > 10) return null;
  const questions = [];
  const ids = new Set();
  for (const question of userInput.questions) {
    if (typeof question?.id !== "string" || !question.id || question.id.length > 200
      || ids.has(question.id) || typeof question.question !== "string"
      || !question.question || question.question.length > 2_000) return null;
    ids.add(question.id);
    let options = null;
    if (question.options != null) {
      if (!Array.isArray(question.options) || question.options.length < 1
        || question.options.length > 12) return null;
      options = [];
      const labels = new Set();
      for (const option of question.options) {
        if (typeof option?.label !== "string" || !option.label || option.label.length > 200
          || labels.has(option.label)) return null;
        labels.add(option.label);
        options.push({ label: option.label,
          description: typeof option.description === "string" ? option.description.slice(0, 500) : "" });
      }
    }
    questions.push({ id: question.id,
      header: typeof question.header === "string" ? question.header.slice(0, 200) : "",
      question: question.question,
      isOther: question.isOther === true, isSecret: question.isSecret === true,
      options });
  }
  return { schemaVersion: 1, isBlocking: userInput.isBlocking === true, questions };
}
