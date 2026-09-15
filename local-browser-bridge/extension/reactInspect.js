export function reactInspectExpression(selector) {
    return `(async () => {
    const selector = ${JSON.stringify(selector)};
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const rendererInfo = hook && hook.renderers instanceof Map
      ? Array.from(hook.renderers, ([id, renderer]) => ({
          id,
          packageName: typeof renderer?.rendererPackageName === "string" ? renderer.rendererPackageName : null,
          version: typeof renderer?.version === "string" ? renderer.version : null
        }))
      : [];
    const page = { url: location.href, title: document.title };
    let element;
    try { element = document.querySelector(selector); }
    catch (error) { return { ...page, found: false, selector, reason: error instanceof Error ? "Invalid CSS selector: " + error.message : "Invalid CSS selector", reactDevToolsHook: Boolean(hook), renderers: rendererInfo }; }
    if (!element) return { ...page, found: false, selector, reason: "No matching DOM element", reactDevToolsHook: Boolean(hook), renderers: rendererInfo };
    const fiberKey = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
    if (!fiberKey) return { ...page, found: true, selector, reactDevToolsHook: Boolean(hook), renderers: rendererInfo, reactFiber: false, reason: "The matching element has no React Fiber metadata" };

    const displayName = (fiber) => {
      const type = fiber && (fiber.type || fiber.elementType);
      if (typeof type === "string") return type;
      if (!type) return fiber?.tag === 3 ? "Root" : null;
      const nested = type.render || type.type;
      return type.displayName || type.name || nested?.displayName || nested?.name || null;
    };
    const sourceFileName = (value) => {
      try {
        const url = new URL(value);
        return decodeURIComponent(url.pathname);
      } catch { return value.replace(/[?#].*$/, ""); }
    };
    const directSource = (fiber) => {
      const source = fiber?._debugSource || fiber?.alternate?._debugSource;
      if (!source || typeof source.fileName !== "string" || !source.fileName) return null;
      return {
        fileName: sourceFileName(source.fileName),
        lineNumber: Number.isInteger(source.lineNumber) ? source.lineNumber : null,
        columnNumber: Number.isInteger(source.columnNumber) ? source.columnNumber : null,
        method: "debug-source",
        ...(!fiber?._debugSource ? { fiberVersion: "alternate" } : {})
      };
    };
    // Debug stacks describe creation/render call sites, not component definitions.
    // Keep runtime coordinates explicit: bundlers may require source-map resolution.
    const parseStack = (stack) => {
      if (typeof stack !== "string") return [];
      const frames = [];
      for (const line of stack.split("\\n")) {
        const match = line.trim().match(/^(?:at (.*?) \\((.+):(\\d+):(\\d+)\\)|at (.+):(\\d+):(\\d+)|(.*?)@(.+):(\\d+):(\\d+))$/);
        if (!match) continue;
        const url = match[2] || match[5] || match[9];
        const fileName = sourceFileName(url);
        if (/\\/node_modules\\/|^node:|^<anonymous>/.test(fileName)) continue;
        frames.push({
          name: match[1] || match[8] || null,
          fileName,
          lineNumber: Number(match[3] || match[6] || match[10]),
          columnNumber: Number(match[4] || match[7] || match[11]),
          method: "debug-stack",
          coordinates: "runtime"
        });
        if (frames.length === 12) break;
      }
      return frames;
    };
    const sourceStack = (fiber) => {
      const primary = parseStack(fiber?._debugStack?.stack);
      return primary.length ? primary : parseStack(fiber?.alternate?._debugStack?.stack)
        .map((frame) => ({ ...frame, fiberVersion: "alternate" }));
    };
    const selectedFiber = element[fiberKey];
    const elementStack = sourceStack(selectedFiber);
    const elementSource = directSource(selectedFiber) || elementStack[0] || null;
    // Preserve a nearby location separately; never label an ancestor as the
    // selected element's exact source when React omitted its debug metadata.
    let ancestorSource = null;
    if (!elementSource) {
      const ancestors = new Set();
      for (let parent = selectedFiber.return; parent && ancestors.size < 200; parent = parent.return) {
        if (ancestors.has(parent)) break;
        ancestors.add(parent);
        const stack = sourceStack(parent);
        const source = directSource(parent) || stack[0];
        if (source) {
          ancestorSource = { name: displayName(parent), distance: ancestors.size, source, sourceStack: stack };
          break;
        }
      }
    }
    const components = [];
    const seen = new Set();
    let child = null;
    let fiber = selectedFiber;
    for (; fiber && seen.size < 200 && components.length < 40; child = fiber, fiber = fiber.return) {
      if (seen.has(fiber)) break;
      seen.add(fiber);
      const type = fiber.type || fiber.elementType;
      if (typeof type === "string") continue;
      const name = displayName(fiber);
      if (!name) continue;
      const stack = sourceStack(fiber);
      // An owner's child carries the owner's render stack. The component's
      // own debug stack instead points to the parent that created it.
      const renderSource = (child?._debugOwner === fiber || (fiber.alternate && child?._debugOwner === fiber.alternate))
        ? sourceStack(child).find((frame) => frame.name === name) || null
        : null;
      const creationSource = directSource(fiber) || stack[0] || null;
      components.push({
        name,
        fiberTag: Number.isInteger(fiber.tag) ? fiber.tag : null,
        source: renderSource || creationSource,
        sourceRole: renderSource ? "render-callsite" : creationSource ? "creation-callsite" : null,
        creationSource,
        sourceStack: stack
      });
    }
    return {
      ...page,
      found: true,
      selector,
      reactDevToolsHook: Boolean(hook),
      renderers: rendererInfo,
      reactFiber: true,
      components,
      elementSource,
      ancestorSource,
      elementSourceStatus: elementSource ? "available" : "debug-metadata-unavailable",
      elementSourceStack: elementStack,
      truncated: Boolean(fiber),
      sourceLocationAvailable: Boolean(elementSource) || components.some((component) => component.source !== null)
    };
  })()`;
}
