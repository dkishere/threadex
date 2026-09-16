import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type WebVsCodeRequest = {
  protocol: string;
  get(name: string): string | undefined;
};

type ResolveWebVsCodeUrlOptions = {
  defaultPort: number;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
};

export function setWebVsCodePaths(url: URL, folderPath: string, filePath?: string) {
  const uriPath = (path: string) => {
    if (/^[a-z]:[\\/]/i.test(path)) return `/${path.replace(/\\/g, "/")}`;
    return path;
  };
  url.searchParams.set("folder", uriPath(folderPath));
  if (filePath) {
    const encodedPath = uriPath(filePath).split("/").map(encodeURIComponent).join("/");
    url.searchParams.set("payload", JSON.stringify([
      ["gotoLineMode", "true"],
      ["openFile", `vscode-remote://remote${encodedPath}`]
    ]));
  }
}

export function resolveWebVsCodeUrl(
  request: WebVsCodeRequest,
  { defaultPort, projectRoot, env = process.env }: ResolveWebVsCodeUrlOptions
) {
  const configuredUrl = env.WEB_VSCODE_URL?.trim();
  if (configuredUrl) return new URL(configuredUrl);

  const localUrl = new URL(`http://127.0.0.1:${defaultPort}/`);
  const requestHost = forwardedValue(request.get("x-forwarded-host")) ?? request.get("host")?.trim();
  if (!requestHost || isLocalHost(requestHost)) return localUrl;

  const configuredTunnelPath = env.WEB_VSCODE_TUNNEL_CONFIG?.trim();
  const tunnelConfigPath = configuredTunnelPath
    ? resolve(projectRoot, configuredTunnelPath)
    : resolve(projectRoot, "cloudflared", "config.yml");
  const tunnelHost = readWebVsCodeTunnelHost(tunnelConfigPath, defaultPort);
  if (tunnelHost) return new URL(`https://${tunnelHost}/`);

  const protocol = forwardedValue(request.get("x-forwarded-proto"))
    ?? forwardedProtocol(request.get("forwarded"))
    ?? cloudflareProtocol(request.get("cf-visitor"))
    ?? request.protocol
    ?? "https";
  return new URL(`${protocol}://${requestHost}/`);
}

export function readWebVsCodeTunnelHost(configPath: string, port: number) {
  if (!existsSync(configPath)) return null;
  let config: string;
  try {
    config = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  const ingressBlocks = config.split(/(?=^\s*-\s+hostname:\s*)/m);
  for (const block of ingressBlocks) {
    const hostname = block.match(/^\s*-\s+hostname:\s*([^\s#]+)\s*$/m)?.[1];
    const servicePort = block.match(/^\s*service:\s*https?:\/\/(?:127\.0\.0\.1|localhost):([0-9]+)(?:[/?#\s]|$)/m)?.[1];
    if (!hostname || servicePort !== String(port)) continue;
    try {
      const parsed = new URL(`https://${hostname}`);
      if (parsed.hostname !== hostname || isLocalHost(parsed.hostname)) continue;
      return parsed.hostname;
    } catch {
      // Ignore malformed tunnel entries and continue looking for a valid one.
    }
  }
  return null;
}

function forwardedValue(value: string | undefined) {
  return value?.split(",", 1)[0]?.trim() || undefined;
}

function forwardedProtocol(value: string | undefined) {
  const match = value?.match(/(?:^|;)\s*proto=([^;\s]+)/i);
  return match?.[1]?.toLowerCase();
}

function cloudflareProtocol(value: string | undefined) {
  if (!value) return undefined;
  try {
    const scheme = JSON.parse(value).scheme;
    return typeof scheme === "string" ? scheme.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function isLocalHost(host: string) {
  const hostname = host.replace(/^\[/, "").replace(/\](:\d+)?$/, "").split(":", 1)[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
