import type Database from "better-sqlite3";
import { orbitId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import type { ProjectVersionInfo, SnapshotFile, SnapshotRecord } from "../types.js";

interface SnapshotRow {
  snapshot_id: string;
  project_id: string;
  name: string;
  created_at: string;
  refreshed_at: string;
}

interface SnapshotFileRow {
  snapshot_id: string;
  file_key: string;
  yaml: string;
  sha256: string;
  updated_at: string;
}

interface SnapshotVersionInfoRow {
  partitioner_version: string | null;
  project_schema_fingerprint: string | null;
}

export class SnapshotRepo {
  constructor(private readonly db: Database.Database) {}

  createSnapshot(projectId: string, name?: string): SnapshotRecord {
    const snapshotId = orbitId("snap");
    const now = nowIso();
    const snapshotName = name?.trim() || `Snapshot ${now}`;

    this.db
      .prepare(
        `INSERT INTO snapshots (snapshot_id, project_id, name, created_at, refreshed_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(snapshotId, projectId, snapshotName, now, now);

    return {
      snapshotId,
      projectId,
      name: snapshotName,
      createdAt: now,
      refreshedAt: now
    };
  }

  listSnapshots(): SnapshotRecord[] {
    const rows = this.db
      .prepare(
        `SELECT snapshot_id, project_id, name, created_at, refreshed_at
         FROM snapshots
         ORDER BY refreshed_at DESC`
      )
      .all() as SnapshotRow[];

    return rows.map(this.mapSnapshot);
  }

  getSnapshot(snapshotId: string): SnapshotRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT snapshot_id, project_id, name, created_at, refreshed_at
         FROM snapshots
         WHERE snapshot_id = ?`
      )
      .get(snapshotId) as SnapshotRow | undefined;

    return row ? this.mapSnapshot(row) : undefined;
  }

  touchSnapshot(snapshotId: string): void {
    this.db
      .prepare(
        `UPDATE snapshots
         SET refreshed_at = ?
         WHERE snapshot_id = ?`
      )
      .run(nowIso(), snapshotId);
  }

  upsertFiles(snapshotId: string, files: Array<{ fileKey: string; yaml: string; sha256: string }>): void {
    const now = nowIso();

    const insert = this.db.prepare(
      `INSERT INTO snapshot_files (snapshot_id, file_key, yaml, sha256, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (snapshot_id, file_key)
       DO UPDATE SET yaml=excluded.yaml, sha256=excluded.sha256, updated_at=excluded.updated_at`
    );

    const tx = this.db.transaction((rows: Array<{ fileKey: string; yaml: string; sha256: string }>) => {
      for (const file of rows) {
        insert.run(snapshotId, file.fileKey, file.yaml, file.sha256, now);
      }
    });

    tx(files);
  }

  deleteMissingFiles(snapshotId: string, liveFileKeys: string[]): void {
    if (liveFileKeys.length === 0) {
      this.db.prepare(`DELETE FROM snapshot_files WHERE snapshot_id = ?`).run(snapshotId);
      return;
    }

    const placeholders = liveFileKeys.map(() => "?").join(",");
    this.db
      .prepare(
        `DELETE FROM snapshot_files
         WHERE snapshot_id = ?
         AND file_key NOT IN (${placeholders})`
      )
      .run(snapshotId, ...liveFileKeys);
  }

  listFiles(snapshotId: string, prefix?: string, limit = 100): SnapshotFile[] {
    const effectiveLimit = Math.max(1, Math.min(limit, 15_000));

    let rows: SnapshotFileRow[];
    if (prefix) {
      rows = this.db
        .prepare(
          `SELECT snapshot_id, file_key, yaml, sha256, updated_at
           FROM snapshot_files
           WHERE snapshot_id = ? AND file_key LIKE ?
           ORDER BY file_key ASC
           LIMIT ?`
        )
        .all(snapshotId, `${prefix}%`, effectiveLimit) as SnapshotFileRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT snapshot_id, file_key, yaml, sha256, updated_at
           FROM snapshot_files
           WHERE snapshot_id = ?
           ORDER BY file_key ASC
           LIMIT ?`
        )
        .all(snapshotId, effectiveLimit) as SnapshotFileRow[];
    }

    return rows.map(this.mapSnapshotFile);
  }

  countFiles(snapshotId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM snapshot_files WHERE snapshot_id = ?`).get(snapshotId) as {
      count: number;
    };
    return row.count;
  }

  getFile(snapshotId: string, fileKey: string): SnapshotFile | undefined {
    const row = this.db
      .prepare(
        `SELECT snapshot_id, file_key, yaml, sha256, updated_at
         FROM snapshot_files
         WHERE snapshot_id = ? AND file_key = ?`
      )
      .get(snapshotId, fileKey) as SnapshotFileRow | undefined;

    return row ? this.mapSnapshotFile(row) : undefined;
  }

  getFiles(snapshotId: string, fileKeys: string[]): Map<string, SnapshotFile> {
    if (fileKeys.length === 0) {
      return new Map();
    }
    const placeholders = fileKeys.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT snapshot_id, file_key, yaml, sha256, updated_at
         FROM snapshot_files
         WHERE snapshot_id = ? AND file_key IN (${placeholders})`
      )
      .all(snapshotId, ...fileKeys) as SnapshotFileRow[];

    const result = new Map<string, SnapshotFile>();
    for (const row of rows) {
      result.set(row.file_key, this.mapSnapshotFile(row));
    }
    return result;
  }

  listFileHashes(snapshotId: string): Array<{ fileKey: string; sha256: string }> {
    const rows = this.db
      .prepare(
        `SELECT file_key, sha256
         FROM snapshot_files
         WHERE snapshot_id = ?`
      )
      .all(snapshotId) as Array<{ file_key: string; sha256: string }>;

    return rows.map((row) => ({ fileKey: row.file_key, sha256: row.sha256 }));
  }

  getStatusSummary(): { snapshotCount: number; recentRefreshes: Array<{ snapshotId: string; refreshedAt: string }> } {
    const snapshotCount = (this.db.prepare(`SELECT COUNT(*) AS count FROM snapshots`).get() as { count: number }).count;
    const recentRows = this.db
      .prepare(
        `SELECT snapshot_id, refreshed_at
         FROM snapshots
         ORDER BY refreshed_at DESC
         LIMIT 10`
      )
      .all() as Array<{ snapshot_id: string; refreshed_at: string }>;

    return {
      snapshotCount,
      recentRefreshes: recentRows.map((row) => ({
        snapshotId: row.snapshot_id,
        refreshedAt: row.refreshed_at
      }))
    };
  }

  setVersionInfo(snapshotId: string, versionInfo: ProjectVersionInfo): void {
    this.db
      .prepare(
        `INSERT INTO snapshot_version_info
         (snapshot_id, partitioner_version, project_schema_fingerprint, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (snapshot_id)
         DO UPDATE SET
          partitioner_version=excluded.partitioner_version,
          project_schema_fingerprint=excluded.project_schema_fingerprint,
          updated_at=excluded.updated_at`
      )
      .run(
        snapshotId,
        versionInfo.partitionerVersion ?? null,
        versionInfo.projectSchemaFingerprint ?? null,
        nowIso()
      );
  }

  getVersionInfo(snapshotId: string): ProjectVersionInfo | undefined {
    const row = this.db
      .prepare(
        `SELECT partitioner_version, project_schema_fingerprint
         FROM snapshot_version_info
         WHERE snapshot_id = ?`
      )
      .get(snapshotId) as SnapshotVersionInfoRow | undefined;

    if (!row) {
      return undefined;
    }

    const partitionerVersion = row.partitioner_version ?? undefined;
    const projectSchemaFingerprint = row.project_schema_fingerprint ?? undefined;
    if (!partitionerVersion && !projectSchemaFingerprint) {
      return undefined;
    }

    return { partitionerVersion, projectSchemaFingerprint };
  }

  private readonly mapSnapshot = (row: SnapshotRow): SnapshotRecord => ({
    snapshotId: row.snapshot_id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at,
    refreshedAt: row.refreshed_at
  });

  private readonly mapSnapshotFile = (row: SnapshotFileRow): SnapshotFile => ({
    snapshotId: row.snapshot_id,
    fileKey: row.file_key,
    yaml: row.yaml,
    sha256: row.sha256,
    updatedAt: row.updated_at
  });
}
