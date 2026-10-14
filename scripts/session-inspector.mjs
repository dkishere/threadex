#!/usr/bin/env node
import { tsImport } from "tsx/esm/api";
await tsImport("../src/server/sessionInspectorCli.ts", import.meta.url);
