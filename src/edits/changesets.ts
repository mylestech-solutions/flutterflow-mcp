import type Database from "better-sqlite3";
import YAML from "yaml";
import type {
  ApplyResult,
  ChangesetEntry,
  ChangesetPreview,
  ChangesetRecord,
  ChangesetValidation,
  FileUpdate,
  ManualApplyPayload,
  PatchSpec,
  PreviewFileDiff
} from "../types.js";
import { orbitId } from "../util/ids.js";
import { nowIso, isSnapshotStale } from "../util/time.js";
import { sha256 } from "../util/hash.js";
import { buildUnifiedDiff, countChangedLines } from "./diff.js";
import { applyPatchSpec } from "./patch.js";
import { validateYamlStructure } from "./validate.js";
import type { FlutterFlowAdapter } from "../ff/adapter.js";
import { FlutterFlowApiError } from "../ff/errors.js";
import { SnapshotRepo } from "../store/snapshotRepo.js";
import { PolicyEngine } from "../policy/engine.js";

interface ChangesetRow {
  changeset_id: string;
  snapshot_id: string;
  title: string;
  intent: string;
  status: ChangesetRecord["status"];
  created_at: string;
  updated_at: string;
  preview_json: string | null;
  validation_json: string | null;
}

interface ChangesetEntryRow {
  entry_id: string;
  changeset_id: string;
  file_key: string;
  patch_spec_json: string;
  note: string | null;
  created_at: string;
}

interface MaterializedPreview {
  preview: ChangesetPreview;
  updates: FileUpdate[];
  changedFiles: Array<{ fileKey: string; linesChanged: number }>;
}

function isPatchSpec(value: unknown): value is PatchSpec {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Record<string, unknown>;
  if (row.type === "yaml-merge" || row.type === "jsonpath") {
    return typeof row.selector === "string";
  }
  if (row.type === "replace-range") {
    return typeof row.start === "number" && typeof row.end === "number" && typeof row.replacement === "string";
  }
  return false;
}

