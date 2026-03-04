import { mkdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { loadFlutterFlowApiConfig } from "./ff/config.js";
import { HttpFlutterFlowAdapter } from "./ff/adapter.js";
import { openOrbitDb } from "./store/db.js";
import { SnapshotRepo } from "./store/snapshotRepo.js";
import { IndexRepo } from "./store/indexRepo.js";
import { PolicyEngine } from "./policy/engine.js";
import { ChangesetService } from "./edits/changesets.js";
import { OrbitCommandPalette } from "./mcp/orbitTool.js";
import { buildMcpServer } from "./mcp/server.js";
import { extractSnapshotIndex } from "./indexer/extract.js";
import { startHttpServer } from "./http/server.js";

const VERSION = "0.1.0";

function resolveDbPath(): string {
  const raw = process.env.ORBIT_DB_PATH?.trim() || path.resolve(process.cwd(), ".orbit", "orbit.sqlite");
  mkdirSync(path.dirname(raw), { recursive: true });
  return raw;
}

async function main(): Promise<void> {
  const db = openOrbitDb({ dbPath: resolveDbPath() });
  const snapshotRepo = new SnapshotRepo(db);
  const indexRepo = new IndexRepo(db);

  const adapter = new HttpFlutterFlowAdapter(loadFlutterFlowApiConfig());
  const policyEngine = new PolicyEngine();
  await policyEngine.reload();

  const reindexSnapshot = async (snapshotId: string): Promise<void> => {
    const files = snapshotRepo
      .listFiles(snapshotId, undefined, 15_000)
      .map((file) => ({ fileKey: file.fileKey, yaml: file.yaml }));
    const extracted = extractSnapshotIndex(snapshotId, files);
    indexRepo.replaceSnapshotIndices(snapshotId, extracted.symbols, extracted.edges);
  };

  const changesets = new ChangesetService(db, snapshotRepo, policyEngine, adapter, reindexSnapshot);
  const orbit = new OrbitCommandPalette(adapter, snapshotRepo, indexRepo, changesets, policyEngine);
  const mcp = buildMcpServer(orbit, policyEngine);

  let httpServer: { close: () => void } | undefined;
  const httpPort = Number.parseInt(process.env.PORT ?? "8080", 10) || 8080;
  const httpEnabled = process.env.ORBIT_HTTP_ENABLED?.trim() !== "0";
  if (httpEnabled) {
    try {
      httpServer = await startHttpServer({
        port: httpPort,
        getStatus: () => {
          const status = snapshotRepo.getStatusSummary();
          return {
            version: VERSION,
            snapshots: status.snapshotCount,
            recentRefreshes: status.recentRefreshes
          };
        },
        getPolicySummary: () => {
          const policy = policyEngine.getPolicy();
          return {
            safeMode: policy.safeMode,
            requireManualApproval: policy.requireManualApproval,
            allowPlatformConfigEdits: policy.allowPlatformConfigEdits,
            maxFilesPerApply: policy.maxFilesPerApply,
            maxLinesChanged: policy.maxLinesChanged,
            allowProjects: policy.allowProjects,
            allowFileKeyPrefixes: policy.allowFileKeyPrefixes,
            denyFileKeyPrefixes: policy.denyFileKeyPrefixes
          };
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Orbit HTTP server disabled: ${message}. MCP stdio server will continue without HTTP endpoints.\n`
      );
    }
  }

  await mcp.startStdio();

  const shutdown = () => {
    httpServer?.close();
    (db as Database.Database).close();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Orbit startup failed: ${message}\n`);
  process.exit(1);
});
