export const USER_INPUT_METHOD = "item/tool/requestUserInput";
export type InputQuestion = { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; multiSelect?: boolean; options?: Array<{ label: string; description: string }> | null };
export type InputResponse = { answers: Record<string, { answers: string[] }> };
export type AsyncInputQuestion = { title: string; options?: string[] };

export function asyncInputQuestions(value: unknown): AsyncInputQuestion[] {
  if (!Array.isArray(value) || !value.length) return [];
  return value.every((q) => q && typeof q.title === "string" && q.title.trim() &&
    (q.options === undefined || (Array.isArray(q.options) && q.options.every((o: unknown) => typeof o === "string")))) ? value : [];
}

export function asyncInputParams(questions: AsyncInputQuestion[]) {
  return { isBlocking: false, delivery: "async", questions: questions.map((q, index) => ({
    id: String(index), header: `Question ${index + 1}`, question: q.title, isOther: true,
    options: q.options?.map((label) => ({ label, description: "" }))
  })) };
}

export function asyncAnswerText(questions: AsyncInputQuestion[], response: InputResponse) {
  return questions.map((q, index) => `${q.title}\nAnswer: ${response.answers[String(index)].answers.join("\n")}`).join("\n\n");
}

export function inputQuestions(params: unknown): InputQuestion[] {
  if (!params || typeof params !== "object") return [];
  const questions = (params as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  const ids = new Set<string>();
  for (const q of questions) {
    if (!q || typeof q.id !== "string" || !q.id || ids.has(q.id) || typeof q.question !== "string" || typeof q.header !== "string") return [];
    if (q.options != null && (!Array.isArray(q.options) || q.options.some((o: unknown) => !o || typeof o !== "object" || typeof (o as { label?: unknown }).label !== "string" || typeof (o as { description?: unknown }).description !== "string"))) return [];
    ids.add(q.id);
  }
  return questions;
}

export function inputResponse(value: unknown, params: unknown): InputResponse | null {
  const questions = inputQuestions(params);
  if (!questions.length || !value || typeof value !== "object") return null;
  const answers = (value as InputResponse).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  if (Object.keys(answers).length !== questions.length) return null;
  for (const q of questions) {
    if (!Object.hasOwn(answers, q.id)) return null;
    const list = answers[q.id]?.answers;
    const multi = q.multiSelect === true && !!q.options?.length;
    if (!Array.isArray(list) || (multi ? !list.length : list.length !== 1) || list.some((a) => typeof a !== "string" || !a.trim())) return null;
    if (multi && new Set(list).size !== list.length) return null;
    if (q.options?.length && !q.isOther && list.some((a) => !q.options!.some((o) => o.label === a))) return null;
  }
  return { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: [...answers[q.id].answers] }])) };
}
