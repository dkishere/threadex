import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type LocalBrowserBridgeConfig = { port?: unknown; cliToken?: unknown };
type LocalBrowserBridgeClientOptions = { configPath?: string; fetchImpl?: typeof fetch; timeoutMs?: number };
type PageValueMapping = { urlPrefix: string; values: Record<string, unknown> };

export class LocalBrowserBridgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LocalBrowserBridgeError";
  }
}

/** Authenticated client for the standalone Local Browser Bridge daemon. */
export class LocalBrowserBridgeClient {
  constructor(private readonly options: LocalBrowserBridgeClientOptions = {}) {}

  async command(command: Record<string, unknown>): Promise<unknown> {
    const config = await this.config();
    const response = await (this.options.fetchImpl ?? fetch)(`http://127.0.0.1:${config.port}/v1/command`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.cliToken}` },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000)
    });
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; result?: unknown };
    if (!response.ok || payload.ok !== true) {
      throw new LocalBrowserBridgeError(payload.error || `Local Browser Bridge returned HTTP ${response.status}.`, response.status);
    }
    return payload.result;
  }

  async pageValueMappings(): Promise<PageValueMapping[]> {
    return readMappings(await this.command({ type: "getPageValueMappings" }));
  }

  async replacePageValueMappings(mappings: unknown): Promise<PageValueMapping[]> {
    return readMappings(await this.command({ type: "setPageValueMappings", mappings }));
  }

  private async config(): Promise<{ port: number; cliToken: string }> {
    const configPath = this.options.configPath
      ?? join(process.env.LOCAL_BROWSER_BRIDGE_DATA_DIR || join(homedir(), ".local-browser-bridge"), "config.json");
    let config: LocalBrowserBridgeConfig;
    try {
      config = JSON.parse(await readFile(configPath, "utf8")) as LocalBrowserBridgeConfig;
    } catch {
      throw new LocalBrowserBridgeError("Local Browser Bridge is not configured. Run `browser-bridge start` first.");
    }
    const port = Number(config.port);
    const cliToken = typeof config.cliToken === "string" ? config.cliToken : "";
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Za-z0-9_-]{32,128}$/.test(cliToken)) {
      throw new LocalBrowserBridgeError("Local Browser Bridge config is invalid.");
    }
    return { port, cliToken };
  }
}

function readMappings(result: unknown): PageValueMapping[] {
  const mappings = result && typeof result === "object" && !Array.isArray(result)
    ? (result as { mappings?: unknown }).mappings
    : undefined;
  if (!Array.isArray(mappings)) throw new LocalBrowserBridgeError("Local Browser Bridge returned an invalid mapping response.");
  return mappings as PageValueMapping[];
}
