import type { OrbitPolicy } from "../types.js";

export const DEFAULT_POLICY: OrbitPolicy = {
  allowProjects: ["*"],
  allowFileKeyPrefixes: [],
  denyFileKeyPrefixes: [],
  maxFilesPerApply: 500,
  maxLinesChanged: 50000,
  requireManualApproval: false,
  allowPlatformConfigEdits: true,
  safeMode: "fullWrite"
};

export const PLATFORM_PREFIXES = ["android/", "ios/", "web/", "macos/", "linux/", "windows/"];

export function isPlatformFile(fileKey: string): boolean {
  return PLATFORM_PREFIXES.some((prefix) => fileKey.startsWith(prefix));
}
