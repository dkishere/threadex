#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const config = {
  container: process.env.SESSION_PG_CONTAINER ?? "threadex-pg-migration",
  volume: process.env.SESSION_PG_VOLUME ?? "threadex-pg-data",
  image: process.env.SESSION_PG_IMAGE ?? "postgres:16-alpine",
  shmSize: process.env.SESSION_PG_SHM_SIZE ?? "256m",
  host: process.env.SESSION_PG_HOST ?? "127.0.0.1",
  port: process.env.SESSION_PG_PORT ?? "55432",
  user: process.env.SESSION_PG_USER ?? "threadex",
  password: process.env.SESSION_PG_PASSWORD ?? "threadex",
  database: process.env.SESSION_PG_DATABASE ?? "threadex"
};

const legacyConfig = {
  user: "session_manager",
  password: "session_manager",
  database: "session_manager"
};
const legacyVolume = "session-manager-pg-data";

const command = process.argv[2] ?? "start";
const flags = new Set(process.argv.slice(3));

if (command === "url") {
  console.log(connectionUrl());
  process.exit(0);
}

if (command === "status") {
  const existing = inspectContainer();
  if (!existing) {
    console.log(`missing: ${config.container}`);
    process.exit(1);
  }
  console.log(`${config.container}: ${existing.State.Status}`);
  console.log(`volume: ${mountedVolumeName(existing) ?? "none"}`);
  console.log(`url: ${connectionUrl()}`);
  process.exit(existing.State.Running ? 0 : 1);
}

if (command !== "start") {
  usage(`Unknown command: ${command}`);
}

let existing = inspectContainer();
const activeVolume = existing && hasExpectedVolume(existing) ? mountedVolumeName(existing) ?? config.volume : config.volume;
if (existing && (!hasExpectedVolume(existing) || !hasExpectedPort(existing) || !hasExpectedShmSize(existing))) {
  if (!flags.has("--replace")) {
    console.error(
      `${config.container} does not use the expected local PostgreSQL setup (including at least ${config.shmSize} shared memory). ` +
        "Run `npm run pg:dev -- start --replace` to recreate its container without deleting its volume."
    );
    process.exit(1);
  }
  run("docker", ["rm", "-f", config.container]);
  existing = null;
}

if (!existing) {
  run("docker", ["volume", "create", activeVolume]);
  run("docker", [
    "run",
    "-d",
    "--name",
    config.container,
    "--restart",
    "unless-stopped",
    "--label",
    "com.openai.threadex.keep=true",
    "--shm-size",
    config.shmSize,
    "-e",
    `POSTGRES_PASSWORD=${config.password}`,
    "-e",
    `POSTGRES_USER=${config.user}`,
    "-e",
    `POSTGRES_DB=${config.database}`,
    "-p",
    `${config.host}:${config.port}:5432`,
    "-v",
    `${activeVolume}:/var/lib/postgresql/data`,
    config.image
  ]);
} else if (!existing.State.Running) {
  run("docker", ["start", config.container]);
}

waitReady();
ensureDatabaseAccess();
console.log(`PostgreSQL ready: ${connectionUrl()}`);
console.log(`Container: ${config.container}`);
console.log(`Volume: ${mountedVolumeName(inspectContainer()) ?? config.volume}`);

function waitReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync("docker", ["exec", config.container, "pg_isready", "-U", config.user, "-d", config.database], {
      encoding: "utf8"
    });
    if (result.status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(`PostgreSQL did not become ready in ${config.container}.`);
}

function ensureDatabaseAccess() {
  if (canConnect(config)) {
    return;
  }

  if (hasExplicitCredentials() || !canConnect(legacyConfig)) {
    throw new Error(
      `PostgreSQL is ready but ${config.user} cannot authenticate to ${config.database}. ` +
        "Set SESSION_PG_USER, SESSION_PG_PASSWORD, and SESSION_PG_DATABASE to the existing credentials, or recreate the local database volume."
    );
  }

  console.log("Migrating the legacy local PostgreSQL identity to Threadex...");
  executeSql(legacyConfig, "postgres", `ALTER DATABASE ${quoteIdentifier(legacyConfig.database)} RENAME TO ${quoteIdentifier(config.database)}`);
  executeSql(legacyConfig, config.database, `ALTER ROLE ${quoteIdentifier(legacyConfig.user)} RENAME TO ${quoteIdentifier(config.user)}`);
  executeSql(
    { ...config, password: legacyConfig.password },
    config.database,
    `ALTER ROLE ${quoteIdentifier(config.user)} PASSWORD ${quoteLiteral(config.password)}`
  );

  if (!canConnect(config)) {
    throw new Error(`Threadex PostgreSQL migration completed, but ${config.user} still cannot authenticate.`);
  }
}

function hasExplicitCredentials() {
  return ["SESSION_PG_USER", "SESSION_PG_PASSWORD", "SESSION_PG_DATABASE"].some((key) => process.env[key] !== undefined);
}

function canConnect({ user, password, database }) {
  const result = spawnSync(
    "docker",
    ["exec", "-e", `PGPASSWORD=${password}`, config.container, "psql", "-qAt", "-h", "127.0.0.1", "-U", user, "-d", database, "-c", "SELECT 1"],
    { encoding: "utf8" }
  );
  return result.status === 0 && result.stdout.trim() === "1";
}

function executeSql({ user, password }, database, sql) {
  const result = spawnSync(
    "docker",
    ["exec", "-e", `PGPASSWORD=${password}`, config.container, "psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database, "-c", sql],
    { encoding: "utf8", stdio: "inherit" }
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function quoteIdentifier(value) {
  return `\"${value.replaceAll('\"', '\"\"')}\"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function inspectContainer() {
  const result = spawnSync("docker", ["inspect", config.container], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const parsed = JSON.parse(result.stdout);
  return parsed[0] ?? null;
}

function hasExpectedVolume(container) {
  return container.Mounts?.some(
    (mount) =>
      mount.Type === "volume" &&
      (mount.Name === config.volume || mount.Name === legacyVolume) &&
      mount.Destination === "/var/lib/postgresql/data"
  );
}

function hasExpectedPort(container) {
  return container.NetworkSettings?.Ports?.["5432/tcp"]?.some(
    (binding) => binding.HostIp === config.host && binding.HostPort === config.port
  );
}

function hasExpectedShmSize(container) {
  return Number(container.HostConfig?.ShmSize ?? 0) >= parseMemorySize(config.shmSize);
}

function parseMemorySize(value) {
  const match = /^(\d+)([bkmg])?$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid SESSION_PG_SHM_SIZE: ${value}. Use a Docker size such as 256m or 1g.`);
  }
  const units = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(match[1]) * units[(match[2] ?? "b").toLowerCase()];
}

function mountedVolumeName(container) {
  return container.Mounts?.find((mount) => mount.Destination === "/var/lib/postgresql/data")?.Name;
}

function connectionUrl() {
  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`;
}

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function usage(message) {
  if (message) {
    console.error(message);
  }
  console.error("Usage: npm run pg:dev -- [start|status|url] [--replace]");
  process.exit(1);
}
