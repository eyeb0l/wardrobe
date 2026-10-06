export const decisionMetadata = body => JSON.parse(body.input[0].content[0].text);
export function decisionsResponse(body) {
  return { model: body.model, usage: { input_tokens: 123, output_tokens: 0 }, answers: body.questions.map(question => {
    if (question.type === "predicate") return { type: "predicate", name: question.name, probability: .8 };
    if (question.type === "score") return { type: "score", name: question.name, score: 1, confidence: .8,
      probabilities: question.levels.map((level, index) => ({ label: level.label, value: index, probability: index === 1 ? 1 : 0 })) };
    const choice = question.name.startsWith("match_") ? "excellent" : question.name.startsWith("evidence_") ? "sufficient" : question.name.startsWith("statement_") ? "balanced" : "clear";
    return { type: "choice", name: question.name, choice, confidence: .8, probabilities: question.choices.map(({ value }) => ({ value,
      probability: question.name.startsWith("match_") ? value === "excellent" ? .7 : value === "good" ? .3 : 0 : value === choice ? 1 : 0 })) };
  }) };
}
