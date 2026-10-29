import type { ActorAllocation, ActorRoom, ActorWorkItem } from "../domainActors";

/** Only a saved partition grants cross-tree coordination, never a shared prompt. */
export function sharedActorAllocation(room: ActorRoom, source: ActorWorkItem, target?: ActorWorkItem): string | undefined {
  if (!target || source.roundId !== target.roundId) return;
  const round = room.rounds?.find(r => r.id === source.roundId);
  if (round?.allocation && round.workItemIds?.includes(source.id) && round.workItemIds.includes(target.id)) return round.id;
}

export function actorAllocationBrief(plan: ActorAllocation, assignment: ActorAllocation["assignments"][number], messages: string[]) {
  const requirements = plan.requirements.filter(req => assignment.requirementIds.includes(req.id))
    .map(req => ({ ...req, source: messages[req.messageIndex].slice(req.start, req.end) }));
  const coordination = plan.assignments.map(({ id, actorId, requirementIds, dependsOn }) => ({ id, actorId, requirementIds, dependsOn }));
  return [assignment.brief, `Assigned requirements: ${JSON.stringify(requirements)}`,
    `Coordination and dependencies: ${JSON.stringify(coordination)}`,
    `Conflict/overlap/gap resolutions: ${JSON.stringify(plan.review)}`,
    "Execute only your assigned requirements. Preserve the canonical constraints and coordinate dependencies before integrating shared changes."].join("\n\n");
}

export class ActorAllocationValidationError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`Invalid partial-claim allocation [${code}]: ${detail}`);
    this.name = "ActorAllocationValidationError";
  }
}

export function actorAllocationSchema(actorIds: string[], messageCount: number) {
  const string = { type: "string", minLength: 1, maxLength: 12000 };
  const id = { ...string, maxLength: 100 };
  const strings = { type: "array", items: string, maxItems: 256 };
  const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  return object({
    error: { type: ["string", "null"], maxLength: 2000 },
    requirements: { type: "array", maxItems: 256, items: object({ id, messageIndex: { type: "integer", minimum: 0, maximum: messageCount - 1 },
      source: { ...string, maxLength: 100000 }, description: string }) },
    assignments: { type: "array", maxItems: 32, items: object({ id, actorId: { type: "string", enum: actorIds },
      requirementIds: { type: "array", items: id, minItems: 1, maxItems: 256 }, brief: string,
      dependsOn: { type: "array", items: id, maxItems: 32 } }) },
    review: object({ overlaps: strings, conflicts: strings, uncovered: strings }),
    integrationAssignmentId: id
  });
}

/** New model responses quote source text; the server derives UTF-16 offsets.
 * Numeric spans remain accepted for saved plans and older workers. */
