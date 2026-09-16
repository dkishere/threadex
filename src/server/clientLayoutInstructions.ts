export function clientLayoutInstructions(layout: unknown): string | undefined {
  if (layout === "mobile" || layout === "tablet" || layout === "desktop") {
    return `Threadex client mode=${layout}.`;
  }
  return undefined;
}
