import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OrbitPolicy } from "../types.js";
import { DEFAULT_POLICY } from "./defaults.js";

function policyPath(): string {
  return process.env.ORBIT_POLICY_FILE?.trim() || path.resolve(process.cwd(), "orbit.policy.json");
}

export async function readPolicyFile(): Promise<Partial<OrbitPolicy>> {
  const file = policyPath();
  try {
    const body = await readFile(file, "utf8");
    const parsed = JSON.parse(body) as Partial<OrbitPolicy>;
    return parsed;
  } catch {
    return {};
  }
}

export async function writePolicyFile(partial: OrbitPolicy): Promise<void> {
  const file = policyPath();
  const body = `${JSON.stringify(partial, null, 2)}\n`;
  await writeFile(file, body, "utf8");
}

export function defaultPolicyPath(): string {
  return policyPath();
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as Partial<T>;
}

export function mergePolicy(filePolicy: Partial<OrbitPolicy>, envPolicy: Partial<OrbitPolicy>): OrbitPolicy {
  const cleanFile = stripUndefined(filePolicy);
  const cleanEnv = stripUndefined(envPolicy);
  return {
    ...DEFAULT_POLICY,
    ...cleanFile,
    ...cleanEnv
  };
}