export function validateActorAllocation(value: unknown, messages: string[], actorIds: string[]): ActorAllocation {
  const plan = structuredClone(value) as ActorAllocation;
  const invalid = (code: string, detail: string): never => { throw new ActorAllocationValidationError(code, detail); };
  const text = (s: unknown, max = 12000): s is string => typeof s === "string" && !!s.trim() && s.length <= max;
  const refusal = (plan as unknown as { error?: unknown })?.error;
  if (text(refusal, 2000)) return invalid("unresolved_plan", refusal);
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.requirements) || !plan.requirements.length || plan.requirements.length > 256)
    return invalid("requirements", "Expected 1–256 requirements.");
  if (!Array.isArray(plan.assignments) || plan.assignments.length < 2 || plan.assignments.length > 32)
    return invalid("assignments", "Expected 2–32 assignments.");
  if (!plan.review || ![plan.review.overlaps, plan.review.conflicts, plan.review.uncovered].every(a => Array.isArray(a) && a.length <= 256 && a.every(s => text(s))))
    return invalid("review", "overlaps, conflicts and uncovered must each be an array of resolution strings (empty when none).");
  const requirements = new Set<string>();
  const spans = messages.map(() => [] as Array<{ start: number; end: number }>);
  for (const [index, req] of plan.requirements.entries()) {
    if (!req || !text(req.id, 100) || !text(req.description)) return invalid("requirement_fields", `requirements[${index}] needs an id and description.`);
    if (requirements.has(req.id)) return invalid("duplicate_requirement", `requirements[${index}] repeats an id.`);
    if (!Number.isInteger(req.messageIndex) || !messages[req.messageIndex]) return invalid("source_message", `requirements[${index}] must reference an existing messageIndex.`);
    const quoted = req as typeof req & { source?: unknown };
    if (quoted.source !== undefined) {
      if (!text(quoted.source, messages[req.messageIndex].length)) return invalid("source_quote", `requirements[${index}].source must quote nonempty original text.`);
      const start = messages[req.messageIndex].indexOf(quoted.source);
      if (start < 0) return invalid("source_quote", `requirements[${index}].source does not exactly match message ${req.messageIndex}; preserve its whitespace and punctuation.`);
      if (messages[req.messageIndex].indexOf(quoted.source, start + 1) >= 0) return invalid("ambiguous_source", `requirements[${index}].source occurs more than once; quote a longer unique span.`);
      req.start = start; req.end = start + quoted.source.length;
      delete quoted.source;
    }
    if (!Number.isInteger(req.start) || !Number.isInteger(req.end) || req.start < 0 || req.end <= req.start || req.end > messages[req.messageIndex].length)
      return invalid("source_bounds", `requirements[${index}] must lie within message ${req.messageIndex} (length ${messages[req.messageIndex].length}). Prefer an exact source quote.`);
    requirements.add(req.id); spans[req.messageIndex].push(req);
  }
  for (const [index, ranges] of spans.entries()) {
    let end = 0;
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      if (range.start < end) return invalid("source_overlap", `Message ${index} has overlapping requirement spans at offset ${range.start}. Each source span must belong to one requirement.`);
      if (messages[index].slice(end, range.start).trim()) return invalid("source_gap", `Message ${index} has unaccounted source text at offsets ${end}–${range.start}. Include it in a requirement.`);
      end = range.end;
    }
    if (messages[index].slice(end).trim()) return invalid("source_gap", `Message ${index} has unaccounted source text at offsets ${end}–${messages[index].length}. Include it in a requirement.`);
  }
  const assigned = new Set<string>(), ids = new Set<string>();
  for (const [index, item] of plan.assignments.entries()) {
    if (!item || !text(item.id, 100) || !text(item.brief) || !Array.isArray(item.requirementIds) || !item.requirementIds.length
      || !Array.isArray(item.dependsOn) || item.dependsOn.some(id => !text(id, 100))) return invalid("assignment_fields", `assignments[${index}] needs id, brief, nonempty requirementIds and a dependsOn array of assignment IDs.`);
    if (ids.has(item.id)) return invalid("duplicate_assignment", `assignments[${index}] repeats an id.`);
    if (!actorIds.includes(item.actorId)) return invalid("unknown_actor", `assignments[${index}] must name one of the claiming actors.`);
    ids.add(item.id);
    for (const id of item.requirementIds) {
      if (!requirements.has(id)) return invalid("unknown_requirement", `assignments[${index}] references a requirement that does not exist.`);
      if (assigned.has(id)) return invalid("duplicate_owner", `assignments[${index}] claims a requirement already owned by another assignment. Assign each requirement exactly once.`);
      assigned.add(id);
    }
  }
  if (assigned.size !== requirements.size) return invalid("unassigned_requirement", `${requirements.size - assigned.size} requirement(s) have no assigned actor.`);
  if (new Set(plan.assignments.map(a => a.actorId)).size < 2) return invalid("single_actor", "A partial split must assign work to at least two distinct claiming actors.");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) return invalid("dependency_cycle", "Assignment dependencies contain a cycle; choose one owner and an acyclic integration order.");
    if (!ids.has(id)) return invalid("unknown_dependency", "dependsOn references an assignment that does not exist.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of plan.assignments.find(a => a.id === id)!.dependsOn) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  const integration = (plan as { integrationAssignmentId?: unknown }).integrationAssignmentId;
  if (integration !== undefined && integration !== null) {
    if (!text(integration, 100) || !ids.has(integration)) return invalid("unknown_integration", "integrationAssignmentId must name one of the assignment IDs.");
  } else {
    // A plan without an owner still needs one host: the assignment integrating the most others.
    plan.integrationAssignmentId = [...plan.assignments].sort((a, b) => b.dependsOn.length - a.dependsOn.length)[0].id;
  }
  return structuredClone(plan);
}
