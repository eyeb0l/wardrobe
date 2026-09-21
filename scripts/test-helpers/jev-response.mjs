import { JEV_MODEL } from "../jev.mjs";

export function jevResponse(body, overrides = {}) {
  return { model: JEV_MODEL, usage: { input_tokens: 123 }, answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key, question.type === "choice" ? { type: "choice", choice: "sufficient", confidence: .8 } : { type: "score", score: key.startsWith("match") ? 2.7 : 1, confidence: .8 }])), ...overrides };
}
