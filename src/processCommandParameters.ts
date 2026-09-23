export type ProcessCommandParameter = {
  name: string;
  desc: string;
  type: "option" | "string" | "number";
  default: string | number;
  options?: string[];
};

export type ProcessCommandValues = Record<string, string | number>;

export function normalizeCommandParameters(input: unknown): ProcessCommandParameter[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > 32) throw new Error("parameters must be an array of at most 32 definitions.");
  const names = new Set<string>();
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid parameter definition.");
    const { name, desc, type, options } = item;
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || names.has(name)) {
      throw new Error("Parameter names must be unique identifiers starting with a letter.");
    }
    names.add(name);
    if (typeof desc !== "string" || desc.length > 2000) throw new Error(`Parameter ${name} requires a desc string (max 2000 characters).`);
    if (!["option", "string", "number"].includes(type)) throw new Error(`Parameter ${name} has an invalid type.`);
    if (type === "option" && (!Array.isArray(options) || options.length === 0 || options.length > 100 ||
      options.some((value) => typeof value !== "string" || !value || value.length > 4000 || value.includes("\0")) || new Set(options).size !== options.length)) {
      throw new Error(`Parameter ${name} requires distinct non-empty string options.`);
    }
    const parameter: ProcessCommandParameter = { name, desc, type, default: item.default, ...(type === "option" ? { options: [...options] } : {}) };
    validateCommandValue(parameter, parameter.default);
    return parameter;
  });
}

function validateCommandValue(parameter: ProcessCommandParameter, value: unknown): asserts value is string | number {
  if (parameter.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Parameter ${parameter.name} requires a finite number.`);
  } else if (typeof value !== "string" || value.length > 4000 || value.includes("\0")) {
    throw new Error(`Parameter ${parameter.name} requires a string (max 4000 characters).`);
  } else if (parameter.type === "option" && !parameter.options?.includes(value)) {
    throw new Error(`Parameter ${parameter.name} must be one of its options.`);
  }
}

export function resolveCommandValues(parameters: ProcessCommandParameter[], input: unknown = {}): ProcessCommandValues {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("parameterValues must be an object.");
  for (const name of Object.keys(input)) {
    if (!parameters.some((parameter) => parameter.name === name)) throw new Error(`Unknown parameter: ${name}.`);
  }
  return Object.fromEntries(parameters.map((parameter) => {
    const value = Object.hasOwn(input, parameter.name) ? (input as Record<string, unknown>)[parameter.name] : parameter.default;
    validateCommandValue(parameter, value);
    return [parameter.name, value];
  }));
}

/** Each replacement remains inside its original argv entry, including spaces and shell punctuation. */
export function interpolateCommandArgs(args: string[], values: ProcessCommandValues): string[] {
  return args.map((arg) => arg.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Unknown parameter placeholder: ${name}.`);
    return String(values[name]);
  }));
}