function computeRisk(files: PreviewFileDiff[]): number {
  const linesChanged = files.reduce((sum, file) => sum + file.linesChanged, 0);
  const majorRewrites = files.filter((file) => {
    const oldLines = Math.max(1, file.diff.split("\n").length);
    return file.linesChanged / oldLines > 0.6;
  }).length;

  let score = files.length * 10 + linesChanged * 0.25 + majorRewrites * 15;
  if (files.some((file) => file.fileKey.startsWith("android/") || file.fileKey.startsWith("ios/"))) {
    score += 8;
  }
  // Beast mode: no extra risk penalty for custom code edits
  if (files.some((file) => file.fileKey === "lib/main.dart" || file.fileKey.startsWith("lib/custom_code/"))) {
    score += 5; // mild awareness, not blocking
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

export class ChangesetService {
  constructor(
    private readonly db: Database.Database,
    private readonly snapshotRepo: SnapshotRepo,
    private readonly policyEngine: PolicyEngine,
    private readonly adapter: FlutterFlowAdapter,
    private readonly reindexSnapshot: (snapshotId: string) => Promise<void>
  ) {}

  newChangeset(snapshotId: string, title: string, intent: string): ChangesetRecord {
    const snapshot = this.snapshotRepo.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    const now = nowIso();
    const changesetId = orbitId("chg");

    this.db
      .prepare(
        `INSERT INTO changesets
         (changeset_id, snapshot_id, title, intent, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?)`
      )
      .run(changesetId, snapshotId, title, intent, now, now);

    return {
      changesetId,
      snapshotId,
      title,
      intent,
      status: "draft",
      createdAt: now,
      updatedAt: now
    };
  }

  addEntry(changesetId: string, fileKey: string, patchSpec: PatchSpec, note?: string): ChangesetEntry {
    const changeset = this.getChangeset(changesetId);
    if (!changeset) {
      throw new Error(`Changeset not found: ${changesetId}`);
    }
    if (changeset.status !== "draft" && changeset.status !== "validated") {
      throw new Error(`Changeset status '${changeset.status}' cannot accept new entries`);
    }

    const now = nowIso();
    const entryId = orbitId("entry");

    this.db
      .prepare(
        `INSERT INTO changeset_entries
        (entry_id, changeset_id, file_key, patch_spec_json, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(entryId, changesetId, fileKey, JSON.stringify(patchSpec), note ?? null, now);

    this.touchChangeset(changesetId);

    return {
      entryId,
      changesetId,
      fileKey,
      patchSpec,
      note,
      createdAt: now
    };
  }

  dropChangeset(changesetId: string): void {
    const row = this.mustGetRow(changesetId);
    if (row.status === "applied") {
      throw new Error("Applied changesets cannot be dropped");
    }

    this.db
      .prepare(
        `UPDATE changesets
         SET status = 'dropped', updated_at = ?
         WHERE changeset_id = ?`
      )
      .run(nowIso(), changesetId);
  }

  getChangeset(changesetId: string): ChangesetRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT changeset_id, snapshot_id, title, intent, status, created_at, updated_at, preview_json, validation_json
         FROM changesets
         WHERE changeset_id = ?`
      )
      .get(changesetId) as ChangesetRow | undefined;

    return row ? this.mapChangeset(row) : undefined;
  }

  listChangesets(snapshotId?: string, status?: ChangesetRecord["status"]): ChangesetRecord[] {
    let query =
      `SELECT changeset_id, snapshot_id, title, intent, status, created_at, updated_at, preview_json, validation_json
       FROM changesets`;
    const params: Array<string> = [];
    const where: string[] = [];
    if (snapshotId) {
      where.push("snapshot_id = ?");
      params.push(snapshotId);
    }
    if (status) {
      where.push("status = ?");
      params.push(status);
    }
    if (where.length > 0) {
      query += ` WHERE ${where.join(" AND ")}`;
    }
    query += " ORDER BY updated_at DESC";
    const rows = this.db.prepare(query).all(...params) as ChangesetRow[];
    return rows.map(this.mapChangeset);
  }

  getLatestApplied(snapshotId: string): ChangesetRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT changeset_id, snapshot_id, title, intent, status, created_at, updated_at, preview_json, validation_json
         FROM changesets
         WHERE snapshot_id = ? AND status = 'applied'
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(snapshotId) as ChangesetRow | undefined;
    return row ? this.mapChangeset(row) : undefined;
  }

  getStoredPreview(changesetId: string): ChangesetPreview | undefined {
    const row = this.db
      .prepare(
        `SELECT preview_json
         FROM changesets
         WHERE changeset_id = ?`
      )
      .get(changesetId) as { preview_json: string | null } | undefined;
    if (!row?.preview_json) {
      return undefined;
    }
    try {
      return JSON.parse(row.preview_json) as ChangesetPreview;
    } catch {
      return undefined;
    }
  }

  listEntries(changesetId: string): ChangesetEntry[] {
    const rows = this.db
      .prepare(
        `SELECT entry_id, changeset_id, file_key, patch_spec_json, note, created_at
         FROM changeset_entries
         WHERE changeset_id = ?
         ORDER BY created_at ASC`
      )
      .all(changesetId) as ChangesetEntryRow[];

    return rows.map((row) => {
      const patchSpec = JSON.parse(row.patch_spec_json) as unknown;
      if (!isPatchSpec(patchSpec)) {
        throw new Error(`Invalid patch spec in entry ${row.entry_id}`);
      }

      return {
        entryId: row.entry_id,
        changesetId: row.changeset_id,
        fileKey: row.file_key,
        patchSpec,
        note: row.note ?? undefined,
        createdAt: row.created_at
      };
    });
  }

  preview(changesetId: string): ChangesetPreview {
    const materialized = this.materialize(changesetId);
    this.db
      .prepare(`UPDATE changesets SET preview_json = ?, updated_at = ? WHERE changeset_id = ?`)
      .run(JSON.stringify(materialized.preview), nowIso(), changesetId);

    return materialized.preview;
  }

  validate(changesetId: string): ChangesetValidation {
    const materialized = this.materialize(changesetId);
    const changeset = this.mustGetRow(changesetId);
    const snapshot = this.snapshotRepo.getSnapshot(changeset.snapshot_id);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${changeset.snapshot_id}`);
    }

    const issues = materialized.updates.flatMap((update) => validateYamlStructure(update.fileKey, update.yaml));

    const policy = this.policyEngine.evaluate({
      projectId: snapshot.projectId,
      changedFiles: materialized.changedFiles,
      totalLinesChanged: materialized.preview.impact.linesChanged,
      riskScore: materialized.preview.riskScore,
      snapshotFileKeys: this.snapshotRepo.listFiles(snapshot.snapshotId, undefined, 10_000).map((file) => file.fileKey)
    });

    if (policy.reasons.length > 0) {
      for (const reason of policy.reasons) {
        issues.push({
          code: "policy.block",
          severity: "error",
          message: reason
        });
      }
    }

    if (policy.manualOnly) {
      issues.push({
        code: "policy.manual",
        severity: "warning",
        message: "Policy requires manual approval. Use orbit_export_changeset for payload."
      });
    }

    const valid = !issues.some((issue) => issue.severity === "error") && !policy.manualOnly;
    const result: ChangesetValidation = {
      changesetId,
      valid,
      issues
    };

    this.db
      .prepare(`UPDATE changesets SET validation_json = ?, status = ?, updated_at = ? WHERE changeset_id = ?`)
      .run(JSON.stringify(result), valid ? "validated" : "draft", nowIso(), changesetId);

    return result;
  }

  async apply(changesetId: string, confirm: boolean, options?: { remoteValidate?: boolean }): Promise<ApplyResult> {
    if (!confirm) {
      throw new Error("changeset.apply requires confirm=true");
    }

    const materialized = this.materialize(changesetId);
    const changeset = this.mustGetRow(changesetId);
    if (changeset.status === "dropped") {
      throw new Error("Dropped changeset cannot be applied");
    }

    const snapshot = this.snapshotRepo.getSnapshot(changeset.snapshot_id);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${changeset.snapshot_id}`);
    }

    const policyDecision = this.policyEngine.evaluate({
      projectId: snapshot.projectId,
      changedFiles: materialized.changedFiles,
      totalLinesChanged: materialized.preview.impact.linesChanged,
      riskScore: materialized.preview.riskScore,
      snapshotFileKeys: this.snapshotRepo.listFiles(snapshot.snapshotId, undefined, 10_000).map((f) => f.fileKey)
    });

    if (policyDecision.manualOnly) {
      return {
        applied: false,
        reason: "Policy requires manual approval",
        preview: materialized.preview,
        manualPayload: this.toManualPayload(changesetId, snapshot.projectId, materialized.updates),
        instructions:
          "Apply was blocked by policy.requireManualApproval=true. Use orbit_export_changeset output with your own deployment pipeline."
      };
    }

    if (!policyDecision.allowed) {
      const readOnlyManual = policyDecision.reasons.some(
        (reason) => reason.includes("Custom code files are read-only") || reason.includes("lib/main.dart is read-only")
      );
      return {
        applied: false,
        reason: policyDecision.reasons.join("; "),
        preview: materialized.preview,
        manualPayload: readOnlyManual
          ? this.toManualPayload(changesetId, snapshot.projectId, materialized.updates)
          : undefined,
        instructions: readOnlyManual
          ? "Read-only file zones were touched. Copy YAML/code from manualPayload.updates for manual review and paste."
          : undefined
      };
    }

    for (const update of materialized.updates) {
      YAML.parse(update.yaml);
    }

    const remoteValidate = options?.remoteValidate !== false;
    if (remoteValidate) {
      const validationResults = await Promise.all(
        materialized.updates.map(async (update) => ({
          fileKey: update.fileKey,
          result: await this.adapter.remoteValidate(update.yaml, snapshot.projectId, update.fileKey)
        }))
      );
      const failed = validationResults.find((v) => !v.result.ok);
      if (failed) {
        return {
          applied: false,
          reason: `Remote validation failed for ${failed.fileKey}: ${failed.result.message ?? "Unknown error"}`,
          preview: materialized.preview
        };
      }
    }

    let pushResult;
    try {
      pushResult = await this.adapter.pushFiles(snapshot.projectId, materialized.updates);
    } catch (error) {
      if (error instanceof FlutterFlowApiError) {
        const retryAfterSecondsRaw = Number.parseInt(error.request?.retryAfter ?? "", 10);
        const retryAfterSeconds = Number.isFinite(retryAfterSecondsRaw) && retryAfterSecondsRaw > 0 ? retryAfterSecondsRaw : undefined;
        const method = error.request?.method ?? "POST";
        const url = error.request?.url ?? "unknown-endpoint";
        return {
          applied: false,
          reason:
            `FlutterFlow API request failed (${error.status}) | ${method} ${url}` +
            ` | rate_limit: retry later${retryAfterSeconds ? ` (retry-after=${retryAfterSeconds}s)` : ""}`,
          preview: materialized.preview,
          pushResult: { status: error.status, body: error.body },
          rateLimited: error.status === 429,
          retryAfterSeconds,
          statusCode: error.status
        } satisfies ApplyResult;
      }
      throw error;
    }

    if (!pushResult.ok) {
      return {
        applied: false,
        reason: pushResult.message ?? "Remote push failed",
        preview: materialized.preview,
        pushResult,
        rateLimited:
          typeof pushResult.message === "string" &&
          /\(429\)|rate[_ -]?limit|retry-after/i.test(pushResult.message),
        retryAfterSeconds:
          typeof pushResult.message === "string"
            ? (() => {
                const match = /retry-after\s*=\s*(\d+)s/i.exec(pushResult.message);
                if (!match) {
                  return undefined;
                }
                const seconds = Number.parseInt(match[1] ?? "", 10);
                return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
              })()
            : undefined
      };
    }

    this.snapshotRepo.upsertFiles(
      snapshot.snapshotId,
      materialized.updates.map((update) => ({
        fileKey: update.fileKey,
        yaml: update.yaml,
        sha256: sha256(update.yaml)
      }))
    );
    this.snapshotRepo.touchSnapshot(snapshot.snapshotId);

    this.db
      .prepare(`UPDATE changesets SET status = 'applied', updated_at = ? WHERE changeset_id = ?`)
      .run(nowIso(), changesetId);

    await this.reindexSnapshot(snapshot.snapshotId);

    return {
      applied: true,
      preview: materialized.preview,
      pushResult
    };
  }

  exportManualPayload(changesetId: string): ManualApplyPayload {
    const changeset = this.mustGetRow(changesetId);
    const snapshot = this.snapshotRepo.getSnapshot(changeset.snapshot_id);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${changeset.snapshot_id}`);
    }

    const materialized = this.materialize(changesetId);
    return this.toManualPayload(changesetId, snapshot.projectId, materialized.updates);
  }

  private toManualPayload(changesetId: string, projectId: string, updates: FileUpdate[]): ManualApplyPayload {
    return {
      snapshotId: this.mustGetRow(changesetId).snapshot_id,
      projectId,
      changesetId,
      generatedAt: nowIso(),
      updates
    };
  }

  private materialize(changesetId: string): MaterializedPreview {
    const changeset = this.mustGetRow(changesetId);
    const snapshot = this.snapshotRepo.getSnapshot(changeset.snapshot_id);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${changeset.snapshot_id}`);
    }

    const entries = this.listEntries(changesetId);
    if (entries.length === 0) {
      throw new Error("Changeset has no entries");
    }

    const byFile = new Map<string, PatchSpec[]>();
    for (const entry of entries) {
      const list = byFile.get(entry.fileKey) ?? [];
      list.push(entry.patchSpec);
      byFile.set(entry.fileKey, list);
    }

    const fileDiffs: PreviewFileDiff[] = [];
    const updates: FileUpdate[] = [];

    const fileKeys = [...byFile.keys()];
    const batchFiles = this.snapshotRepo.getFiles(changeset.snapshot_id, fileKeys);

    for (const [fileKey, patches] of byFile.entries()) {
      const file = batchFiles.get(fileKey);
      const isCreateViaReplaceRange =
        !file &&
        patches.every((patch) => patch.type === "replace-range" && patch.start === 0 && patch.end === 0);
      if (!file && !isCreateViaReplaceRange) {
        throw new Error(`Snapshot file missing: ${fileKey}`);
      }

      const baseYaml = file?.yaml ?? "";
      const baseSha = file?.sha256 ?? sha256(baseYaml);
      let nextYaml = baseYaml;
      for (const patch of patches) {
        nextYaml = applyPatchSpec(nextYaml, patch);
      }

      try {
        YAML.parse(nextYaml);
      } catch (error) {
        const message = error instanceof Error ? error.message : "YAML parse failed after patch";
        throw new Error(`Patched YAML invalid for ${fileKey}: ${message}`);
      }

      const diff = buildUnifiedDiff(fileKey, baseYaml, nextYaml);
      const linesChanged = countChangedLines(diff);
      const warnings: string[] = [];
      if (!file) {
        warnings.push("New file created");
      }

      if (linesChanged > 200) {
        warnings.push("Large diff (>200 changed lines)");
      }

      const baseline = Math.max(1, baseYaml.split("\n").length);
      if (linesChanged / baseline > 0.75) {
        warnings.push("Patch rewrites most of the file");
      }

      const newHash = sha256(nextYaml);
      fileDiffs.push({
        fileKey,
        oldSha256: baseSha,
        newSha256: newHash,
        linesChanged,
        diff,
        warnings
      });

      updates.push({ fileKey, yaml: nextYaml });
    }

    const riskScore = computeRisk(fileDiffs);
    const totalLinesChanged = fileDiffs.reduce((sum, row) => sum + row.linesChanged, 0);
    const staleMinutes = Number.parseInt(process.env.ORBIT_SNAPSHOT_STALE_MINUTES ?? "30", 10) || 30;
    const staleSnapshotWarning = isSnapshotStale(snapshot.refreshedAt, staleMinutes)
      ? `Snapshot ${snapshot.snapshotId} is older than ${staleMinutes} minutes. Refresh before applying.`
      : undefined;

    return {
      preview: {
        changesetId,
        files: fileDiffs,
        riskScore,
        impact: {
          filesTouched: fileDiffs.length,
          linesChanged: totalLinesChanged,
          highRiskFiles: fileDiffs.filter((file) => file.warnings.length > 0).map((file) => file.fileKey)
        },
        staleSnapshotWarning
      },
      updates,
      changedFiles: fileDiffs.map((file) => ({ fileKey: file.fileKey, linesChanged: file.linesChanged }))
    };
  }

  private touchChangeset(changesetId: string): void {
    this.db.prepare(`UPDATE changesets SET updated_at = ? WHERE changeset_id = ?`).run(nowIso(), changesetId);
  }

  private mustGetRow(changesetId: string): ChangesetRow {
    const row = this.db
      .prepare(
        `SELECT changeset_id, snapshot_id, title, intent, status, created_at, updated_at, preview_json, validation_json
         FROM changesets
         WHERE changeset_id = ?`
      )
      .get(changesetId) as ChangesetRow | undefined;

    if (!row) {
      throw new Error(`Changeset not found: ${changesetId}`);
    }
    return row;
  }

  private mapChangeset(row: ChangesetRow): ChangesetRecord {
    return {
      changesetId: row.changeset_id,
      snapshotId: row.snapshot_id,
      title: row.title,
      intent: row.intent,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
