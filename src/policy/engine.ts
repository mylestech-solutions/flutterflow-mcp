import { minimatch } from "minimatch";
import type { OrbitPolicy } from "../types.js";
import { readPolicyFile, mergePolicy, writePolicyFile } from "./policyFile.js";
import { DEFAULT_POLICY, isPlatformFile } from "./defaults.js";

export interface PolicyEvaluationInput {
  projectId: string;
  changedFiles: Array<{ fileKey: string; linesChanged: number }>;
  totalLinesChanged: number;
  riskScore: number;
  snapshotFileKeys: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  manualOnly: boolean;
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const list = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const lowered = value.trim().toLowerCase();
  if (lowered === "1" || lowered === "true" || lowered === "yes") {
    return true;
  }
  if (lowered === "0" || lowered === "false" || lowered === "no") {
    return false;
  }
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envPolicyOverrides(): Partial<OrbitPolicy> {
  const safeMode = process.env.ORBIT_POLICY_SAFE_MODE;
  const parsedSafeMode =
    safeMode === "readOnly" || safeMode === "guidedWrite" || safeMode === "fullWrite" ? safeMode : undefined;

  return {
    allowProjects: parseList(process.env.ORBIT_POLICY_ALLOW_PROJECTS),
    allowFileKeyPrefixes: parseList(process.env.ORBIT_POLICY_ALLOW_FILE_PREFIXES),
    denyFileKeyPrefixes: parseList(process.env.ORBIT_POLICY_DENY_FILE_PREFIXES),
    maxFilesPerApply: parseNumber(process.env.ORBIT_POLICY_MAX_FILES_PER_APPLY),
    maxLinesChanged: parseNumber(process.env.ORBIT_POLICY_MAX_LINES_CHANGED),
    requireManualApproval: parseBoolean(process.env.ORBIT_POLICY_REQUIRE_MANUAL_APPROVAL),
    allowPlatformConfigEdits: parseBoolean(process.env.ORBIT_POLICY_ALLOW_PLATFORM_CONFIG_EDITS),
    safeMode: parsedSafeMode
  };
}

export class PolicyEngine {
  private activePolicy: OrbitPolicy = DEFAULT_POLICY;

  async reload(): Promise<OrbitPolicy> {
    const filePolicy = await readPolicyFile();
    this.activePolicy = mergePolicy(filePolicy, envPolicyOverrides());
    return this.activePolicy;
  }

  getPolicy(): OrbitPolicy {
    return this.activePolicy;
  }

  async setPolicy(nextPolicy: OrbitPolicy): Promise<OrbitPolicy> {
    await writePolicyFile(nextPolicy);
    this.activePolicy = nextPolicy;
    return this.activePolicy;
  }

  evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const reasons: string[] = [];
    const policy = this.activePolicy;

    if (!policy.allowProjects.some((pattern) => minimatch(input.projectId, pattern))) {
      reasons.push(`Project '${input.projectId}' is not allowed by allowProjects`);
    }

    if (policy.safeMode === "readOnly") {
      reasons.push("Policy safeMode=readOnly blocks apply");
    }

    if (input.changedFiles.length === 0) {
      reasons.push("No file changes to apply");
    }

    if (input.changedFiles.length > policy.maxFilesPerApply) {
      reasons.push(`Changes exceed maxFilesPerApply (${policy.maxFilesPerApply})`);
    }

    if (input.totalLinesChanged > policy.maxLinesChanged) {
      reasons.push(`Changes exceed maxLinesChanged (${policy.maxLinesChanged})`);
    }

    for (const file of input.changedFiles) {
      const denied = policy.denyFileKeyPrefixes.find((prefix) => file.fileKey.startsWith(prefix));
      if (denied) {
        reasons.push(`Write denied for '${file.fileKey}' by deny prefix '${denied}'`);
      }
    }

    if (policy.allowFileKeyPrefixes.length > 0) {
      for (const file of input.changedFiles) {
        const matched = policy.allowFileKeyPrefixes.some((prefix) => file.fileKey.startsWith(prefix));
        if (!matched) {
          reasons.push(`'${file.fileKey}' not covered by allowFileKeyPrefixes`);
        }
      }
    }

    if (policy.safeMode === "guidedWrite" && input.riskScore > 80) {
      reasons.push("Risk score too high for guidedWrite mode");
    }

    const platformTouched = input.changedFiles.filter((file) => isPlatformFile(file.fileKey));
    if (platformTouched.length > 0) {
      if (!policy.allowPlatformConfigEdits) {
        reasons.push("Platform config edits blocked by policy");
      } else {
        const snapshotPlatformFiles = input.snapshotFileKeys.filter((fileKey) => isPlatformFile(fileKey));
        const touched = new Set(platformTouched.map((entry) => entry.fileKey));
        const missing = snapshotPlatformFiles.filter((key) => !touched.has(key));
        if (missing.length > 0) {
          reasons.push(
            `Platform config edits must be bundled. Missing ${missing.length} platform files in this apply batch.`
          );
        }
      }
    }

    // Beast mode: custom code and main.dart editing unlocked.
    // Original hard blocks removed to allow full FlutterFlow control.

    return {
      allowed: reasons.length === 0 && !policy.requireManualApproval,
      reasons,
      manualOnly: policy.requireManualApproval
    };
  }
}
