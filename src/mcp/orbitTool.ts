import YAML from "yaml";
import { z } from "zod/v4";
import type { FlutterFlowAdapter } from "../ff/adapter.js";
import { FlutterFlowApiError } from "../ff/errors.js";
import { SnapshotRepo } from "../store/snapshotRepo.js";
import { IndexRepo } from "../store/indexRepo.js";
import { ChangesetService } from "../edits/changesets.js";
import { PolicyEngine } from "../policy/engine.js";
import type { ChangesetEntry, OrbitCommandInput, OrbitCommandResult, PatchSpec } from "../types.js";
import { mapLimit } from "../util/async.js";
import { sha256 } from "../util/hash.js";
import { orbitId } from "../util/ids.js";
import { compileSafeRegex } from "../util/regex.js";
import { isSnapshotStale } from "../util/time.js";
import { readSchemaDoc, readSchemaSnippet, searchSchema, listSchemaIndex } from "../schema/catalog.js";
import { extractSnapshotIndex } from "../indexer/extract.js";
import { walkGraph } from "../indexer/graphs.js";
import { selectorToPath, getAtPath, setAtPath } from "../util/paths.js";
import type {
  ActionBindMode,
  ApplySafeResult,
  ClipboardEntry,
  IntentRunResult,
  PageRecipeId,
  ProjectVersionInfo,
  RollbackResult,
  RouteUpsertArgs,
  SnapshotEnsureFreshResult,
  WidgetActionSummary,
  WidgetFilterSpec,
  WidgetMoveManyResult,
  WidgetManyResult,
  WidgetUpdateSpec
} from "../types.js";
import { parseIntentText } from "./intentService.js";
import {
  buildActionYaml,
  buildTriggerYaml,
  ensureActionNodeId,
  parseTriggerAndActionFromYaml,
  normalizeTriggerType,
  triggerNodeId
} from "./bindingService.js";
import { buildNavigateAction, makeRouteIssue } from "./routeService.js";
import {
  computeSnapshotStaleness,
  hasFingerprintDrift,
  isSnapshotLikelyIncomplete,
  parseStaleMinutes
} from "./snapshotService.js";
import { buildInverseReplacements } from "../edits/rollbackService.js";
import { compilePageScaffold, pageRecipeIds } from "./scaffoldService.js";
import {
  attachChildAt,
  cloneTreeNode,
  collectWidgetTreeKeys as svcCollectWidgetTreeKeys,
  findNodePathByKey as svcFindNodePathByKey,
  findParentChildrenSlotByKey as svcFindParentChildrenSlotByKey,
  keyFromNodeId as svcKeyFromNodeId,
  loadSplitTreeContext,
  nodeIdFromKey as svcNodeIdFromKey,
  removeNodeFromTreeByKey,
  replaceKeyRefsDeep,
  validateSplitTreeContext
} from "./treeService.js";

const INPUT_SCHEMA = z.object({
  cmd: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  snapshot: z.string().optional(),
  format: z.enum(["json", "explain"]).optional()
});

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strArg(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (required) {
    throw new Error(`Missing string arg: ${key}`);
  }
  return "";
}

function numArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

function boolArg(args: Record<string, unknown>, key: string, defaultValue = false): boolean {
  const value = args[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return defaultValue;
}

type FetchStrategy = "auto" | "bulk" | "file";

function parseFetchStrategy(args: Record<string, unknown>): FetchStrategy {
  const raw = strArg(args, "fetchStrategy", false).toLowerCase();
  if (raw === "bulk" || raw === "file") {
    return raw;
  }
  return "auto";
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function waitMs(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(text: string, max = 1400): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

function summarizeApiBody(body?: string): string | undefined {
  if (!body || !body.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "string") {
      return parsed;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      const candidates = [
        row.message,
        row.reason,
        row.error,
        row.detail,
        (row.body as Record<string, unknown> | undefined)?.message,
        (row.body as Record<string, unknown> | undefined)?.reason,
        (row.body as Record<string, unknown> | undefined)?.error
      ];
      for (const value of candidates) {
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
      return clip(JSON.stringify(row), 300);
    }
  } catch {
    // fall through to plain text
  }
  return clip(body.trim(), 300);
}

function formatFlutterFlowApiErrorMessage(error: FlutterFlowApiError): string {
  const method = error.request?.method || "GET";
  const url = error.request?.url || "unknown-endpoint";
  const detail = summarizeApiBody(error.body);
  const parts = [`FlutterFlow API request failed (${error.status})`, `${method} ${url}`];
  if (detail) {
    parts.push(`details: ${detail}`);
  }
  if (error.status === 429) {
    parts.push(
      `rate_limit: retry later${error.request?.retryAfter ? ` (retry-after=${error.request.retryAfter}s)` : ""}`
    );
  } else if (error.status === 400) {
    parts.push("hint: request payload may be invalid or operation is blocked by FlutterFlow constraints");
  }
  return parts.join(" | ");
}

function isRateLimitedReason(reason: string): boolean {
  return /\(429\)|rate[_ -]?limit|retry-after/i.test(reason);
}

function isRemoteSchemaRejectedReason(reason: string): boolean {
  return (
    /\(400\)/i.test(reason) ||
    /unknown field/i.test(reason) ||
    /schema/i.test(reason) ||
    /validation failed/i.test(reason)
  );
}

function pageRemoveErrorCodeFromReason(reason: string, blocked = false): string {
  if (blocked) {
    return "PRECHECK_BLOCKED";
  }
  if (!reason.trim()) {
    return "DELETE_FAILED";
  }
  if (isRateLimitedReason(reason)) {
    return "RATE_LIMITED";
  }
  if (/snapshot .* 0 files|snapshot_empty/i.test(reason)) {
    return "SNAPSHOT_EMPTY";
  }
  if (isRemoteSchemaRejectedReason(reason)) {
    return "REMOTE_SCHEMA_REJECTED";
  }
  return "DELETE_FAILED";
}

function archivePageName(name: string, prefix: string): string {
  const normalizedPrefix = prefix.trim().length > 0 ? prefix : "deprecated_";
  return name.startsWith(normalizedPrefix) ? name : `${normalizedPrefix}${name}`;
}

function isLikelyGlobPattern(value: string): boolean {
  return /[*?\[\]{}()]/.test(value);
}

function selectorFromPath(path: Array<string | number>): string {
  if (path.length === 0) {
    return "$";
  }
  let out = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      out += `.${segment}`;
    } else {
      out += `['${segment.replace(/'/g, "\\'")}']`;
    }
  }
  return out;
}

function joinSelector(base: string, suffix: string): string {
  const normalizedSuffix = suffix.trim();
  if (!normalizedSuffix) {
    return base;
  }
  if (normalizedSuffix.startsWith("$")) {
    return normalizedSuffix;
  }
  if (normalizedSuffix.startsWith(".") || normalizedSuffix.startsWith("[")) {
    return `${base}${normalizedSuffix}`;
  }
  return `${base}.${normalizedSuffix}`;
}

function keyFromNodeId(nodeId: string): string {
  return nodeId.replace(/^id-/, "");
}

function nodeIdFromKey(key: string): string {
  return key.startsWith("id-") ? key : `id-${key}`;
}

function findNodePathById(node: unknown, nodeId: string, path: Array<string | number> = []): Array<string | number> | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = findNodePathById(node[i], nodeId, [...path, i]);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof node !== "object") {
    return undefined;
  }

  const record = node as Record<string, unknown>;
  if (typeof record.id === "string" && record.id === nodeId) {
    return path;
  }

  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === "object") {
      const found = findNodePathById(value, nodeId, [...path, key]);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function removeNodeFromWidgetTree(node: unknown, targetKey: string): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }

  let removed = false;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      const originalLength = value.length;
      const next = value.filter((entry) => {
        if (entry && typeof entry === "object") {
          const entryKey = (entry as Record<string, unknown>).key;
          return entryKey !== targetKey;
        }
        return true;
      });
      if (next.length !== originalLength) {
        removed = true;
      }
      record[key] = next;
      for (const entry of next) {
        if (removeNodeFromWidgetTree(entry, targetKey)) {
          removed = true;
        }
      }
    } else if (value && typeof value === "object") {
      if (removeNodeFromWidgetTree(value, targetKey)) {
        removed = true;
      }
    }
  }
  return removed;
}

function pathEndsWith(path: Array<string | number>, suffix: Array<string | number>): boolean {
  if (suffix.length === 0 || suffix.length > path.length) {
    return false;
  }
  for (let i = 0; i < suffix.length; i += 1) {
    if (path[path.length - suffix.length + i] !== suffix[i]) {
      return false;
    }
  }
  return true;
}

function collectSuffixMatches(
  root: unknown,
  node: unknown,
  suffix: Array<string | number>,
  path: Array<string | number> = [],
  out: Array<Array<string | number>> = []
): Array<Array<string | number>> {
  if (pathEndsWith(path, suffix) && getAtPath(root, path) !== undefined) {
    out.push(path);
  }

  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectSuffixMatches(root, entry, suffix, [...path, index], out));
    return out;
  }

  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (value !== null && value !== undefined && typeof value === "object") {
        collectSuffixMatches(root, value, suffix, [...path, key], out);
      } else {
        const leafPath = [...path, key];
        if (pathEndsWith(leafPath, suffix) && getAtPath(root, leafPath) !== undefined) {
          out.push(leafPath);
        }
      }
    }
  }

  return out;
}

function resolveWidgetSelector(targetYaml: string, key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("Missing string arg: key");
  }
  if (normalized.startsWith("$")) {
    return normalized;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(targetYaml);
  } catch {
    return joinSelector("$", normalized);
  }

  const directPath = selectorToPath(normalized);
  if (getAtPath(parsed, directPath) !== undefined) {
    return joinSelector("$", normalized);
  }

  const prefixedCandidates = [
    `props.${normalized}`,
    `props.text.${normalized}`,
    `props.button.${normalized}`,
    `props.textField.${normalized}`,
    `props.container.${normalized}`
  ];
  for (const candidate of prefixedCandidates) {
    if (getAtPath(parsed, selectorToPath(candidate)) !== undefined) {
      return joinSelector("$", candidate);
    }
  }

  const suffixMatches = collectSuffixMatches(parsed, parsed, directPath);
  if (suffixMatches.length === 1) {
    const only = suffixMatches[0];
    if (only) {
      return selectorFromPath(only);
    }
  }
  if (suffixMatches.length > 1) {
    const propsPreferred = suffixMatches
      .filter((path) => path.some((segment) => segment === "props"))
      .sort((a, b) => a.length - b.length);
    if (propsPreferred.length > 0) {
      const preferred = propsPreferred[0];
      if (preferred) {
        return selectorFromPath(preferred);
      }
    }

    const sorted = suffixMatches.sort((a, b) => a.length - b.length);
    const first = sorted[0];
    if (first) {
      return selectorFromPath(first);
    }
  }

  return joinSelector("$", normalized);
}

function deleteAtPath(root: unknown, path: Array<string | number>): boolean {
  if (path.length === 0) {
    return false;
  }

  const parentPath = path.slice(0, -1);
  const leaf = path[path.length - 1]!;
  const parent = getAtPath(root, parentPath);
  if (Array.isArray(parent) && typeof leaf === "number") {
    if (leaf < 0 || leaf >= parent.length) {
      return false;
    }
    parent.splice(leaf, 1);
    return true;
  }
  if (parent !== null && typeof parent === "object" && typeof leaf === "string") {
    if (!(leaf in (parent as Record<string, unknown>))) {
      return false;
    }
    delete (parent as Record<string, unknown>)[leaf];
    return true;
  }
  return false;
}

function pageIdFromFileKey(fileKey: string): string | undefined {
  const normalized = fileKey.replace(/\.ya?ml$/i, "");
  const match = normalized.match(/^page\/(id-[^/]+)$/i);
  return match?.[1];
}

function pageIdFromAnyPageFileKey(fileKey: string): string | undefined {
  const normalized = fileKey.replace(/\.ya?ml$/i, "");
  const match = normalized.match(/^page\/(id-[^/]+)/i);
  return match?.[1];
}

function pageIdFromSplitNodeFileKey(fileKey: string): string | undefined {
  const normalized = fileKey.replace(/\.ya?ml$/i, "");
  const match = normalized.match(/^page\/(id-[^/]+)\/page-widget-tree-outline\/node\/id-[^/]+$/i);
  return match?.[1];
}

function inferPageIdForNodeId(snapshotRepo: SnapshotRepo, snapshotId: string, nodeId: string): string | undefined {
  const normalizedNodeId = nodeId.replace(/\.ya?ml$/i, "");
  const files = snapshotRepo.listFiles(snapshotId, "page/", 10_000);
  for (const file of files) {
    const normalized = file.fileKey.replace(/\.ya?ml$/i, "");
    if (!normalized.endsWith(`/page-widget-tree-outline/node/${normalizedNodeId}`)) {
      continue;
    }
    const pageId = pageIdFromSplitNodeFileKey(file.fileKey);
    if (pageId) {
      return pageId;
    }
  }
  return undefined;
}

interface PageListRow {
  pageId: string;
  name: string;
  fileKey?: string;
  symbolId?: string;
}

type PageListSource = "index" | "file-key-fallback" | "index+file-key-fallback";

function synthesizePageSymbolId(pageId: string): string {
  return `page:${pageId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function collectPagesForSnapshot(
  snapshotRepo: SnapshotRepo,
  indexRepo: IndexRepo,
  snapshotId: string,
  includeFileKeys: boolean,
  includeDeleted: boolean
): { pages: PageListRow[]; source: PageListSource; indexedCount: number } {
  const pageFiles = snapshotRepo.listFiles(snapshotId, "page/", 10_000);
  const rootFileById = new Map<string, { fileKey: string; yaml: string }>();
  const anyPageFileById = new Map<string, { fileKey: string; yaml: string }>();
  const pageYamlById = new Map<string, string>();

  for (const file of pageFiles) {
    const pageId = pageIdFromAnyPageFileKey(file.fileKey);
    if (!pageId) {
      continue;
    }

    if (!anyPageFileById.has(pageId)) {
      anyPageFileById.set(pageId, { fileKey: file.fileKey, yaml: file.yaml });
    }

    const isRoot = /^page\/id-[^/]+$/i.test(file.fileKey.replace(/\.ya?ml$/i, ""));
    if (isRoot) {
      const existing = rootFileById.get(pageId);
      const isCanonical = file.fileKey === `page/${pageId}` || file.fileKey === `page/${pageId}.yaml`;
      if (!existing || isCanonical) {
        rootFileById.set(pageId, { fileKey: file.fileKey, yaml: file.yaml });
        pageYamlById.set(pageId, file.yaml);
      }
    }
  }

  const indexed = indexRepo.listSymbols(snapshotId, "page");
  let source: PageListSource = "index";
  const dedup = new Map<string, PageListRow>();

  for (const symbol of indexed) {
    const pageId = pageIdFromAnyPageFileKey(symbol.fileKey) || symbol.name;
    if (!includeDeleted && isPageDeletedFromYaml(pageYamlById.get(pageId) ?? "")) {
      continue;
    }
    const key = pageId.toLowerCase();
    if (!dedup.has(key)) {
      dedup.set(key, {
        pageId,
        name: pickPageDisplayNameFromYaml(pageYamlById.get(pageId) ?? "") || symbol.name,
        fileKey: includeFileKeys
          ? rootFileById.get(pageId)?.fileKey ?? symbol.fileKey
          : undefined,
        symbolId: symbol.symbolId
      });
    }
  }

  for (const [pageId, anyFile] of anyPageFileById.entries()) {
    if (!includeDeleted && isPageDeletedFromYaml(pageYamlById.get(pageId) ?? "")) {
      continue;
    }
    const key = pageId.toLowerCase();
    if (!dedup.has(key)) {
      dedup.set(key, {
        pageId,
        name: pickPageDisplayNameFromYaml(pageYamlById.get(pageId) ?? "") || pageId,
        fileKey: includeFileKeys
          ? rootFileById.get(pageId)?.fileKey ?? anyFile.fileKey
          : undefined,
        symbolId: synthesizePageSymbolId(pageId)
      });
    }
  }

  if (indexed.length === 0) {
    source = "file-key-fallback";
  } else if (dedup.size > indexed.length) {
    source = "index+file-key-fallback";
  }

  return {
    pages: [...dedup.values()],
    source,
    indexedCount: indexed.length
  };
}

function isPageDeletedFromYaml(yamlText: string): boolean {
  if (!yamlText.trim()) {
    return false;
  }
  try {
    const parsed = YAML.parse(yamlText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const root = parsed as Record<string, unknown>;
    const name = typeof root.name === "string" ? root.name : "";
    return (
      root.deleted === true ||
      root.isDeleted === true ||
      String(root.status ?? "").toLowerCase() === "deleted" ||
      name.startsWith("[deleted] ")
    );
  } catch {
    return false;
  }
}

function generatePageId(): string {
  return `id-Scaffold_${orbitId("pg").slice(-8)}`;
}

function normalizeNodeId(value: string): string {
  return value.startsWith("id-") ? value : `id-${value}`;
}

function defaultNodeIdForType(type: string): string {
  const normalizedType = type.replace(/[^A-Za-z0-9]+/g, "") || "Widget";
  return `id-${normalizedType}_${orbitId("n").slice(-8)}`;
}

function buildPageRootYaml(pageId: string, name: string): string {
  const key = keyFromNodeId(pageId);
  return YAML.stringify({
    name,
    description: "",
    node: {
      key,
      classModel: {}
    }
  }, { lineWidth: 0 });
}

function buildPageTreeYaml(pageId: string): string {
  return YAML.stringify({
    node: {
      key: keyFromNodeId(pageId)
    }
  }, { lineWidth: 0 });
}

function buildWidgetNodeYaml(nodeId: string, type: string, name: string | undefined, props: Record<string, unknown>): string {
  return YAML.stringify({
    key: keyFromNodeId(nodeId),
    type,
    ...(name ? { name } : {}),
    props,
    parameterValues: {}
  }, { lineWidth: 0 });
}

function findNodePathByKey(node: unknown, targetKey: string, path: Array<string | number> = []): Array<string | number> | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = findNodePathByKey(node[i], targetKey, [...path, i]);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof node !== "object") {
    return undefined;
  }

  const row = node as Record<string, unknown>;
  if (typeof row.key === "string" && row.key === targetKey) {
    return path;
  }
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === "object") {
      const found = findNodePathByKey(value, targetKey, [...path, key]);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function collectWidgetTreeKeys(node: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (node === null || node === undefined) {
    return out;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectWidgetTreeKeys(entry, out);
    }
    return out;
  }
  if (typeof node !== "object") {
    return out;
  }
  const row = node as Record<string, unknown>;
  if (typeof row.key === "string" && row.key.trim()) {
    out.add(row.key.trim());
  }
  for (const value of Object.values(row)) {
    if (value !== null && typeof value === "object") {
      collectWidgetTreeKeys(value, out);
    }
  }
  return out;
}

function findParentChildrenSlotByKey(
  node: unknown,
  targetKey: string,
  path: Array<string | number> = []
): { childrenPath: Array<string | number>; index: number } | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = findParentChildrenSlotByKey(node[i], targetKey, [...path, i]);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof node !== "object") {
    return undefined;
  }
  const row = node as Record<string, unknown>;
  const children = row.children;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child && typeof child === "object") {
        const childRow = child as Record<string, unknown>;
        if (typeof childRow.key === "string" && childRow.key === targetKey) {
          return { childrenPath: [...path, "children"], index: i };
        }
      }
    }
  }
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === "object") {
      const found = findParentChildrenSlotByKey(value, targetKey, [...path, key]);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function stringListArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function readStringAtPaths(node: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getAtPath(node, selectorToPath(path));
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readBooleanAtPaths(node: unknown, paths: string[]): boolean | undefined {
  for (const path of paths) {
    const value = getAtPath(node, selectorToPath(path));
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function extractWidgetDisplay(
  node: Record<string, unknown>,
  type: string | undefined,
  include: string[]
): Record<string, unknown> {
  if (include.length === 0) {
    return {};
  }
  const wants = new Set(include.map((field) => field.toLowerCase()));
  const display: Record<string, unknown> = {};
  const normalizedType = (type ?? "").toLowerCase();

  if (wants.has("name") && typeof node.name === "string" && node.name.trim().length > 0) {
    display.name = node.name.trim();
  }

  if (normalizedType === "textfield") {
    if (wants.has("label")) {
      const label = readStringAtPaths(node, [
        "props.label.textValue.inputValue",
        "props.label.inputValue",
        "props.label",
        "props.textField.label.textValue.inputValue",
        "props.textField.label"
      ]);
      if (label !== undefined) {
        display.label = label;
      }
    }
    if (wants.has("passwordfield")) {
      const passwordField = readBooleanAtPaths(node, [
        "props.passwordField",
        "props.textField.passwordField",
        "passwordField"
      ]);
      if (passwordField !== undefined) {
        display.passwordField = passwordField;
      }
    }
    if (wants.has("hinttext")) {
      const hintText = readStringAtPaths(node, [
        "props.hintText.textValue.inputValue",
        "props.hintText.inputValue",
        "props.hintText",
        "props.textField.hintText.textValue.inputValue"
      ]);
      if (hintText !== undefined) {
        display.hintText = hintText;
      }
    }
    if (wants.has("initialvalue")) {
      const initialValue = readStringAtPaths(node, [
        "props.initialValue.textValue.inputValue",
        "props.initialValue.inputValue",
        "props.initialValue",
        "props.text.textValue.inputValue",
        "props.textValue.inputValue"
      ]);
      if (initialValue !== undefined) {
        display.initialValue = initialValue;
      }
    }
  } else if (normalizedType === "text") {
    if (wants.has("text")) {
      const text = readStringAtPaths(node, [
        "props.text.textValue.inputValue",
        "props.textValue.inputValue",
        "props.text",
        "text"
      ]);
      if (text !== undefined) {
        display.text = text;
      }
    }
  } else if (normalizedType === "button") {
    if (wants.has("text")) {
      const text = readStringAtPaths(node, [
        "props.button.text.textValue.inputValue",
        "props.text.textValue.inputValue",
        "props.textValue.inputValue",
        "text"
      ]);
      if (text !== undefined) {
        display.text = text;
      }
    }
  }

  return display;
}

function textCandidatesForWidget(
  node: Record<string, unknown>,
  type: string | undefined
): Array<{ path: string; value: string }> {
  const normalizedType = (type ?? "").toLowerCase();
  const paths = [
    "props.text.textValue.inputValue",
    "props.textValue.inputValue",
    "props.button.text.textValue.inputValue",
    "props.label.textValue.inputValue",
    "props.hintText.textValue.inputValue",
    "props.initialValue.textValue.inputValue",
    "props.textField.label.textValue.inputValue",
    "props.textField.hintText.textValue.inputValue",
    "props.textField.initialValue.textValue.inputValue"
  ];

  const targetedPaths =
    normalizedType === "text"
      ? ["props.text.textValue.inputValue", "props.textValue.inputValue"]
      : normalizedType === "button"
      ? ["props.button.text.textValue.inputValue", "props.text.textValue.inputValue"]
      : normalizedType === "textfield"
      ? [
          "props.label.textValue.inputValue",
          "props.hintText.textValue.inputValue",
          "props.initialValue.textValue.inputValue",
          "props.textField.label.textValue.inputValue",
          "props.textField.hintText.textValue.inputValue",
          "props.textField.initialValue.textValue.inputValue"
        ]
      : paths;

  const out: Array<{ path: string; value: string }> = [];
  for (const path of targetedPaths) {
    const value = getAtPath(node, selectorToPath(path));
    if (typeof value === "string" && value.trim().length > 0) {
      out.push({ path, value: value.trim() });
    }
  }
  return out;
}

function normalizeTextMatch(value: string): string {
  return value.trim().toLowerCase();
}

function matchesWidgetFilter(
  node: Record<string, unknown>,
  nodeId: string | undefined,
  type: string | undefined,
  filter: WidgetFilterSpec
): boolean {
  if (filter.nodeIds && filter.nodeIds.length > 0 && nodeId && !filter.nodeIds.includes(nodeId)) {
    return false;
  }
  if (filter.type && (!type || normalizeTextMatch(type) !== normalizeTextMatch(filter.type))) {
    return false;
  }
  if (filter.nameContains) {
    const name = typeof node.name === "string" ? node.name : "";
    if (!normalizeTextMatch(name).includes(normalizeTextMatch(filter.nameContains))) {
      return false;
    }
  }
  if (filter.textContains) {
    const found = textCandidatesForWidget(node, type).some((candidate) =>
      normalizeTextMatch(candidate.value).includes(normalizeTextMatch(filter.textContains!))
    );
    if (!found) {
      return false;
    }
  }
  return true;
}

function parseWidgetFilterSpec(value: unknown): WidgetFilterSpec {
  const row = asObject(value);
  const nodeIdsRaw = row.nodeIds;
  const nodeIds = Array.isArray(nodeIdsRaw)
    ? nodeIdsRaw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : undefined;
  const filter: WidgetFilterSpec = {};
  if (typeof row.type === "string" && row.type.trim()) {
    filter.type = row.type.trim();
  }
  if (typeof row.nameContains === "string" && row.nameContains.trim()) {
    filter.nameContains = row.nameContains.trim();
  }
  if (typeof row.textContains === "string" && row.textContains.trim()) {
    filter.textContains = row.textContains.trim();
  }
  if (nodeIds && nodeIds.length > 0) {
    filter.nodeIds = nodeIds;
  }
  return filter;
}

function parseWidgetUpdateSpec(value: unknown): WidgetUpdateSpec {
  const row = asObject(value);
  const out: WidgetUpdateSpec = {};
  if (typeof row.text === "string" && row.text.trim().length > 0) {
    out.text = row.text;
  }
  const keyValuePairs = asObject(row.keyValuePairs);
  if (Object.keys(keyValuePairs).length > 0) {
    out.keyValuePairs = keyValuePairs;
  }
  const patch = asObject(row.patch);
  if (Object.keys(patch).length > 0) {
    out.patch = patch;
  }
  return out;
}

function isLikelyPageId(value: string): boolean {
  return /^id-[a-z0-9_]+$/i.test(value.trim());
}

function pickPageDisplayNameFromYaml(yamlText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch {
    return undefined;
  }

  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    return undefined;
  }

  const root = parsed as Record<string, unknown>;
  const prioritizedKeys = ["pageName", "page_name", "title", "screenName", "screen_name", "name", "routeName", "route_name"];
  for (const key of prioritizedKeys) {
    const value = root[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed && !isLikelyPageId(trimmed)) {
        return trimmed;
      }
    }
  }

  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const { node, depth } = current;
    if (depth > 3 || node === null || node === undefined) {
      continue;
    }

    if (Array.isArray(node)) {
      for (const child of node) {
        queue.push({ node: child, depth: depth + 1 });
      }
      continue;
    }

    if (typeof node !== "object") {
      continue;
    }

    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string") {
        const lowered = key.toLowerCase();
        if (/(page.?name|title|screen.?name|route.?name|label|name)/.test(lowered)) {
          const trimmed = value.trim();
          if (trimmed && trimmed.length <= 120 && !isLikelyPageId(trimmed)) {
            return trimmed;
          }
        }
      } else if (typeof value === "object" && value !== null) {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }

  return undefined;
}

function summarizeNode(node: unknown): { widgets: number; actions: number; components: number } {
  const summary = { widgets: 0, actions: 0, components: 0 };

  const walk = (entry: unknown): void => {
    if (entry === null || entry === undefined) {
      return;
    }

    if (Array.isArray(entry)) {
      entry.forEach(walk);
      return;
    }

    if (typeof entry !== "object") {
      return;
    }

    const row = entry as Record<string, unknown>;
    const type = String(row.type ?? row.actionType ?? row.widgetType ?? "").toLowerCase();

    if (type.includes("widget") || "children" in row || "child" in row) {
      summary.widgets += 1;
    }
    if (type.includes("action") || "actionType" in row || "onTapAction" in row) {
      summary.actions += 1;
    }
    if (type.includes("component") || "componentRef" in row || "componentName" in row) {
      summary.components += 1;
    }

    for (const value of Object.values(row)) {
      walk(value);
    }
  };

  walk(node);
  return summary;
}

function normalizePatchSpec(raw: unknown): PatchSpec {
  const row = asObject(raw);
  const type = row.type;
  if (type === "yaml-merge") {
    if (typeof row.selector !== "string") {
      throw new Error("patchSpec.selector must be string for yaml-merge");
    }
    return {
      type,
      selector: row.selector,
      value: row.value ?? null
    };
  }

  if (type === "jsonpath") {
    if (typeof row.selector !== "string") {
      throw new Error("patchSpec.selector must be string for jsonpath");
    }
    return {
      type,
      selector: row.selector,
      value: row.value ?? null
    };
  }

  if (type === "replace-range") {
    if (typeof row.start !== "number" || typeof row.end !== "number" || typeof row.replacement !== "string") {
      throw new Error("replace-range requires numeric start/end and string replacement");
    }
    return {
      type,
      start: row.start,
      end: row.end,
      replacement: row.replacement
    };
  }

  throw new Error("Unsupported patchSpec.type");
}

const HELP_COMMANDS = [
  "help",
  "api.capabilities",
  "projects.list",
  "snapshots.create",
  "snapshots.refresh",
  "snapshots.refreshSlow",
  "snapshots.ensureFresh",
  "snapshots.info",
  "snapshots.ls",
  "search",
  "page.create",
  "page.scaffold",
  "page.get",
  "page.update",
  "page.preflightDelete",
  "page.remove",
  "page.delete",
  "component.get",
  "tree.locate",
  "tree.subtree",
  "tree.find",
  "tree.validate",
  "tree.repair",
  "graph.nav",
  "graph.usage",
  "pages.list",
  "page.clone",
  "textfields.list",
  "widget.get",
  "widgets.list",
  "widgets.find",
  "widgets.findText",
  "widget.getMany",
  "widgets.updateMany",
  "widgets.copyPaste",
  "widget.create",
  "widget.insert",
  "widget.wrap",
  "widget.duplicate",
  "widget.deleteSubtree",
  "widget.replaceType",
  "widget.removeChildren",
  "widget.move",
  "widget.moveMany",
  "widget.reorder",
  "widget.unwrap",
  "widget.action.list",
  "widget.action.get",
  "widget.bindAction",
  "widget.bindData",
  "widget.set",
  "widget.delete",
  "selection.get",
  "selection.clear",
  "component.extractFromWidget",
  "component.instance.insert",
  "intent.run",
  "routes.list",
  "routes.listByPage",
  "routes.validate",
  "routes.upsert",
  "routes.delete",
  "settings.get",
  "summarize.page",
  "summarize.component",
  "summarize.project",
  "changeset.new",
  "changeset.add",
  "changeset.preview",
  "changeset.validate",
  "changeset.apply",
  "changeset.applySafe",
  "changeset.rollback",
  "changeset.revert",
  "changeset.drop",
  "schema.search",
  "schema.read",
  "schema.snippet"
];

export const orbitInputSchema = INPUT_SCHEMA;

interface RememberedSelection {
  snapshotId?: string;
  pageId: string;
  nodeId: string;
  fileKey: string;
  updatedAt: string;
}

interface FullRefreshChunkSession {
  sessionId: string;
  snapshotId: string;
  projectId: string;
  remoteKeys: string[];
  queue: string[];
  fetchedCanonicalKeys: Set<string>;
  versionInfo?: ProjectVersionInfo;
  createdAt: string;
  listedAt: string;
  updatedAt: string;
}

type RefreshSnapshotResult = {
  mode: "incremental" | "full";
  fetchedCount: number;
  attemptedFetchCount: number;
  totalRemoteFiles: number;
  strategyUsed: "bulk" | "file";
  failedFetchCount: number;
  partial: boolean;
  pruneApplied: boolean;
  authoritative: boolean;
  versionInfo: unknown;
  notes: string[];
  warnings: string[];
  chunkSession?: {
    sessionId: string;
    remainingFetchCount: number;
    totalRemoteFiles: number;
    listedAt: string;
    createdAt: string;
    updatedAt: string;
    completed: boolean;
    reused: boolean;
  };
};

export class OrbitCommandPalette {
  private readonly clipboards = new Map<string, ClipboardEntry>();
  private readonly selectionBySnapshot = new Map<string, RememberedSelection>();
  private readonly fullRefreshChunkSessions = new Map<string, FullRefreshChunkSession>();
  private lastSelection?: RememberedSelection;

  constructor(
    private readonly adapter: FlutterFlowAdapter,
    private readonly snapshotRepo: SnapshotRepo,
    private readonly indexRepo: IndexRepo,
    private readonly changesets: ChangesetService,
    private readonly policyEngine: PolicyEngine
  ) {}

  async run(input: OrbitCommandInput): Promise<OrbitCommandResult> {
    const parsed = INPUT_SCHEMA.parse(input);
    const args = asObject(parsed.args);

    try {
      switch (parsed.cmd) {
        case "help":
          {
            const target = strArg(args, "cmd", false) || strArg(args, "command", false);
            if (target) {
              const docs: Record<string, Record<string, unknown>> = {
                "widgets.list": {
                  summary: "List widgets for a page.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    q: "optional search text",
                    type: "optional widget type filter (e.g. TextField, Button, Text)",
                    include: "optional array/csv of extracted fields (e.g. label,passwordField,hintText)",
                    includeNode: "optional boolean, include full parsed node payload",
                    limit: "optional, default 200",
                    offset: "optional, default 0"
                  },
                  examples: [
                    { cmd: "widgets.list", args: { nameOrId: "login" } },
                    { cmd: "widgets.list", args: { nameOrId: "login", type: "TextField", include: ["label", "passwordField"] } }
                  ]
                },
                "widgets.find": {
                  summary: "Canonical widget search with typed filters and compact payloads.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    type: "optional widget type",
                    types: "optional array/csv of widget types",
                    nameContains: "optional case-insensitive name match",
                    textContains: "optional case-insensitive text match",
                    q: "optional generic query match",
                    include: "optional array/csv of extracted fields",
                    includeNode: "optional boolean, include full parsed node payload",
                    limit: "optional, default 200",
                    offset: "optional, default 0"
                  },
                  examples: [
                    { cmd: "widgets.find", args: { nameOrId: "login", type: "TextField" } },
                    { cmd: "widgets.find", args: { nameOrId: "login", textContains: "Password" } }
                  ]
                },
                "tree.locate": {
                  summary: "Locate a widget in the tree with parent/index/sibling context.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    nodeId: "required widget node id"
                  },
                  examples: [
                    { cmd: "tree.locate", args: { nameOrId: "login", nodeId: "id-Text_wsxpaf81" } }
                  ]
                },
                "tree.subtree": {
                  summary: "Return subtree around a widget with bounded depth.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    nodeId: "optional widget node id (defaults to page root)",
                    depth: "optional depth, default 2, max 8"
                  },
                  examples: [
                    { cmd: "tree.subtree", args: { nameOrId: "login", nodeId: "id-Container_abc", depth: 2 } }
                  ]
                },
                "tree.find": {
                  summary: "Find nodes by type/name/query, or text content via widgets.findText.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    type: "optional widget type",
                    name: "optional widget name contains match",
                    q: "optional generic query",
                    text: "optional text match (delegates to widgets.findText)",
                    exact: "optional exact text match for text query",
                    limit: "optional, default 200",
                    offset: "optional, default 0"
                  },
                  examples: [
                    { cmd: "tree.find", args: { nameOrId: "login", type: "TextField" } },
                    { cmd: "tree.find", args: { nameOrId: "login", text: "James NC" } }
                  ]
                },
                "widget.unwrap": {
                  summary: "Unwrap a wrapper node and promote its children in place.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required wrapper node id",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [{ cmd: "widget.unwrap", args: { nameOrId: "login", nodeId: "id-Row_wrap", apply: true } }]
                },
                "widget.moveMany": {
                  summary: "Move multiple widgets atomically in one tree edit.",
                  args: {
                    nameOrId: "required page selector",
                    nodeIds: "required array/csv of node ids",
                    parentNodeId: "placement mode A",
                    beforeNodeId: "placement mode B",
                    afterNodeId: "placement mode C",
                    index: "optional index with parentNodeId",
                    preserveOrder: "optional boolean, default true"
                  },
                  examples: [
                    { cmd: "widget.moveMany", args: { nameOrId: "login", nodeIds: ["id-Text_a", "id-Button_b"], parentNodeId: "id-Column_parent", index: 0 } }
                  ]
                },
                "widget.action.list": {
                  summary: "List trigger/action bindings for a widget in split mode.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget node id",
                    includePayload: "optional boolean, default false",
                    limit: "optional, default 200",
                    offset: "optional, default 0"
                  },
                  examples: [{ cmd: "widget.action.list", args: { nameOrId: "login", nodeId: "id-Button_b" } }]
                },
                "widget.action.get": {
                  summary: "Get exact trigger/action payload for a widget trigger.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget node id",
                    trigger: "required trigger type/id",
                    actionNodeId: "optional action node id when multiple exist"
                  },
                  examples: [{ cmd: "widget.action.get", args: { nameOrId: "login", nodeId: "id-Button_b", trigger: "ON_TAP" } }]
                },
                "tree.validate": {
                  summary: "Validate split widget tree consistency against node files.",
                  args: {
                    nameOrId: "required page selector",
                    includeOrphans: "optional boolean, default true"
                  },
                  examples: [{ cmd: "tree.validate", args: { nameOrId: "login" } }]
                },
                "tree.repair": {
                  summary: "Repair selected tree consistency issues.",
                  args: {
                    nameOrId: "required page selector",
                    fixOrphans: "optional boolean",
                    fixMissingNodes: "optional boolean",
                    normalizeTree: "optional boolean",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [{ cmd: "tree.repair", args: { nameOrId: "login", fixOrphans: true } }]
                },
                "widgets.findText": {
                  summary: "Find widgets on a page that contain text matching a query.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    text: "required text query (aliases: q, query)",
                    exact: "optional boolean exact match (default false)",
                    type: "optional widget type filter",
                    types: "optional array/csv of widget types",
                    limit: "optional, default 200",
                    offset: "optional, default 0"
                  },
                  examples: [
                    { cmd: "widgets.findText", args: { nameOrId: "login", text: "James NC" } },
                    { cmd: "widgets.findText", args: { nameOrId: "login", text: "Password", type: "TextField" } }
                  ]
                },
                "textfields.list": {
                  summary: "Fast list of TextField widgets with extracted field metadata.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    q: "optional search text",
                    include: "optional array/csv (default: name,label,passwordField,hintText,initialValue)",
                    includeNode: "optional boolean, include full parsed node payload",
                    limit: "optional, default 200",
                    offset: "optional, default 0"
                  },
                  examples: [
                    { cmd: "textfields.list", args: { nameOrId: "login" } },
                    { cmd: "textfields.list", args: { nameOrId: "login", include: ["label", "passwordField"] } }
                  ]
                },
                "widget.get": {
                  summary: "Get a single widget node by nodeId.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    nodeId: "required widget id (alias: widgetId)"
                  },
                  examples: [
                    { cmd: "widget.get", args: { nameOrId: "login", nodeId: "id-TextField_dgr0b1pe" } }
                  ]
                },
                "widget.getMany": {
                  summary: "Batch-get widgets by nodeIds or filter in one call.",
                  args: {
                    nameOrId: "required page selector",
                    nodeIds: "optional array/csv of node ids (id-...)",
                    filter: "optional {type?,nameContains?,textContains?,nodeIds?}",
                    include: "optional display fields",
                    includeNode: "optional boolean, default false",
                    limit: "optional, default 200",
                    offset: "optional, default 0"
                  },
                  examples: [
                    { cmd: "widget.getMany", args: { nameOrId: "login", nodeIds: ["id-Text_a", "id-Button_b"] } },
                    { cmd: "widget.getMany", args: { nameOrId: "login", filter: { type: "TextField" } } }
                  ]
                },
                "widget.create": {
                  summary: "Create a widget node under a parent node.",
                  args: {
                    nameOrId: "required page selector",
                    parentNodeId: "required parent node id",
                    type: "required widget type (e.g. Text, Row, Button)",
                    nodeId: "optional explicit node id; default generated",
                    name: "optional widget name",
                    props: "optional props object",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [
                    { cmd: "widget.create", args: { nameOrId: "login", parentNodeId: "id-Column_abc", type: "Text" } }
                  ]
                },
                "widget.duplicate": {
                  summary: "Duplicate widget/subtree with fresh ids and insert nearby.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required source node",
                    beforeNodeId: "optional placement anchor",
                    afterNodeId: "optional placement anchor",
                    targetParentNodeId: "optional destination parent",
                    count: "optional duplicates count, default 1",
                    deep: "optional boolean, default true"
                  },
                  examples: [{ cmd: "widget.duplicate", args: { nameOrId: "login", nodeId: "id-Text_x", count: 2 } }]
                },
                "widget.deleteSubtree": {
                  summary: "Delete widget subtree and all referenced node files.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required subtree root",
                    keepNodeIds: "optional array/csv of descendants to keep"
                  },
                  examples: [{ cmd: "widget.deleteSubtree", args: { nameOrId: "login", nodeId: "id-Container_x" } }]
                },
                "widget.insert": {
                  summary: "Insert a new widget as child, before, or after in one command.",
                  args: {
                    nameOrId: "required page selector",
                    type: "required widget type",
                    nodeId: "optional explicit node id",
                    parentNodeId: "insert as child of parent (with optional index)",
                    beforeNodeId: "insert before anchor node",
                    afterNodeId: "insert after anchor node",
                    index: "optional child index when parentNodeId is provided",
                    name: "optional widget name",
                    props: "optional props object",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [
                    { cmd: "widget.insert", args: { nameOrId: "login", type: "Text", beforeNodeId: "id-Button_signin" } },
                    { cmd: "widget.insert", args: { nameOrId: "login", type: "Divider", parentNodeId: "id-Column_form", index: 2 } }
                  ]
                },
                "widgets.updateMany": {
                  summary: "Batch update multiple widgets in one changeset.",
                  args: {
                    nameOrId: "required page selector",
                    filter: "required {type?,nameContains?,textContains?,nodeIds?}",
                    set: "required {text?|keyValuePairs?|patch?}",
                    dryRun: "optional boolean, default false"
                  },
                  examples: [
                    {
                      cmd: "widgets.updateMany",
                      args: {
                        nameOrId: "login",
                        filter: { type: "Text" },
                        set: { text: "Updated" }
                      }
                    }
                  ]
                },
                "widget.replaceType": {
                  summary: "Replace widget type in place with conservative prop migration.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget id",
                    toType: "required new type",
                    propMode: "optional safe|force, default safe"
                  },
                  examples: [{ cmd: "widget.replaceType", args: { nameOrId: "login", nodeId: "id-Row_x", toType: "Column" } }]
                },
                "widget.removeChildren": {
                  summary: "Remove all or selected children under a parent widget.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required parent id",
                    keepNodeIds: "optional array/csv to keep"
                  },
                  examples: [{ cmd: "widget.removeChildren", args: { nameOrId: "login", nodeId: "id-Column_x" } }]
                },
                "widgets.copyPaste": {
                  summary: "Copy/paste subtree using clipboard tokens.",
                  args: {
                    mode: "required copy|paste",
                    nameOrId: "required page selector",
                    nodeId: "required for copy",
                    clipboardId: "required for paste",
                    parentNodeId: "paste placement",
                    beforeNodeId: "paste placement",
                    afterNodeId: "paste placement"
                  },
                  examples: [
                    { cmd: "widgets.copyPaste", args: { mode: "copy", nameOrId: "login", nodeId: "id-Container_x" } }
                  ]
                },
                "widget.wrap": {
                  summary: "Wrap an existing widget in a new wrapper widget (tree-level operation).",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required target widget node id (aliases: targetNodeId, wrapNodeId)",
                    wrapperType: "optional wrapper type (alias: type), default Row",
                    wrapperNodeId: "optional explicit wrapper node id",
                    name: "optional wrapper name",
                    props: "optional wrapper props object",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [
                    { cmd: "widget.wrap", args: { nameOrId: "login", nodeId: "id-Text_wsxpaf81", wrapperType: "Row" } }
                  ]
                },
                "widget.move": {
                  summary: "Move a widget in the tree by parent/index or before/after anchor.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget node id",
                    parentNodeId: "destination parent (with optional index)",
                    index: "destination index (with parentNodeId or for same-parent reorder)",
                    beforeNodeId: "insert before this node id",
                    afterNodeId: "insert after this node id",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [
                    { cmd: "widget.move", args: { nameOrId: "login", nodeId: "id-Text_wsxpaf81", beforeNodeId: "id-Button_n20fdjpx" } }
                  ]
                },
                "widget.reorder": {
                  summary: "Move a widget up/down within its current parent.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget node id",
                    direction: "required: up|down",
                    steps: "optional integer steps, default 1"
                  },
                  examples: [
                    { cmd: "widget.reorder", args: { nameOrId: "login", nodeId: "id-Text_wsxpaf81", direction: "up" } }
                  ]
                },
                "component.extractFromWidget": {
                  summary: "Extract subtree into a reusable component and replace source.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget root",
                    componentName: "required component name"
                  },
                  examples: [
                    { cmd: "component.extractFromWidget", args: { nameOrId: "login", nodeId: "id-Container_x", componentName: "LoginHeader" } }
                  ]
                },
                "component.instance.insert": {
                  summary: "Insert component instance using widget.insert placement semantics.",
                  args: {
                    nameOrId: "required page selector",
                    componentNameOrId: "required component selector",
                    parentNodeId: "optional placement",
                    beforeNodeId: "optional placement",
                    afterNodeId: "optional placement"
                  },
                  examples: [
                    { cmd: "component.instance.insert", args: { nameOrId: "login", componentNameOrId: "LoginHeader", parentNodeId: "id-Column_x" } }
                  ]
                },
                "widget.set": {
                  summary: "Set widget properties by key/value, text shortcut, or patch object.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget node id",
                    key: "optional property key/path (when using key/value form)",
                    value: "value for key/value form",
                    text: "shortcut for text widgets (sets props.text.textValue.inputValue)",
                    patch: "object for yaml-merge mode",
                    mirrorMostRecent: "optional boolean, default true",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [
                    { cmd: "widget.set", args: { nameOrId: "login", nodeId: "id-Text_wsxpaf81", text: "James NC" } },
                    { cmd: "widget.set", args: { nameOrId: "login", nodeId: "id-Text_wsxpaf81", key: "props.text.textValue.inputValue", value: "James NC" } }
                  ]
                },
                "widget.bindData": {
                  summary: "Deterministic key-level data binding write (safe wrapper on widget.set).",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget node id",
                    key: "required key/path",
                    binding: "required bound value/object",
                    mirrorMostRecent: "optional boolean, default true",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [
                    { cmd: "widget.bindData", args: { nameOrId: "login", nodeId: "id-Text_a", key: "props.text.textValue.inputValue", binding: "James NC" } }
                  ]
                },
                "widget.bindAction": {
                  summary: "Upsert/replace/delete widget trigger actions in split-tree mode.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget node id",
                    trigger: "required trigger (e.g. ON_TAP)",
                    action: "required action object for upsert/replace",
                    mode: "optional upsert|replace|delete (default upsert)",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [
                    { cmd: "widget.bindAction", args: { nameOrId: "login", nodeId: "id-Button_x", trigger: "ON_TAP", action: { navigate: { isNavigateBack: true } } } }
                  ]
                },
                "routes.upsert": {
                  summary: "Create or update a widget navigation route binding.",
                  args: {
                    nameOrId: "required source page selector",
                    nodeId: "required source widget node id",
                    toPageNameOrId: "required destination page selector",
                    trigger: "optional trigger, default ON_TAP",
                    allowBack: "optional boolean",
                    navigateBack: "optional boolean",
                    passedParameters: "optional object",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [
                    { cmd: "routes.upsert", args: { nameOrId: "login", nodeId: "id-Button_x", toPageNameOrId: "DailyDashboard", apply: true } }
                  ]
                },
                "routes.delete": {
                  summary: "Delete navigation route binding from widget trigger.",
                  args: {
                    nameOrId: "required page selector",
                    nodeId: "required widget node id",
                    trigger: "optional trigger, default ON_TAP",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [{ cmd: "routes.delete", args: { nameOrId: "login", nodeId: "id-Button_x", apply: true } }]
                },
                "routes.listByPage": {
                  summary: "List routes scoped to a page with optional widget-action enrichment.",
                  args: {
                    nameOrId: "required page selector",
                    direction: "optional outgoing|incoming|both, default both",
                    includeWidgetActions: "optional boolean, default true"
                  },
                  examples: [{ cmd: "routes.listByPage", args: { nameOrId: "login", direction: "outgoing" } }]
                },
                "routes.validate": {
                  summary: "Validate page route/action integrity.",
                  args: {
                    nameOrId: "required page selector",
                    strict: "optional boolean, default false",
                    includeOrphans: "optional boolean, default true"
                  },
                  examples: [{ cmd: "routes.validate", args: { nameOrId: "login", strict: true } }]
                },
                "snapshots.ensureFresh": {
                  summary: "Ensure snapshot freshness with stale-aware incremental refresh.",
                  args: {
                    snapshotId: "optional explicit snapshot",
                    projectId: "optional snapshot project filter",
                    strictSnapshot: "optional boolean, require explicit snapshot context",
                    staleMinutes: "optional integer threshold",
                    mode: "optional incremental|full, default incremental",
                    force: "optional boolean, default false"
                  },
                  examples: [{ cmd: "snapshots.ensureFresh", args: { staleMinutes: 20 } }]
                },
                "snapshots.refresh": {
                  summary: "Refresh snapshot from FlutterFlow with optional throttling controls.",
                  args: {
                    snapshotId: "optional explicit snapshot (or input.snapshot)",
                    mode: "optional incremental|full, default incremental",
                    fetchStrategy: "optional auto|bulk|file, default auto",
                    maxFetch: "optional max file fetches per run (1..2000)",
                    concurrency: "optional fetch concurrency (1..16, default 1; slow-safe)",
                    sleepMs: "optional delay between file fetches in each worker, default 250ms",
                    listRetries: "optional retries for listPartitionedFileNames on 429 (0..6, default 2)",
                    listRetryBaseMs: "optional base backoff for list retries, default 1500",
                    chunkedFull:
                      "optional boolean; default true when mode=full+fetchStrategy=file (set false to force one-shot relist behavior)",
                    chunkSessionId: "optional session id to resume a chunked full refresh",
                    resetChunkSession: "optional boolean; reset existing chunk session before run"
                  },
                  examples: [
                    { cmd: "snapshots.refresh", args: { mode: "incremental", maxFetch: 25, concurrency: 1, sleepMs: 250 } },
                    {
                      cmd: "snapshots.refresh",
                      args: { mode: "full", fetchStrategy: "file", maxFetch: 10, concurrency: 1, sleepMs: 1000 }
                    }
                  ]
                },
                "snapshots.refreshSlow": {
                  summary: "Rate-limited incremental crawl with retry delays and progress output.",
                  args: {
                    snapshotId: "optional explicit snapshot (or input.snapshot)",
                    passes: "optional number of incremental passes (1..20, default 3)",
                    pauseMs: "optional delay between passes, default 10000",
                    fetchStrategy: "optional auto|bulk|file, default auto",
                    maxFetch: "optional max file fetches per pass (1..2000, default 25)",
                    concurrency: "optional fetch concurrency (1..16, default 1)",
                    sleepMs: "optional delay between file fetches in each worker, default 250",
                    listRetries: "optional retries for listPartitionedFileNames on 429 (0..6, default 2)",
                    listRetryBaseMs: "optional base backoff for list retries, default 1500"
                  },
                  examples: [
                    { cmd: "snapshots.refreshSlow", args: { passes: 4, pauseMs: 15000, maxFetch: 20 } }
                  ]
                },
                "changeset.applySafe": {
                  summary: "Safe apply orchestration: preview -> validate -> apply (+ optional retry/manual export).",
                  args: {
                    changesetId: "required changeset id",
                    confirm: "required true",
                    remoteValidate: "optional boolean, default true",
                    retryWithoutRemoteValidate: "optional boolean, default true",
                    rateLimitRetries: "optional retries on apply 429 failures (0..6, default 3)",
                    rateLimitBaseMs: "optional base backoff for apply 429 retries, default 1500",
                    rateLimitMaxWaitMs: "optional total wait budget for apply retries, default 90000",
                    exportOnFailure: "optional boolean, default true"
                  },
                  examples: [{ cmd: "changeset.applySafe", args: { changesetId: "chg_x", confirm: true } }]
                },
                "changeset.rollback": {
                  summary: "Create inverse changeset from one applied changeset.",
                  args: {
                    confirm: "required true",
                    changesetId: "optional explicit applied changeset id",
                    latestApplied: "optional true to rollback latest applied in snapshot",
                    snapshotId: "optional for latestApplied lookup",
                    apply: "optional boolean, default false",
                    remoteValidate: "optional boolean, default true"
                  },
                  examples: [{ cmd: "changeset.rollback", args: { changesetId: "chg_x", confirm: true, apply: true } }]
                },
                "changeset.revert": {
                  summary: "Alias for changeset.rollback.",
                  args: {
                    confirm: "required true",
                    changesetId: "optional explicit applied changeset id",
                    latestApplied: "optional true to rollback latest applied in snapshot"
                  },
                  examples: [{ cmd: "changeset.revert", args: { changesetId: "chg_x", confirm: true } }]
                },
                "selection.get": {
                  summary: "Get last remembered page/widget selection for current or specified snapshot.",
                  args: {
                    snapshotId: "optional explicit snapshot lookup"
                  },
                  examples: [{ cmd: "selection.get" }]
                },
                "selection.clear": {
                  summary: "Clear remembered selection for current snapshot or globally.",
                  args: {
                    snapshotId: "optional explicit snapshot to clear"
                  },
                  examples: [{ cmd: "selection.clear" }]
                },
                "page.scaffold": {
                  summary: "Generate a best-practice page scaffold from a deterministic recipe.",
                  args: {
                    recipe: `required recipe id (${pageRecipeIds().join(", ")})`,
                    name: "required page display name (or provide newPageId/pageId)",
                    newPageId: "optional explicit page id (alias: pageId)",
                    params: "optional recipe params object",
                    wireActions: "optional boolean, default false",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false"
                  },
                  examples: [
                    { cmd: "page.scaffold", args: { name: "login2", recipe: "auth.login", preview: true } },
                    {
                      cmd: "page.scaffold",
                      args: {
                        name: "products",
                        recipe: "list.cards.search",
                        params: { title: "Products", searchPlaceholder: "Search products" }
                      }
                    }
                  ]
                },
                "page.get": {
                  summary: "Resolve page metadata by name/id/file key.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)"
                  },
                  examples: [{ cmd: "page.get", args: { nameOrId: "login" } }]
                },
                "page.preflightDelete": {
                  summary: "Analyze page delete safety (incoming routes and references) before mutation.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    strictSnapshot: "optional boolean, disable best-snapshot fallback"
                  },
                  examples: [{ cmd: "page.preflightDelete", args: { nameOrId: "login" } }]
                },
                "page.remove": {
                  summary: "Transactional page removal wrapper (preflight + hard-delete attempt + archive fallback).",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    force: "optional boolean, allow removal even with incoming routes",
                    ensureFresh: "optional boolean, default true",
                    strictSnapshot: "optional boolean, pin to requested snapshot",
                    apply: "optional boolean, default false"
                  },
                  examples: [{ cmd: "page.remove", args: { nameOrId: "login2", apply: true } }]
                },
                "page.delete": {
                  summary: "Low-level hard-delete attempt for page files. Prefer page.remove for robust UX.",
                  args: {
                    nameOrId: "required page selector (aliases: pageId, id, fileKey)",
                    preview: "optional boolean, default true",
                    apply: "optional boolean, default false",
                    strictSnapshot: "optional boolean, pin to requested snapshot"
                  },
                  examples: [{ cmd: "page.delete", args: { nameOrId: "login2", apply: true } }]
                },
                "page.clone": {
                  summary: "Clone page root + tree + node files with remapped IDs.",
                  args: {
                    nameOrId: "required source page selector",
                    newPageId: "optional target page id",
                    newName: "optional page name"
                  },
                  examples: [{ cmd: "page.clone", args: { nameOrId: "login", newName: "loginCopy" } }]
                },
                "intent.run": {
                  summary: "Deterministic natural-language to command mapping.",
                  args: {
                    text: "required natural-language instruction",
                    selection: "optional {pageId,nodeId,fileKey}",
                    ensureFresh: "optional boolean, default true for writes",
                    apply: "optional boolean"
                  },
                  examples: [{ cmd: "intent.run", args: { text: "list text fields on login" } }]
                }
              };

              if (docs[target]) {
                return this.ok(parsed.cmd, { cmd: target, ...docs[target] });
              }
              return this.ok(parsed.cmd, {
                cmd: target,
                message: "No command-specific docs found. Use orbit({cmd:'help'}) for full command list."
              });
            }
          }
          return this.ok(parsed.cmd, {
            summary: "Orbit command palette",
            usage: "orbit({cmd,args?,snapshot?,format?})",
            commands: HELP_COMMANDS,
            examples: [
              { cmd: "projects.list" },
              { cmd: "snapshots.create", args: { projectId: "your-project-id", name: "baseline" } },
              { cmd: "page.create", args: { name: "Landing", apply: true } },
              { cmd: "widget.create", args: { nameOrId: "Landing", parentNodeId: "id-Scaffold_x", type: "Text" } },
              { cmd: "changeset.new", snapshot: "snap_x", args: { title: "Adjust theme", intent: "Tune body text color" } },
              { cmd: "schema.search", args: { query: "navigation guard", tags: ["safety"] } }
            ]
          });

        case "api.capabilities":
          return this.ok(parsed.cmd, {
            adapter: "FlutterFlow Project API v2 + compatibility layer",
            endpoints: {
              listProjects: "POST/GET /l/listProjects",
              listPartitionedFileNames: "GET /listPartitionedFileNames",
              projectYamls: "GET /projectYamls",
              validateProjectYaml: "POST /validateProjectYaml",
              updateProjectByYaml: "POST /updateProjectByYaml"
            },
            behaviors: [
              "Bulk YAML export decoding from projectYamlBytes (base64 zip)",
              "Incremental refresh using hashes when available",
              "VersionInfo persistence (partitionerVersion + projectSchemaFingerprint)",
              "Optional remote validate per changed file during apply"
            ]
          });

        case "projects.list":
          try {
            return this.ok(parsed.cmd, {
              projects: await this.adapter.listProjects(),
              source: "flutterflow-api"
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const policyProjects = this.policyEngine
              .getPolicy()
              .allowProjects.filter((value) => value.trim().length > 0 && !isLikelyGlobPattern(value))
              .map((id) => ({ id, name: id }));
            const snapshotProjects = this.snapshotRepo
              .listSnapshots()
              .map((snapshot) => snapshot.projectId)
              .filter((value, index, all) => all.indexOf(value) === index)
              .map((id) => ({ id, name: id }));
            const merged = [...policyProjects, ...snapshotProjects].filter(
              (project, index, all) => all.findIndex((entry) => entry.id === project.id) === index
            );

            return this.ok(
              parsed.cmd,
              {
                projects: merged,
                source: "local-fallback"
              },
              [`Remote projects.list unavailable (${message}). Using policy/snapshot fallback IDs.`]
            );
          }

        case "snapshots.create": {
          const projectId = strArg(args, "projectId");
          const name = strArg(args, "name", false);
          const snapshot = this.snapshotRepo.createSnapshot(projectId, name || undefined);
          const listed = await this.adapter.listPartitionedFileNames(projectId);
          const bundled = await this.adapter.fetchProjectYamls(projectId, undefined, { includeVersionInfo: true });

          const preferredKeys = new Set(listed.files.map((entry) => entry.fileKey));
          const collected = new Map<string, string>(Object.entries(bundled.files));

          const warnings: string[] = [];
          if (preferredKeys.size > 0) {
            const missingKeys = [...preferredKeys].filter((key) => !collected.has(key));
            if (missingKeys.length > 0) {
              const results = await Promise.allSettled(
                missingKeys.map(async (key) => {
                  const yaml = await this.adapter.fetchFile(projectId, key);
                  return { key, yaml };
                })
              );
              for (const result of results) {
                if (result.status === "fulfilled") {
                  collected.set(result.value.key, result.value.yaml);
                } else {
                  const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
                  warnings.push(`Failed to fetch: ${message}`);
                }
              }
            }
          }

          const files = [...collected.entries()].map(([fileKey, yaml]) => ({
            fileKey,
            yaml,
            sha256: sha256(yaml)
          }));

          if (files.length === 0) {
            throw new Error(
              "Snapshot created but no project files were fetched. Verify FlutterFlow API path config and projectId, then retry snapshots.refresh."
            );
          }

          this.snapshotRepo.upsertFiles(snapshot.snapshotId, files);
          const versionInfo = bundled.versionInfo ?? listed.versionInfo;
          if (versionInfo) {
            this.snapshotRepo.setVersionInfo(snapshot.snapshotId, versionInfo);
          }
          this.snapshotRepo.touchSnapshot(snapshot.snapshotId);
          await this.reindex(snapshot.snapshotId);

          return this.ok(parsed.cmd, {
            snapshot,
            fileCount: files.length,
            versionInfo,
            notes: ["Point-in-time snapshot created. Use snapshots.refresh to update."]
          }, warnings);
        }

        case "snapshots.refresh": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const modeRaw = strArg(args, "mode", false) || "incremental";
          const mode = modeRaw === "full" ? "full" : "incremental";
          const fetchStrategy = parseFetchStrategy(args);
          const chunkedFlagProvided =
            Object.prototype.hasOwnProperty.call(args, "chunkedFull") ||
            Object.prototype.hasOwnProperty.call(args, "chunked");
          const chunkedFull = chunkedFlagProvided
            ? boolArg(args, "chunkedFull", false) || boolArg(args, "chunked", false)
            : mode === "full" && fetchStrategy === "file";
          const chunkSessionId = strArg(args, "chunkSessionId", false) || strArg(args, "sessionId", false);
          const resetChunkSession = boolArg(args, "resetChunkSession", false) || boolArg(args, "resetSession", false);
          const maxFetchRaw = numArg(args, "maxFetch", 0);
          const concurrencyRaw = numArg(args, "concurrency", 1);
          const sleepMsRaw = numArg(args, "sleepMs", 250);
          const listRetriesRaw = numArg(args, "listRetries", 2);
          const listRetryBaseMsRaw = numArg(args, "listRetryBaseMs", 1500);
          const useChunkedFull =
            mode === "full" && fetchStrategy === "file" && (chunkedFull || Boolean(chunkSessionId) || resetChunkSession);
          const result = useChunkedFull
            ? await this.refreshSnapshotFullChunked(snapshotId, {
                chunkSessionId,
                resetChunkSession,
                maxFetch: maxFetchRaw > 0 ? clampInt(maxFetchRaw, 1, 2000) : 25,
                concurrency: clampInt(concurrencyRaw, 1, 16),
                sleepMs: clampInt(sleepMsRaw, 0, 60_000),
                listRetries: clampInt(listRetriesRaw, 0, 6),
                listRetryBaseMs: clampInt(listRetryBaseMsRaw, 250, 60_000)
              })
            : await this.refreshSnapshotOnce(snapshotId, {
                mode,
                fetchStrategy,
                maxFetch: maxFetchRaw > 0 ? clampInt(maxFetchRaw, 1, 2000) : undefined,
                concurrency: clampInt(concurrencyRaw, 1, 16),
                sleepMs: clampInt(sleepMsRaw, 0, 60_000),
                listRetries: clampInt(listRetriesRaw, 0, 6),
                listRetryBaseMs: clampInt(listRetryBaseMsRaw, 250, 60_000)
              });

          return this.ok(
            parsed.cmd,
            {
              snapshotId,
              mode: result.mode,
              fetchedCount: result.fetchedCount,
              attemptedFetchCount: result.attemptedFetchCount,
              totalRemoteFiles: result.totalRemoteFiles,
              strategyUsed: result.strategyUsed,
              failedFetchCount: result.failedFetchCount,
              partial: result.partial,
              pruneApplied: result.pruneApplied,
              authoritative: result.authoritative,
              versionInfo: result.versionInfo,
              notes: result.notes,
              chunkSession: result.chunkSession
            },
            result.warnings
          );
        }

        case "snapshots.refreshSlow": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const passes = clampInt(numArg(args, "passes", 3), 1, 20);
          const pauseMs = clampInt(numArg(args, "pauseMs", 10_000), 0, 300_000);
          const fetchStrategy = parseFetchStrategy(args);
          const maxFetchRaw = numArg(args, "maxFetch", 25);
          const concurrencyRaw = numArg(args, "concurrency", 1);
          const sleepMsRaw = numArg(args, "sleepMs", 250);
          const listRetriesRaw = numArg(args, "listRetries", 2);
          const listRetryBaseMsRaw = numArg(args, "listRetryBaseMs", 1500);

          const passResults: Array<{
            pass: number;
            mode: "incremental" | "full";
            fetchedCount: number;
            attemptedFetchCount: number;
            totalRemoteFiles: number;
            strategyUsed: "bulk" | "file";
            failedFetchCount: number;
            partial: boolean;
            pruneApplied: boolean;
            authoritative: boolean;
            warningsCount: number;
            notes: string[];
          }> = [];
          const warnings: string[] = [];
          let totalFetchedCount = 0;
          let totalAttemptedFetchCount = 0;
          let totalRemoteFiles = 0;
          let totalFailedFetchCount = 0;
          let lastVersionInfo: unknown;
          let authoritative = true;

          for (let pass = 1; pass <= passes; pass += 1) {
            const refreshed = await this.refreshSnapshotOnce(snapshotId, {
              mode: "incremental",
              fetchStrategy,
              maxFetch: maxFetchRaw > 0 ? clampInt(maxFetchRaw, 1, 2000) : undefined,
              concurrency: clampInt(concurrencyRaw, 1, 16),
              sleepMs: clampInt(sleepMsRaw, 0, 60_000),
              listRetries: clampInt(listRetriesRaw, 0, 6),
              listRetryBaseMs: clampInt(listRetryBaseMsRaw, 250, 60_000)
            });

            totalFetchedCount += refreshed.fetchedCount;
            totalAttemptedFetchCount += refreshed.attemptedFetchCount;
            totalRemoteFiles = refreshed.totalRemoteFiles;
            totalFailedFetchCount += refreshed.failedFetchCount;
            lastVersionInfo = refreshed.versionInfo;
            authoritative = authoritative && refreshed.authoritative;
            warnings.push(...refreshed.warnings);
            passResults.push({
              pass,
              mode: refreshed.mode,
              fetchedCount: refreshed.fetchedCount,
              attemptedFetchCount: refreshed.attemptedFetchCount,
              totalRemoteFiles: refreshed.totalRemoteFiles,
              strategyUsed: refreshed.strategyUsed,
              failedFetchCount: refreshed.failedFetchCount,
              partial: refreshed.partial,
              pruneApplied: refreshed.pruneApplied,
              authoritative: refreshed.authoritative,
              warningsCount: refreshed.warnings.length,
              notes: refreshed.notes
            });

            if (pass < passes && refreshed.attemptedFetchCount > 0 && refreshed.fetchedCount === 0) {
              warnings.push("Stopping slow refresh early because attempted files fetched 0 successfully.");
              break;
            }

            if (pass < passes && refreshed.attemptedFetchCount < (maxFetchRaw > 0 ? maxFetchRaw : Number.MAX_SAFE_INTEGER)) {
              warnings.push("Stopping slow refresh early because pass processed fewer files than batch budget.");
              break;
            }

            if (pass < passes && pauseMs > 0) {
              await waitMs(pauseMs);
            }
          }

          return this.ok(
            parsed.cmd,
            {
              snapshotId,
              mode: "incremental",
              passesRequested: passes,
              passesCompleted: passResults.length,
              totalFetchedCount,
              totalAttemptedFetchCount,
              totalRemoteFiles,
              totalFailedFetchCount,
              authoritative,
              versionInfo: lastVersionInfo,
              passResults
            },
            warnings
          );
        }

        case "snapshots.ensureFresh": {
          const explicitSnapshotId = strArg(args, "snapshotId", false);
          const explicitProjectId = strArg(args, "projectId", false);
          const strictSnapshot = boolArg(args, "strictSnapshot", false);
          const staleMinutes = parseStaleMinutes(args.staleMinutes);
          const force = boolArg(args, "force", false);
          const mode = (strArg(args, "mode", false) || "incremental") === "full" ? "full" : "incremental";

          let snapshotId = explicitSnapshotId || parsed.snapshot || "";
          if (!snapshotId) {
            if (strictSnapshot) {
              throw new Error("strictSnapshot=true requires snapshotId (arg or input.snapshot).");
            }
            const snapshots = this.snapshotRepo.listSnapshots();
            const candidate = explicitProjectId
              ? snapshots.find((entry) => entry.projectId === explicitProjectId)
              : snapshots[0];
            if (!candidate) {
              throw new Error("No snapshot available. Create one with snapshots.create first.");
            }
            snapshotId = candidate.snapshotId;
          }

          const snapshot = this.requireSnapshot(snapshotId);
          const staleBefore = computeSnapshotStaleness(snapshot.refreshedAt, staleMinutes);
          const incomplete = isSnapshotLikelyIncomplete(this.snapshotRepo, snapshotId);
          const fingerprintDrift = await hasFingerprintDrift(this.adapter, this.snapshotRepo, snapshotId, snapshot.projectId);
          const shouldRefresh = force || staleBefore || incomplete || fingerprintDrift;

          let refreshResult: unknown;
          let warnings: string[] = [];
          let reason = "snapshot_fresh";
          if (shouldRefresh) {
            reason = force
              ? "forced"
              : incomplete
              ? "snapshot_empty"
              : fingerprintDrift
              ? "fingerprint_drift"
              : "snapshot_stale";
            const refreshed = await this.run({
              cmd: "snapshots.refresh",
              snapshot: snapshotId,
              args: { mode }
            });
            if (!refreshed.ok) {
              return refreshed;
            }
            refreshResult = refreshed.data;
            warnings = refreshed.warnings ?? [];
          }

          const after = this.requireSnapshot(snapshotId);
          const staleAfter = computeSnapshotStaleness(after.refreshedAt, staleMinutes);
          const result: SnapshotEnsureFreshResult = {
            snapshotId,
            projectId: snapshot.projectId,
            wasRefreshed: shouldRefresh,
            staleBefore,
            staleAfter,
            reason,
            refreshResult,
            warnings
          };
          return this.ok(parsed.cmd, result, warnings);
        }

        case "snapshots.info": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const snapshot = this.requireSnapshot(snapshotId);
          const files = this.snapshotRepo.countFiles(snapshotId);
          const symbols = this.indexRepo.listSymbols(snapshotId);
          const edges = this.indexRepo.listEdges(snapshotId);
          const versionInfo = this.snapshotRepo.getVersionInfo(snapshotId);

          return this.ok(parsed.cmd, {
            snapshot,
            versionInfo,
            counts: {
              files,
              pages: symbols.filter((s) => s.kind === "page").length,
              components: symbols.filter((s) => s.kind === "component").length,
              actions: symbols.filter((s) => s.kind === "action").length,
              widgets: symbols.filter((s) => s.kind === "widget").length,
              navEdges: edges.filter((e) => e.kind === "nav").length,
              usageEdges: edges.filter((e) => e.kind === "usage").length
            }
          });
        }

        case "snapshots.ls": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          this.requireSnapshot(snapshotId);
          const prefix = strArg(args, "prefix", false) || undefined;
          const limit = numArg(args, "limit", 50);
          const files = this.snapshotRepo.listFiles(snapshotId, prefix, limit);
          return this.ok(parsed.cmd, {
            snapshotId,
            files: files.map((file) => ({
              fileKey: file.fileKey,
              sha256: file.sha256,
              updatedAt: file.updatedAt,
              size: file.yaml.length
            }))
          });
        }

        case "search": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const snapshot = this.requireSnapshot(snapshotId);
          const q = strArg(args, "q", false) || strArg(args, "query", false);
          if (!q) {
            throw new Error("Missing string arg: q (alias: query)");
          }
          const mode = strArg(args, "mode", false) || "keyword";
          const scope = strArg(args, "scope", false) || "both";
          const limit = Math.max(1, Math.min(numArg(args, "limit", 80), 500));
          const offset = Math.max(0, numArg(args, "offset", 0));
          const files = this.snapshotRepo.listFiles(snapshotId, undefined, 15_000);
          const results: Array<Record<string, unknown>> = [];
          let totalMatches = 0;

          const tryPush = (row: Record<string, unknown>): void => {
            if (totalMatches >= offset && results.length < limit) {
              results.push(row);
            }
            totalMatches += 1;
          };

          const matcher = (() => {
            if (mode === "prefix") {
              return (text: string) => text.toLowerCase().startsWith(q.toLowerCase());
            }
            if (mode === "regex") {
              const re = compileSafeRegex(q);
              return (text: string) => re.test(text);
            }
            return (text: string) => text.toLowerCase().includes(q.toLowerCase());
          })();

          for (const file of files) {
            if (scope === "keys" || scope === "both") {
              if (matcher(file.fileKey)) {
                tryPush({ fileKey: file.fileKey, hit: "key" });
              }
            }
            if (scope === "content" || scope === "both") {
              let match = false;
              let snippet = "";
              if (mode === "regex") {
                const regex = compileSafeRegex(q);
                const found = regex.exec(file.yaml);
                if (found) {
                  match = true;
                  const idx = found.index;
                  snippet = clip(file.yaml.slice(Math.max(0, idx - 80), idx + 120), 240);
                }
              } else {
                const idx = mode === "prefix" ? file.yaml.toLowerCase().indexOf(q.toLowerCase()) : file.yaml.toLowerCase().indexOf(q.toLowerCase());
                if (idx >= 0) {
                  match = true;
                  snippet = clip(file.yaml.slice(Math.max(0, idx - 80), idx + 120), 240);
                }
              }
              if (match) {
                tryPush({ fileKey: file.fileKey, hit: "content", snippet });
              }
            }
            if (results.length >= limit && totalMatches >= offset + limit) {
              break;
            }
          }

          return this.ok(parsed.cmd, {
            snapshotId,
            totalMatches,
            limit,
            offset,
            results
          }, this.snapshotWarnings(snapshot));
        }

        case "page.create": {
          const writeContext = this.resolveWriteSnapshotContext(parsed, args);
          const snapshotId = writeContext.snapshotId;
          const snapshot = writeContext.snapshot;
          const name =
            strArg(args, "name", false) ||
            strArg(args, "pageName", false) ||
            strArg(args, "title", false);
          if (!name) {
            throw new Error("Missing string arg: name (aliases: pageName, title)");
          }

          const pageIdRaw = strArg(args, "pageId", false) || strArg(args, "id", false);
          const pageId = pageIdRaw ? normalizeNodeId(pageIdRaw) : generatePageId();
          const existingPage = this.resolvePage(snapshotId, pageId) || this.resolvePage(snapshotId, name);
          if (existingPage) {
            throw new Error(`Page already exists: ${pageId}`);
          }

          const rootFileKey = `page/${pageId}.yaml`;
          const treeFileKey = `page/${pageId}/page-widget-tree-outline.yaml`;
          const nodeFileKey = `page/${pageId}/page-widget-tree-outline/node/${pageId}.yaml`;
          const rootYaml = buildPageRootYaml(pageId, name);
          const treeYaml = buildPageTreeYaml(pageId);
          const nodeYaml = buildWidgetNodeYaml(pageId, "Scaffold", undefined, {});

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Create page ${name}`,
            strArg(args, "intent", false) || `Create page ${name} (${pageId})`
          ).changesetId;

          const entries = [
            this.changesets.addEntry(changesetId, rootFileKey, {
              type: "replace-range",
              start: 0,
              end: 0,
              replacement: rootYaml
            }, "Create page root"),
            this.changesets.addEntry(changesetId, treeFileKey, {
              type: "replace-range",
              start: 0,
              end: 0,
              replacement: treeYaml
            }, "Create page widget tree"),
            this.changesets.addEntry(changesetId, nodeFileKey, {
              type: "replace-range",
              start: 0,
              end: 0,
              replacement: nodeYaml
            }, "Create root scaffold node")
          ];

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            requestedSnapshotId: writeContext.requestedSnapshotId,
            projectId: snapshot.projectId,
            page: {
              pageId,
              name,
              fileKey: rootFileKey
            },
            changesetId,
            entries,
            preview,
            validation,
            applyResult
          }, writeContext.warnings);
        }

        case "page.scaffold": {
          const writeContext = this.resolveWriteSnapshotContext(parsed, args);
          const snapshotId = writeContext.snapshotId;
          const snapshot = writeContext.snapshot;
          const recipe = strArg(args, "recipe", false);
          if (!recipe) {
            throw new Error(`SCAFFOLD_PARAM_INVALID: missing recipe (expected one of ${pageRecipeIds().join(", ")})`);
          }
          const explicitName =
            strArg(args, "name", false) ||
            strArg(args, "pageName", false) ||
            strArg(args, "title", false);
          const pageIdRaw = strArg(args, "newPageId", false) || strArg(args, "pageId", false);
          if (!explicitName && !pageIdRaw) {
            throw new Error("SCAFFOLD_PARAM_INVALID: provide name or newPageId/pageId");
          }
          const pageId = pageIdRaw ? normalizeNodeId(pageIdRaw) : generatePageId();
          const name = explicitName || pageId;
          const params = asObject(args.params);
          const wireActions = boolArg(args, "wireActions", false);
          const existingById = this.resolvePage(snapshotId, pageId);
          const existingByName = this.resolvePage(snapshotId, name);
          if (existingById || existingByName) {
            const suggestionBase = name.replace(/\s+/g, "");
            const suggestions = [`${suggestionBase}2`, `${suggestionBase}_v2`, `${suggestionBase}Copy`];
            throw new Error(
              `SCAFFOLD_PAGE_EXISTS: page '${name}' or id '${pageId}' already exists. Try name/newPageId: ${suggestions.join(", ")}`
            );
          }

          let scaffold;
          try {
            scaffold = compilePageScaffold({
              pageId,
              name,
              recipe: recipe as PageRecipeId,
              params,
              wireActions
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown scaffold compile failure";
            if (
              message.startsWith("SCAFFOLD_RECIPE_UNKNOWN:") ||
              message.startsWith("SCAFFOLD_PARAM_INVALID:") ||
              message.startsWith("SCAFFOLD_PAGE_EXISTS:") ||
              message.startsWith("SCAFFOLD_LAYOUT_INVALID:") ||
              message.startsWith("SCAFFOLD_ACTION_WIRING_UNSUPPORTED:")
            ) {
              throw error;
            }
            throw new Error(`SCAFFOLD_COMPILE_FAILED: ${message}`);
          }

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Scaffold page ${name}`,
            strArg(args, "intent", false) || `Generate ${scaffold.recipe} scaffold for ${name}`
          ).changesetId;

          const entries = scaffold.files.map((file) =>
            this.changesets.addEntry(
              changesetId,
              file.fileKey,
              {
                type: "replace-range",
                start: 0,
                end: 0,
                replacement: file.yaml
              },
              strArg(args, "note", false) || `Scaffold ${scaffold.recipe}`
            )
          );

          const previewEnabled = boolArg(args, "preview", true);
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const preview = previewEnabled ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;
          const state = applyNow ? (applyResult?.applied ? "applied" : "failed") : "staged";

          return this.ok(parsed.cmd, {
            snapshotId,
            usedSnapshotId: snapshotId,
            requestedSnapshotId: writeContext.requestedSnapshotId,
            projectId: snapshot.projectId,
            state,
            page: {
              pageId,
              name,
              fileKey: `page/${pageId}.yaml`
            },
            recipe: scaffold.recipe,
            params: scaffold.params,
            generated: {
              nodeCount: scaffold.nodeCount,
              treeDepth: scaffold.treeDepth,
              filesCreated: scaffold.files.length
            },
            changesetId,
            entries,
            preview,
            validation,
            applyResult,
            selection: {
              snapshotId,
              pageId,
              nodeId: pageId,
              fileKey: `page/${pageId}.yaml`
            },
            suggestedNext: scaffold.suggestedNext
          }, writeContext.warnings.concat(scaffold.warnings));
        }

        case "page.get": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const snapshot = this.requireSnapshot(snapshotId);
          const query =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!query) {
            throw new Error("Missing string arg: nameOrId (aliases: pageId, id, fileKey)");
          }
          const resolved = this.resolvePage(snapshotId, query);
          if (!resolved) {
            throw new Error(`Page not found: ${query}`);
          }

          return this.ok(parsed.cmd, {
            page: resolved.page,
            outgoingRoutes: this.indexRepo.listOutgoingEdges(snapshotId, "nav", resolved.page.symbolId),
            incomingRoutes: this.indexRepo.listIncomingEdges(snapshotId, "nav", resolved.page.symbolId),
            file: resolved.page.fileKey,
            nodePath: resolved.page.nodePath
          }, this.snapshotWarnings(snapshot));
        }

        case "page.update": {
          const writeContext = this.resolveWriteSnapshotContext(parsed, args);
          const snapshotId = writeContext.snapshotId;
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const key = strArg(args, "key", false);
          const patch = asObject(args.patch);
          if (!key && Object.keys(patch).length === 0) {
            throw new Error("Provide key/value or patch for page.update");
          }
          if (key && !("value" in args)) {
            throw new Error("Missing arg: value");
          }

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Update page ${resolved.page.name}`,
            strArg(args, "intent", false) || `Update page ${resolved.page.name}`
          ).changesetId;

          let selector = "$";
          let entry;
          if (Object.keys(patch).length > 0) {
            entry = this.changesets.addEntry(changesetId, resolved.file.fileKey, {
              type: "yaml-merge",
              selector: "$",
              value: patch
            }, strArg(args, "note", false) || undefined);
          } else {
            selector = key!.startsWith("$") ? key! : joinSelector("$", key!);
            entry = this.changesets.addEntry(changesetId, resolved.file.fileKey, {
              type: "jsonpath",
              selector,
              value: args.value
            }, strArg(args, "note", false) || undefined);
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            requestedSnapshotId: writeContext.requestedSnapshotId,
            page: {
              pageId: pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            changesetId,
            selector,
            entry,
            preview,
            validation,
            applyResult
          }, writeContext.warnings);
        }

        case "page.preflightDelete": {
          const writeContext = this.resolveWriteSnapshotContext(parsed, args);
          const snapshotId = writeContext.snapshotId;
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const currentPageName = pickPageDisplayNameFromYaml(resolved.file.yaml) || resolved.page.name || pageId;
          const preflight = this.buildPageDeletePreflight(snapshotId, pageId);
          return this.ok(parsed.cmd, {
            snapshotId,
            usedSnapshotId: snapshotId,
            requestedSnapshotId: writeContext.requestedSnapshotId,
            page: {
              pageId,
              name: currentPageName,
              fileKey: resolved.page.fileKey
            },
            ...preflight
          }, writeContext.warnings);
        }

        case "page.remove": {
          const writeContext = this.resolveWriteSnapshotContext(parsed, args);
          const snapshotId = writeContext.snapshotId;
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const ensureFresh = boolArg(args, "ensureFresh", true);
          const force = boolArg(args, "force", false);
          const applyNow = boolArg(args, "apply", false);
          const previewEnabled = boolArg(args, "preview", true);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);

          const warnings = [...writeContext.warnings];
          if (ensureFresh) {
            const refreshed = await this.run({
              cmd: "snapshots.ensureFresh",
              snapshot: snapshotId,
              args: {
                staleMinutes: args.staleMinutes,
                mode: strArg(args, "mode", false) || "incremental",
                strictSnapshot: true
              }
            });
            if (!refreshed.ok) {
              return refreshed;
            }
            warnings.push(...(refreshed.warnings ?? []));
          }

          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const currentPageName = pickPageDisplayNameFromYaml(resolved.file.yaml) || resolved.page.name || pageId;
          const preflight = this.buildPageDeletePreflight(snapshotId, pageId);
          if (!preflight.canDelete && !force) {
            const reason = preflight.blockingReasons[0] || "Delete preflight blocked.";
            return this.ok(parsed.cmd, {
              snapshotId,
              usedSnapshotId: snapshotId,
              requestedSnapshotId: writeContext.requestedSnapshotId,
              state: "blocked",
              removed: false,
              blocked: true,
              mode: "preflight-blocked",
              errorCode: pageRemoveErrorCodeFromReason(reason, true),
              reason,
              page: {
                pageId,
                name: currentPageName,
                fileKey: resolved.page.fileKey
              },
              preflight,
              fallbackUsed: false,
              fallbackActions: [],
              postCheck: {
                existsInSnapshot: true,
                existsRemotely: undefined,
                nextRefreshRecommended: false
              },
              selection: {
                snapshotId,
                pageId,
                nodeId: pageId,
                fileKey: resolved.page.fileKey
              },
              suggestedNext: {
                cmd: "routes.listByPage",
                args: { nameOrId: pageId, direction: "incoming" }
              }
            }, warnings);
          }

          const deleted = await this.run({
            cmd: "page.delete",
            snapshot: snapshotId,
            args: {
              nameOrId: pageId,
              changesetId: strArg(args, "changesetId", false),
              preview: previewEnabled,
              apply: applyNow,
              remoteValidate: remoteValidateOnApply,
              note: strArg(args, "note", false),
              title: strArg(args, "title", false) || `Remove page ${currentPageName}`,
              intent: strArg(args, "intent", false) || `Remove page ${currentPageName}`,
              strictSnapshot: true
            }
          });

          const toBaseResult = (extra: Record<string, unknown>) => ({
            snapshotId,
            usedSnapshotId: snapshotId,
            requestedSnapshotId: writeContext.requestedSnapshotId,
            page: {
              pageId,
              name: currentPageName,
              fileKey: resolved.page.fileKey
            },
            preflight,
            ...extra
          });

          const applyArchiveFallback = async (
            fallbackReason: string
          ): Promise<OrbitCommandResult> => {
            const archivePrefix = strArg(args, "archivePrefix", false) || "deprecated_";
            const archivedName = archivePageName(currentPageName, archivePrefix);
            const fallbackChangesetId =
              strArg(args, "changesetId", false) ||
              this.changesets.newChangeset(
                snapshotId,
                strArg(args, "title", false) || `Archive page ${currentPageName}`,
                strArg(args, "intent", false) || `Archive page ${currentPageName} after delete fallback`
              ).changesetId;

            const fallbackActions: string[] = [];
            if (force && preflight.actionReferences.length > 0) {
              for (const ref of preflight.actionReferences) {
                if (!ref.sourceNodeId || !ref.fromPageId) {
                  continue;
                }
                const detachResult = await this.run({
                  cmd: "routes.delete",
                  snapshot: snapshotId,
                  args: {
                    nameOrId: ref.fromPageId,
                    nodeId: ref.sourceNodeId,
                    trigger: ref.trigger || "ON_TAP",
                    changesetId: fallbackChangesetId,
                    preview: false,
                    apply: false,
                    remoteValidate: false,
                    strictSnapshot: true
                  }
                });
                if (detachResult.ok) {
                  fallbackActions.push(`detached route ${ref.fromPageId}:${ref.sourceNodeId}:${ref.trigger || "ON_TAP"}`);
                } else {
                  warnings.push(
                    `Archive fallback could not detach route ${ref.fromPageId}:${ref.sourceNodeId}: ${(detachResult.errors ?? []).join(" | ")}`
                  );
                }
              }
            }

            const renameResult = await this.run({
              cmd: "page.update",
              snapshot: snapshotId,
              args: {
                nameOrId: pageId,
                key: "name",
                value: archivedName,
                changesetId: fallbackChangesetId,
                preview: false,
                apply: false,
                strictSnapshot: true,
                note: strArg(args, "note", false) || "Archive fallback rename"
              }
            });
            if (!renameResult.ok) {
              const renameReason = (renameResult.errors ?? []).join(" | ") || "Archive fallback failed";
              return this.ok(
                parsed.cmd,
                toBaseResult({
                  state: "failed",
                  removed: false,
                  blocked: true,
                  mode: "archive-fallback",
                  errorCode: pageRemoveErrorCodeFromReason(renameReason),
                  reason: renameReason,
                  fallbackUsed: true,
                  fallbackReason,
                  fallbackActions,
                  changesetId: fallbackChangesetId,
                  postCheck: {
                    existsInSnapshot: true,
                    existsRemotely: undefined,
                    nextRefreshRecommended: true
                  },
                  selection: {
                    snapshotId,
                    pageId,
                    nodeId: pageId,
                    fileKey: resolved.page.fileKey
                  }
                }),
                warnings
              );
            }

            const preview = previewEnabled ? this.changesets.preview(fallbackChangesetId) : undefined;
            const validation = applyNow ? this.changesets.validate(fallbackChangesetId) : undefined;
            const applyResult = applyNow
              ? await this.changesets.apply(fallbackChangesetId, true, { remoteValidate: remoteValidateOnApply })
              : undefined;
            const applied = applyNow ? Boolean(applyResult?.applied) : false;
            const state = applyNow ? (applied ? "applied" : "failed") : "staged";
            const reason = !applied && applyNow ? applyResult?.reason || "Archive fallback apply failed" : undefined;

            if (force && preflight.actionReferences.length > 0 && fallbackActions.length > 0) {
              fallbackActions.push(`detached ${fallbackActions.length} incoming route action(s)`);
            }
            fallbackActions.push(`renamed page to '${archivedName}'`);

            return this.ok(
              parsed.cmd,
              toBaseResult({
                state,
                removed: false,
                blocked: !applied && applyNow,
                mode: "archive-fallback",
                errorCode: reason ? pageRemoveErrorCodeFromReason(reason) : undefined,
                reason,
                fallbackUsed: true,
                fallbackReason,
                fallbackActions,
                changesetId: fallbackChangesetId,
                preview,
                validation,
                applyResult,
                postCheck: {
                  existsInSnapshot: true,
                  existsRemotely: applied ? true : undefined,
                  nextRefreshRecommended: applyNow
                },
                selection: {
                  snapshotId,
                  pageId,
                  nodeId: pageId,
                  fileKey: resolved.page.fileKey
                }
              }),
              warnings
            );
          };

          if (!deleted.ok) {
            const combined = (deleted.errors ?? []).join(" | ");
            if (applyNow && isRemoteSchemaRejectedReason(combined)) {
              return applyArchiveFallback(combined || "Hard delete rejected by remote schema");
            }
            return this.ok(
              parsed.cmd,
              toBaseResult({
                state: "failed",
                removed: false,
                blocked: true,
                mode: "hard-delete",
                errorCode: pageRemoveErrorCodeFromReason(combined),
                reason: combined || "Hard delete failed",
                fallbackUsed: false,
                fallbackActions: [],
                postCheck: {
                  existsInSnapshot: true,
                  existsRemotely: undefined,
                  nextRefreshRecommended: applyNow
                },
                suggestedNext: isRateLimitedReason(combined)
                  ? { cmd: "page.remove", args: { nameOrId: pageId, apply: applyNow } }
                  : { cmd: "page.preflightDelete", args: { nameOrId: pageId } },
                selection: {
                  snapshotId,
                  pageId,
                  nodeId: pageId,
                  fileKey: resolved.page.fileKey
                }
              }),
              warnings.concat(deleted.warnings ?? [])
            );
          }

          const data = asObject(deleted.data);
          const applyResultData = asObject(data.applyResult);
          const hardApplySucceeded = applyNow ? applyResultData.applied === true : false;
          const hardApplyReason =
            applyNow && applyResultData.applied !== true
              ? typeof applyResultData.reason === "string"
                ? applyResultData.reason
                : "Hard delete apply failed"
              : "";

          if (applyNow && !hardApplySucceeded && isRemoteSchemaRejectedReason(hardApplyReason)) {
            return applyArchiveFallback(hardApplyReason);
          }

          const state = applyNow ? (hardApplySucceeded ? "applied" : "failed") : "staged";
          return this.ok(
            parsed.cmd,
            toBaseResult({
              state,
              removed: applyNow ? hardApplySucceeded : false,
              blocked: applyNow ? !hardApplySucceeded : false,
              mode: "hard-delete",
              errorCode: !hardApplySucceeded && applyNow ? pageRemoveErrorCodeFromReason(hardApplyReason) : undefined,
              reason: !hardApplySucceeded && applyNow ? hardApplyReason : undefined,
              fallbackUsed: false,
              fallbackActions: [],
              changesetId: data.changesetId,
              preview: data.preview,
              validation: data.validation,
              applyResult: data.applyResult,
              postCheck: {
                existsInSnapshot: !applyNow || !hardApplySucceeded ? true : false,
                existsRemotely: applyNow && hardApplySucceeded ? false : undefined,
                nextRefreshRecommended: applyNow
              },
              selection: {
                snapshotId,
                pageId,
                nodeId: pageId,
                fileKey: resolved.page.fileKey
              }
            }),
            warnings.concat(deleted.warnings ?? [])
          );
        }

        case "page.delete": {
          const writeContext = this.resolveWriteSnapshotContext(parsed, args);
          const snapshotId = writeContext.snapshotId;
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }

          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const pageDisplayName = pickPageDisplayNameFromYaml(resolved.file.yaml) || resolved.page.name || pageId;
          const targetFileKeys = new Set<string>([resolved.file.fileKey]);
          const splitFiles = this.snapshotRepo.listFiles(snapshotId, `page/${pageId}/`, 10_000);
          for (const file of splitFiles) {
            targetFileKeys.add(file.fileKey);
          }

          let rootReplacement = "";
          try {
            const parsedRoot = YAML.parse(resolved.file.yaml);
            if (parsedRoot && typeof parsedRoot === "object" && !Array.isArray(parsedRoot)) {
              const nextRoot = { ...(parsedRoot as Record<string, unknown>) };
              nextRoot.name = nextRoot.name && typeof nextRoot.name === "string"
                ? archivePageName(nextRoot.name, "[deleted] ")
                : archivePageName(pageDisplayName, "[deleted] ");
              rootReplacement = YAML.stringify(nextRoot, { lineWidth: 0 });
            } else {
              rootReplacement = YAML.stringify({ name: archivePageName(pageDisplayName, "[deleted] ") }, { lineWidth: 0 });
            }
          } catch {
            rootReplacement = YAML.stringify({ name: archivePageName(pageDisplayName, "[deleted] ") }, { lineWidth: 0 });
          }

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Delete page ${resolved.page.name}`,
            strArg(args, "intent", false) || `Hard-delete attempt for page ${resolved.page.name}`
          ).changesetId;

          const entries = [...targetFileKeys.values()].flatMap((fileKey) => {
            const file = this.snapshotRepo.getFile(snapshotId, fileKey);
            if (!file) {
              return [];
            }
            return [
              this.changesets.addEntry(
                changesetId,
                file.fileKey,
                {
                  type: "replace-range",
                  start: 0,
                  end: file.yaml.length,
                  replacement: file.fileKey === resolved.file.fileKey ? rootReplacement : ""
                },
                strArg(args, "note", false) ||
                  (file.fileKey === resolved.file.fileKey
                    ? "Hard-delete marker on page root"
                    : "Hard-delete page file (clear content)")
              )
            ];
          });
          if (entries.length === 0) {
            throw new Error(`No page files found to delete for ${pageId}`);
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;
          const deleted = applyNow ? Boolean(applyResult?.applied) : false;
          const state = applyNow ? (deleted ? "applied" : "failed") : "staged";

          return this.ok(parsed.cmd, {
            snapshotId,
            usedSnapshotId: snapshotId,
            requestedSnapshotId: writeContext.requestedSnapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            state,
            deleted,
            mode: "hard-delete",
            changesetId,
            entries,
            targetFileCount: entries.length,
            preview,
            validation,
            applyResult,
            selection: {
              snapshotId,
              pageId,
              nodeId: pageId,
              fileKey: resolved.page.fileKey
            }
          }, writeContext.warnings);
        }

        case "page.clone": {
          const writeContext = this.resolveWriteSnapshotContext(parsed, args);
          const snapshotId = writeContext.snapshotId;
          const query =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!query) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const resolved = this.resolvePage(snapshotId, query);
          if (!resolved) {
            throw new Error(`Page not found: ${query}`);
          }

          const sourcePageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const newPageIdRaw = strArg(args, "newPageId", false);
          const newPageId = newPageIdRaw ? normalizeNodeId(newPageIdRaw) : generatePageId();
          const newName = strArg(args, "newName", false) || `${resolved.page.name}Copy`;
          if (this.resolvePage(snapshotId, newPageId)) {
            throw new Error(`Page already exists: ${newPageId}`);
          }

          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Clone page ${resolved.page.name}`,
            strArg(args, "intent", false) || `Clone page ${resolved.page.name} to ${newName}`
          ).changesetId;

          const sourceFiles = this.snapshotRepo.listFiles(snapshotId, `page/${sourcePageId}`, 10_000);
          if (sourceFiles.length === 0) {
            throw new Error(`No files found for source page ${sourcePageId}`);
          }

          const splitContext = loadSplitTreeContext(this.snapshotRepo, snapshotId, sourcePageId);
          const keyMap = new Map<string, string>();
          keyMap.set(keyFromNodeId(sourcePageId), keyFromNodeId(newPageId));
          const idMap = new Map<string, string>();
          idMap.set(sourcePageId, newPageId);
          for (const oldKey of splitContext.nodeKeys) {
            if (!keyMap.has(oldKey)) {
              const generatedId = defaultNodeIdForType("Widget");
              idMap.set(nodeIdFromKey(oldKey), generatedId);
              keyMap.set(oldKey, keyFromNodeId(generatedId));
            }
          }

          const copiedFiles: string[] = [];
          for (const sourceFile of sourceFiles) {
            let targetFileKey = sourceFile.fileKey.replace(`page/${sourcePageId}`, `page/${newPageId}`);
            const nodeIdInPath = targetFileKey.match(/\/node\/(id-[^/.]+)(?:\.ya?ml)?$/i)?.[1];
            if (nodeIdInPath) {
              const mappedNodeId = idMap.get(nodeIdInPath) || defaultNodeIdForType("Widget");
              idMap.set(nodeIdInPath, mappedNodeId);
              targetFileKey = targetFileKey.replace(nodeIdInPath, mappedNodeId);
            }

            let replacement = sourceFile.yaml;
            try {
              const parsedYaml = YAML.parse(sourceFile.yaml);
              let transformed = replaceKeyRefsDeep(parsedYaml, keyMap);
              if (transformed && typeof transformed === "object" && !Array.isArray(transformed)) {
                const record = transformed as Record<string, unknown>;
                if (/^page\/id-[^/]+(\.ya?ml)?$/i.test(sourceFile.fileKey)) {
                  record.name = newName;
                  if (record.node && typeof record.node === "object" && !Array.isArray(record.node)) {
                    (record.node as Record<string, unknown>).key = keyFromNodeId(newPageId);
                  }
                }
              }
              replacement = YAML.stringify(transformed, { lineWidth: 0 });
            } catch {
              // preserve source yaml when parse fails
            }

            this.changesets.addEntry(changesetId, targetFileKey, {
              type: "replace-range",
              start: 0,
              end: 0,
              replacement
            }, "Clone page file");
            copiedFiles.push(targetFileKey);
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            requestedSnapshotId: writeContext.requestedSnapshotId,
            sourcePageId,
            newPageId,
            newName,
            copiedFilesCount: copiedFiles.length,
            copiedFiles,
            changesetId,
            preview,
            validation,
            applyResult
          }, writeContext.warnings);
        }

        case "component.get": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const snapshot = this.requireSnapshot(snapshotId);
          const query =
            strArg(args, "nameOrId", false) ||
            strArg(args, "componentId", false) ||
            strArg(args, "id", false);
          if (!query) {
            throw new Error("Missing string arg: nameOrId (aliases: componentId, id)");
          }
          const found = this.indexRepo.findSymbols(snapshotId, "component", query)[0];
          if (!found) {
            throw new Error(`Component not found: ${query}`);
          }

          return this.ok(parsed.cmd, {
            component: found,
            usedBy: this.indexRepo.listIncomingEdges(snapshotId, "usage", found.symbolId),
            uses: this.indexRepo.listOutgoingEdges(snapshotId, "usage", found.symbolId),
            file: found.fileKey,
            nodePath: found.nodePath
          }, this.snapshotWarnings(snapshot));
        }

        case "component.instance.insert": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const componentQuery =
            strArg(args, "componentNameOrId", false) ||
            strArg(args, "componentId", false) ||
            strArg(args, "componentName", false);
          if (!componentQuery) {
            throw new Error("Missing component selector: componentNameOrId/componentId/componentName");
          }
          const component = this.resolveComponent(snapshotId, componentQuery);
          if (!component) {
            throw new Error(`Component not found: ${componentQuery}`);
          }
          const props = asObject(args.props);
          const componentInstanceProps = {
            componentRef: {
              componentId: component.componentId,
              componentName: component.name
            },
            ...props
          };
          return await this.run({
            cmd: "widget.insert",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              type: "ComponentInstance",
              nodeId: strArg(args, "nodeId", false),
              name: strArg(args, "name", false) || component.name,
              props: componentInstanceProps,
              parentNodeId: strArg(args, "parentNodeId", false),
              beforeNodeId: strArg(args, "beforeNodeId", false),
              afterNodeId: strArg(args, "afterNodeId", false),
              index: Object.prototype.hasOwnProperty.call(args, "index") ? numArg(args, "index", 0) : undefined,
              changesetId: strArg(args, "changesetId", false),
              title: strArg(args, "title", false),
              intent: strArg(args, "intent", false),
              preview: boolArg(args, "preview", true),
              apply: boolArg(args, "apply", false),
              remoteValidate: boolArg(args, "remoteValidate", false)
            }
          });
        }

        case "component.extractFromWidget": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId");
          const componentName = strArg(args, "componentName");
          const replaceOriginal = boolArg(args, "replaceOriginal", true);
          const parameterizeText = boolArg(args, "parameterizeText", true);
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);

          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitContext = loadSplitTreeContext(this.snapshotRepo, snapshotId, pageId);
          const rootKey = keyFromNodeId(nodeId);
          const rootPath = svcFindNodePathByKey(splitContext.tree, rootKey);
          if (!rootPath) {
            throw new Error(`Widget node not found in page widget tree: ${nodeId}`);
          }
          const subtreeNode = cloneTreeNode(getAtPath(splitContext.tree, rootPath));
          const subtreeKeys = [...svcCollectWidgetTreeKeys(subtreeNode)];
          const componentId = normalizeNodeId(strArg(args, "componentId", false) || `id-Component_${orbitId("cmp").slice(-8)}`);
          const componentRootFileKey = `component/${componentId}.yaml`;
          const componentTreeFileKey = `component/${componentId}/component-widget-tree-outline.yaml`;

          const keyMap = new Map<string, string>();
          for (const key of subtreeKeys) {
            keyMap.set(key, keyFromNodeId(defaultNodeIdForType("Widget")));
          }

          const componentTreeNode = replaceKeyRefsDeep(subtreeNode, keyMap);
          const componentTreeYaml = YAML.stringify({ node: componentTreeNode }, { lineWidth: 0 });

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Extract component ${componentName}`,
            strArg(args, "intent", false) || `Extract ${nodeId} to component ${componentName}`
          ).changesetId;
          const componentRootYaml = YAML.stringify({
            name: componentName,
            description: "",
            node: { key: keyFromNodeId(componentId), classModel: {} }
          }, { lineWidth: 0 });
          this.changesets.addEntry(changesetId, componentRootFileKey, {
            type: "replace-range",
            start: 0,
            end: 0,
            replacement: componentRootYaml
          }, "Create component root");
          this.changesets.addEntry(changesetId, componentTreeFileKey, {
            type: "replace-range",
            start: 0,
            end: 0,
            replacement: componentTreeYaml
          }, "Create component tree");

          const componentFileKeys: string[] = [componentRootFileKey, componentTreeFileKey];
          for (const key of subtreeKeys) {
            const nodeFile = splitContext.nodeFileByKey.get(key);
            if (!nodeFile) {
              continue;
            }
            const mappedKey = keyMap.get(key) ?? key;
            const mappedNodeId = nodeIdFromKey(mappedKey);
            const fileKey = `component/${componentId}/component-widget-tree-outline/node/${mappedNodeId}.yaml`;
            let replacement = nodeFile.yaml;
            try {
              let transformed = replaceKeyRefsDeep(YAML.parse(nodeFile.yaml), keyMap);
              if (parameterizeText && transformed && typeof transformed === "object" && !Array.isArray(transformed)) {
                const row = transformed as Record<string, unknown>;
                const textValue = getAtPath(row, selectorToPath("$.props.text.textValue.inputValue"));
                if (typeof textValue === "string" && textValue.trim()) {
                  row.params = {
                    text: { type: "string", defaultValue: textValue }
                  };
                }
              }
              replacement = YAML.stringify(transformed, { lineWidth: 0 });
            } catch {
              // keep original yaml
            }
            this.changesets.addEntry(changesetId, fileKey, {
              type: "replace-range",
              start: 0,
              end: 0,
              replacement
            }, "Create component node file");
            componentFileKeys.push(fileKey);
          }

          let replacedNodeId: string | undefined;
          if (replaceOriginal) {
            const slot = svcFindParentChildrenSlotByKey(splitContext.tree, rootKey);
            if (!slot) {
              throw new Error(`Widget node not found in page widget tree: ${nodeId}`);
            }
            const siblings = getAtPath(splitContext.tree, slot.childrenPath);
            if (!Array.isArray(siblings)) {
              throw new Error("Unable to resolve siblings for replacement");
            }
            replacedNodeId = defaultNodeIdForType("ComponentInstance");
            siblings.splice(slot.index, 1, { key: keyFromNodeId(replacedNodeId) });
            this.changesets.addEntry(changesetId, splitContext.treeFileKey, {
              type: "replace-range",
              start: 0,
              end: splitContext.treeFileYaml.length,
              replacement: YAML.stringify(splitContext.tree, { lineWidth: 0 })
            }, "Replace subtree with component instance in page tree");
            const instanceNodeYaml = YAML.stringify({
              key: keyFromNodeId(replacedNodeId),
              type: "ComponentInstance",
              name: componentName,
              props: {
                componentRef: {
                  componentId,
                  componentName
                }
              },
              parameterValues: {}
            }, { lineWidth: 0 });
            const instanceFileKey = `page/${pageId}/page-widget-tree-outline/node/${replacedNodeId}.yaml`;
            this.changesets.addEntry(changesetId, instanceFileKey, {
              type: "replace-range",
              start: 0,
              end: 0,
              replacement: instanceNodeYaml
            }, "Create page component instance node file");
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;
          return this.ok(parsed.cmd, {
            snapshotId,
            componentId,
            componentName,
            componentFileKeys,
            replacedNodeId,
            changesetId,
            preview,
            validation,
            applyResult
          });
        }

        case "graph.nav": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const query = strArg(args, "targetPageNameOrId");
          const depth = numArg(args, "depth", 2);
          const page = this.indexRepo.findSymbols(snapshotId, "page", query)[0];
          if (!page) {
            throw new Error(`Page not found: ${query}`);
          }

          return this.ok(parsed.cmd, walkGraph(this.indexRepo, snapshotId, page.symbolId, "nav", depth));
        }

        case "graph.usage": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const query = strArg(args, "targetComponentNameOrId");
          const depth = numArg(args, "depth", 2);
          const component = this.indexRepo.findSymbols(snapshotId, "component", query)[0];
          if (!component) {
            throw new Error(`Component not found: ${query}`);
          }

          return this.ok(parsed.cmd, walkGraph(this.indexRepo, snapshotId, component.symbolId, "usage", depth));
        }

        case "pages.list": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const snapshot = this.requireSnapshot(snapshotId);
          const query = (strArg(args, "q", false) || strArg(args, "query", false)).toLowerCase();
          const limit = Math.max(1, Math.min(numArg(args, "limit", 200), 1000));
          const offset = Math.max(0, numArg(args, "offset", 0));
          const includeFileKeys = boolArg(args, "includeFileKeys", false);
          const includeDeleted = boolArg(args, "includeDeleted", false);
          const strictSnapshot = boolArg(args, "strictSnapshot", false);
          let selectedSnapshot = snapshot;
          let selectedSnapshotId = snapshotId;
          let warnings = this.snapshotWarnings(snapshot);
          const requestedResult = collectPagesForSnapshot(this.snapshotRepo, this.indexRepo, snapshotId, includeFileKeys, includeDeleted);
          let selectedResult = requestedResult;

          if (!strictSnapshot) {
            const candidates = this.snapshotRepo
              .listSnapshots()
              .filter((entry) => entry.projectId === snapshot.projectId && entry.snapshotId !== snapshotId);
            for (const candidate of candidates) {
              const candidateResult = collectPagesForSnapshot(
                this.snapshotRepo,
                this.indexRepo,
                candidate.snapshotId,
                includeFileKeys,
                includeDeleted
              );
              if (candidateResult.pages.length > selectedResult.pages.length) {
                selectedResult = candidateResult;
                selectedSnapshot = candidate;
                selectedSnapshotId = candidate.snapshotId;
              }
            }
            if (selectedSnapshotId !== snapshotId) {
              warnings = [
                ...warnings,
                `Requested snapshot ${snapshotId} appears incomplete (${requestedResult.pages.length} page(s)); using fuller snapshot ${selectedSnapshotId} (${selectedResult.pages.length} page(s)).`
              ];
            }
          }

          let source: string = selectedResult.source;
          if (selectedResult.source === "file-key-fallback") {
            warnings = [...warnings, "Page symbols are empty; using file-key fallback from snapshot files."];
          } else if (selectedResult.source === "index+file-key-fallback") {
            warnings = [
              ...warnings,
              `Page index was partial (${selectedResult.indexedCount}); merged ${selectedResult.pages.length - selectedResult.indexedCount} page(s) from snapshot files.`
            ];
          }
          if (selectedSnapshotId !== snapshotId) {
            source = `${source}+best-snapshot-fallback`;
          }

          const pages = selectedResult.pages;

          const filtered = query
            ? pages.filter((page) => {
                const haystack = `${page.pageId} ${page.name} ${page.fileKey ?? ""} ${page.symbolId ?? ""}`.toLowerCase();
                return haystack.includes(query);
              })
            : pages;

          const totalPages = filtered.length;
          const sliced = filtered.slice(offset, offset + limit);
          return this.ok(parsed.cmd, {
            snapshotId: selectedSnapshotId,
            requestedSnapshotId: selectedSnapshotId === snapshotId ? undefined : snapshotId,
            projectId: selectedSnapshot.projectId,
            source,
            totalPages,
            limit,
            offset,
            pages: sliced
          }, warnings);
        }

        case "widgets.list": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const query =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!query) {
            throw new Error("Missing string arg: nameOrId (aliases: pageId, id, fileKey)");
          }
          const resolved = this.resolvePage(snapshotId, query);
          if (!resolved) {
            throw new Error(`Page not found: ${query}`);
          }
          const q = (strArg(args, "q", false) || strArg(args, "query", false)).toLowerCase();
          const typeFilter = (strArg(args, "type", false) || strArg(args, "widgetType", false)).toLowerCase();
          const include = stringListArg(args, "include");
          const includeNode = boolArg(args, "includeNode", false);
          const limit = Math.max(1, Math.min(numArg(args, "limit", 200), 1000));
          const offset = Math.max(0, numArg(args, "offset", 0));
          const rows: Array<Record<string, unknown>> = [];
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitNodeFiles = this.snapshotRepo.listFiles(
            snapshotId,
            `page/${pageId}/page-widget-tree-outline/node/`,
            10_000
          );
          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          let allowedTreeKeys = new Set<string>();
          if (treeFile) {
            try {
              const parsedTree = YAML.parse(treeFile.yaml);
              allowedTreeKeys = collectWidgetTreeKeys(parsedTree);
            } catch {
              allowedTreeKeys = new Set<string>();
            }
          }

          if (splitNodeFiles.length > 0) {
            for (const file of splitNodeFiles) {
              if (!/\/node\/id-[^/]+(\.ya?ml)?$/i.test(file.fileKey)) {
                continue;
              }
              const quickTypeMatch = file.yaml.match(/^\s*type:\s*([A-Za-z0-9_]+)/m);
              const quickType = quickTypeMatch?.[1];
              if (typeFilter && quickType && quickType.toLowerCase() !== typeFilter) {
                continue;
              }
              let parsedNode: unknown;
              try {
                parsedNode = YAML.parse(file.yaml);
              } catch {
                continue;
              }
              if (!parsedNode || typeof parsedNode !== "object" || Array.isArray(parsedNode)) {
                continue;
              }
              const node = parsedNode as Record<string, unknown>;
              const match = file.fileKey.match(/\/node\/(id-[^/.]+)(?:\.ya?ml)?$/i);
              const nodeId = match?.[1];
              if (nodeId && allowedTreeKeys.size > 0 && !allowedTreeKeys.has(keyFromNodeId(nodeId))) {
                continue;
              }
              const type = typeof node.type === "string" ? node.type : undefined;
              if (typeFilter && (!type || type.toLowerCase() !== typeFilter)) {
                continue;
              }
              const name = typeof node.name === "string" ? node.name : undefined;
              const selector = "$";
              const haystack = `${nodeId ?? ""} ${type ?? ""} ${name ?? ""} ${file.fileKey}`.toLowerCase();
                if (!q || haystack.includes(q)) {
                  const row: Record<string, unknown> = { nodeId, type, name, selector, fileKey: file.fileKey };
                  if (nodeId) {
                    row.selection = { pageId, nodeId, fileKey: file.fileKey };
                  }
                  if (include.length > 0) {
                    row.display = extractWidgetDisplay(node, type, include);
                  }
                if (includeNode) {
                  row.node = node;
                }
                rows.push(row);
              }
            }
          } else {
            const parsedYaml = YAML.parse(resolved.file.yaml);
            const walk = (node: unknown, path: Array<string | number>): void => {
              if (node === null || node === undefined) {
                return;
              }
              if (Array.isArray(node)) {
                node.forEach((entry, index) => walk(entry, [...path, index]));
                return;
              }
              if (typeof node !== "object") {
                return;
              }

              const row = node as Record<string, unknown>;
              const nodeId = typeof row.id === "string" ? row.id : undefined;
              const type = typeof row.type === "string" ? row.type : undefined;
              const name = typeof row.name === "string" ? row.name : undefined;
              if (typeFilter && (!type || type.toLowerCase() !== typeFilter)) {
                for (const [key, value] of Object.entries(row)) {
                  if (value !== null && typeof value === "object") {
                    walk(value, [...path, key]);
                  }
                }
                return;
              }
              if (nodeId || type) {
                const selector = selectorFromPath(path);
                const haystack = `${nodeId ?? ""} ${type ?? ""} ${name ?? ""} ${selector}`.toLowerCase();
                if (!q || haystack.includes(q)) {
                  const nextRow: Record<string, unknown> = {
                    nodeId,
                    type,
                    name,
                    selector,
                    fileKey: resolved.file.fileKey
                  };
                  if (nodeId) {
                    nextRow.selection = { pageId, nodeId, fileKey: resolved.file.fileKey };
                  }
                  if (include.length > 0) {
                    nextRow.display = extractWidgetDisplay(row, type, include);
                  }
                  if (includeNode) {
                    nextRow.node = row;
                  }
                  rows.push(nextRow);
                }
              }

              for (const [key, value] of Object.entries(row)) {
                if (value !== null && typeof value === "object") {
                  walk(value, [...path, key]);
                }
              }
            };

            walk(parsedYaml, []);
          }
          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            totalWidgets: rows.length,
            limit,
            offset,
            widgets: rows.slice(offset, offset + limit)
          });
        }

        case "widgets.find": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing string arg: nameOrId (aliases: pageId, id, fileKey)");
          }

          const includeNode = boolArg(args, "includeNode", false);
          const limit = Math.max(1, Math.min(numArg(args, "limit", 200), 1000));
          const offset = Math.max(0, numArg(args, "offset", 0));
          const q = strArg(args, "q", false) || strArg(args, "query", false);
          const type = strArg(args, "type", false);
          const types = stringListArg(args, "types");
          const include = stringListArg(args, "include");
          const nameContains = strArg(args, "nameContains", false).toLowerCase();
          const textContains = strArg(args, "textContains", false).toLowerCase();

          const baseList = await this.run({
            cmd: "widgets.list",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              q,
              type,
              include,
              includeNode: true,
              limit: 10_000,
              offset: 0
            }
          });
          if (!baseList.ok) {
            return baseList;
          }
          const data = asObject(baseList.data);
          const rawWidgets = Array.isArray(data.widgets) ? data.widgets : [];
          const typeSet = new Set(
            types.map((entry) => entry.toLowerCase()).filter((entry) => entry.length > 0)
          );
          if (type && !typeSet.has(type.toLowerCase())) {
            typeSet.add(type.toLowerCase());
          }

          const filtered: Array<Record<string, unknown>> = [];
          for (const entry of rawWidgets) {
            const row = asObject(entry);
            const node = asObject(row.node);
            const rowType = typeof row.type === "string" ? row.type : "";
            if (typeSet.size > 0 && (!rowType || !typeSet.has(rowType.toLowerCase()))) {
              continue;
            }
            const rowName = typeof row.name === "string" ? row.name : "";
            if (nameContains && !rowName.toLowerCase().includes(nameContains)) {
              continue;
            }
            if (textContains) {
              const nodeType = typeof row.type === "string" ? row.type : undefined;
              const candidates = textCandidatesForWidget(node, nodeType);
              const textMatch = candidates.some((candidate) => candidate.value.toLowerCase().includes(textContains));
              if (!textMatch) {
                continue;
              }
            }
            if (!includeNode && Object.prototype.hasOwnProperty.call(row, "node")) {
              const next = { ...row };
              delete next.node;
              filtered.push(next);
            } else {
              filtered.push(row);
            }
          }

          return this.ok(parsed.cmd, {
            snapshotId: data.snapshotId ?? snapshotId,
            page: data.page,
            totalMatches: filtered.length,
            limit,
            offset,
            widgets: filtered.slice(offset, offset + limit)
          }, baseList.warnings ?? []);
        }

        case "widget.getMany": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing string arg: nameOrId (aliases: pageId, id, fileKey)");
          }

          const nodeIds = stringListArg(args, "nodeIds");
          const filter = parseWidgetFilterSpec(args.filter);
          if (nodeIds.length === 0 && Object.keys(filter).length === 0) {
            throw new Error("Provide nodeIds or filter for widget.getMany");
          }

          const includeNode = boolArg(args, "includeNode", false);
          const include = stringListArg(args, "include");
          const limit = Math.max(1, Math.min(numArg(args, "limit", 200), 1000));
          const offset = Math.max(0, numArg(args, "offset", 0));

          let rows: Array<Record<string, unknown>> = [];
          let page: Record<string, unknown> = {};
          let warnings: string[] = [];

          if (nodeIds.length > 0) {
            const listed = await this.run({
              cmd: "widgets.list",
              snapshot: snapshotId,
              args: {
                nameOrId: pageQuery,
                include,
                includeNode: true,
                limit: 10_000,
                offset: 0
              }
            });
            if (!listed.ok) {
              return listed;
            }
            const listedData = asObject(listed.data);
            page = asObject(listedData.page);
            warnings = listed.warnings ?? [];
            const mapById = new Map<string, Record<string, unknown>>();
            const listedRows = Array.isArray(listedData.widgets) ? listedData.widgets : [];
            for (const entry of listedRows) {
              const row = asObject(entry);
              const nodeId = typeof row.nodeId === "string" ? row.nodeId : "";
              if (nodeId) {
                mapById.set(nodeId, row);
              }
            }
            const ordered = nodeIds
              .map((nodeId) => mapById.get(nodeId))
              .filter((row): row is Record<string, unknown> => Boolean(row));
            const missingNodeIds = nodeIds.filter((nodeId) => !mapById.has(nodeId));
            rows = includeNode
              ? ordered
              : ordered.map((row) => {
                  const next = { ...row };
                  delete next.node;
                  return next;
                });

            const result: WidgetManyResult = {
              snapshotId,
              page: {
                pageId: typeof page.pageId === "string" ? page.pageId : "",
                name: typeof page.name === "string" ? page.name : "",
                fileKey: typeof page.fileKey === "string" ? page.fileKey : ""
              },
              totalRequested: nodeIds.length,
              totalFound: ordered.length,
              missingNodeIds,
              widgets: rows.slice(offset, offset + limit)
            };
            return this.ok(parsed.cmd, result, warnings);
          }

          const found = await this.run({
            cmd: "widgets.find",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              type: filter.type,
              nameContains: filter.nameContains,
              textContains: filter.textContains,
              include,
              includeNode: true,
              limit: 10_000,
              offset: 0
            }
          });
          if (!found.ok) {
            return found;
          }
          const foundData = asObject(found.data);
          page = asObject(foundData.page);
          warnings = found.warnings ?? [];
          const foundRows = Array.isArray(foundData.widgets) ? foundData.widgets : [];
          const filtered = foundRows
            .map((entry) => asObject(entry))
            .filter((row) => matchesWidgetFilter(
              asObject(row.node),
              typeof row.nodeId === "string" ? row.nodeId : undefined,
              typeof row.type === "string" ? row.type : undefined,
              filter
            ));
          rows = includeNode
            ? filtered
            : filtered.map((row) => {
                const next = { ...row };
                delete next.node;
                return next;
              });
          const result: WidgetManyResult = {
            snapshotId,
            page: {
              pageId: typeof page.pageId === "string" ? page.pageId : "",
              name: typeof page.name === "string" ? page.name : "",
              fileKey: typeof page.fileKey === "string" ? page.fileKey : ""
            },
            totalRequested: filtered.length,
            totalFound: filtered.length,
            missingNodeIds: [],
            widgets: rows.slice(offset, offset + limit)
          };
          return this.ok(parsed.cmd, result, warnings);
        }

        case "textfields.list": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing string arg: nameOrId (aliases: pageId, id, fileKey)");
          }
          const include = stringListArg(args, "include");
          const effectiveInclude = include.length > 0
            ? include
            : ["name", "label", "passwordField", "hintText", "initialValue"];
          const nested = await this.run({
            cmd: "widgets.list",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              q: strArg(args, "q", false),
              limit: numArg(args, "limit", 200),
              offset: numArg(args, "offset", 0),
              type: "TextField",
              include: effectiveInclude,
              includeNode: boolArg(args, "includeNode", false)
            }
          });
          if (!nested.ok) {
            return nested;
          }

          const data = asObject(nested.data);
          const widgets = Array.isArray(data.widgets) ? data.widgets : [];
          const textFields = widgets.map((entry) => {
            const row = asObject(entry);
            const display = asObject(row.display);
            return {
              nodeId: typeof row.nodeId === "string" ? row.nodeId : undefined,
              name: typeof row.name === "string" ? row.name : (typeof display.name === "string" ? display.name : undefined),
              label: typeof display.label === "string" ? display.label : undefined,
              passwordField: typeof display.passwordField === "boolean" ? display.passwordField : undefined,
              hintText: typeof display.hintText === "string" ? display.hintText : undefined,
              initialValue: typeof display.initialValue === "string" ? display.initialValue : undefined,
              selector: typeof row.selector === "string" ? row.selector : undefined,
              fileKey: typeof row.fileKey === "string" ? row.fileKey : undefined,
              ...(row.node ? { node: row.node } : {})
            };
          });

          return this.ok(parsed.cmd, {
            snapshotId: data.snapshotId ?? snapshotId,
            page: data.page,
            totalTextFields: textFields.length,
            limit: data.limit,
            offset: data.offset,
            textFields
          }, nested.warnings ?? []);
        }

        case "widgets.findText": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing string arg: nameOrId (aliases: pageId, id, fileKey)");
          }
          const textQuery =
            strArg(args, "text", false) ||
            strArg(args, "q", false) ||
            strArg(args, "query", false);
          if (!textQuery) {
            throw new Error("Missing string arg: text (aliases: q, query)");
          }
          const exact = boolArg(args, "exact", false);
          const limit = Math.max(1, Math.min(numArg(args, "limit", 200), 1000));
          const offset = Math.max(0, numArg(args, "offset", 0));
          const typeFilters = new Set<string>([
            ...(strArg(args, "type", false) ? [strArg(args, "type", false).toLowerCase()] : []),
            ...stringListArg(args, "types").map((entry) => entry.toLowerCase())
          ]);
          const textQueryLower = textQuery.toLowerCase();

          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const rows: Array<Record<string, unknown>> = [];
          const splitNodeFiles = this.snapshotRepo.listFiles(
            snapshotId,
            `page/${pageId}/page-widget-tree-outline/node/`,
            10_000
          );
          if (splitNodeFiles.length > 0) {
            for (const file of splitNodeFiles) {
              if (!/\/node\/id-[^/]+(\.ya?ml)?$/i.test(file.fileKey)) {
                continue;
              }
              if (!exact && !file.yaml.toLowerCase().includes(textQueryLower)) {
                continue;
              }
              let parsedNode: unknown;
              try {
                parsedNode = YAML.parse(file.yaml);
              } catch {
                continue;
              }
              if (!parsedNode || typeof parsedNode !== "object" || Array.isArray(parsedNode)) {
                continue;
              }
              const node = parsedNode as Record<string, unknown>;
              const nodeId = file.fileKey.match(/\/node\/(id-[^/.]+)(?:\.ya?ml)?$/i)?.[1];
              const type = typeof node.type === "string" ? node.type : undefined;
              const typeLower = type?.toLowerCase();
              if (typeFilters.size > 0 && (!typeLower || !typeFilters.has(typeLower))) {
                continue;
              }
              const name = typeof node.name === "string" ? node.name : undefined;
              const candidates = textCandidatesForWidget(node, type).filter((candidate) =>
                exact
                  ? candidate.value === textQuery
                  : candidate.value.toLowerCase().includes(textQueryLower)
              );
              if (candidates.length === 0) {
                continue;
              }
              rows.push({
                nodeId,
                type,
                name,
                selector: "$",
                fileKey: file.fileKey,
                matches: candidates,
                selection: nodeId ? { pageId, nodeId, fileKey: file.fileKey } : undefined
              });
            }
          } else {
            let parsedYaml: unknown;
            try {
              parsedYaml = YAML.parse(resolved.file.yaml);
            } catch {
              parsedYaml = undefined;
            }
            const walk = (node: unknown, path: Array<string | number>): void => {
              if (node === null || node === undefined) {
                return;
              }
              if (Array.isArray(node)) {
                node.forEach((entry, index) => walk(entry, [...path, index]));
                return;
              }
              if (typeof node !== "object") {
                return;
              }
              const row = node as Record<string, unknown>;
              const nodeId = typeof row.id === "string" ? row.id : undefined;
              const type = typeof row.type === "string" ? row.type : undefined;
              const typeLower = type?.toLowerCase();
              if (typeFilters.size > 0 && (!typeLower || !typeFilters.has(typeLower))) {
                for (const [key, value] of Object.entries(row)) {
                  if (value !== null && typeof value === "object") {
                    walk(value, [...path, key]);
                  }
                }
                return;
              }
              const candidates = textCandidatesForWidget(row, type).filter((candidate) =>
                exact
                  ? candidate.value === textQuery
                  : candidate.value.toLowerCase().includes(textQueryLower)
              );
              if (candidates.length > 0) {
                rows.push({
                  nodeId,
                  type,
                  name: typeof row.name === "string" ? row.name : undefined,
                  selector: selectorFromPath(path),
                  fileKey: resolved.file.fileKey,
                  matches: candidates,
                  selection: nodeId ? { pageId, nodeId, fileKey: resolved.file.fileKey } : undefined
                });
              }
              for (const [key, value] of Object.entries(row)) {
                if (value !== null && typeof value === "object") {
                  walk(value, [...path, key]);
                }
              }
            };
            walk(parsedYaml, []);
          }

          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            query: textQuery,
            exact,
            totalMatches: rows.length,
            limit,
            offset,
            matches: rows.slice(offset, offset + limit)
          });
        }

        case "tree.locate": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId");
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;

          const splitNodeFiles = this.snapshotRepo.listFiles(
            snapshotId,
            `page/${pageId}/page-widget-tree-outline/node/`,
            10_000
          );
          const nodeMetaByKey = new Map<string, { nodeId: string; type?: string; name?: string; fileKey: string }>();
          for (const file of splitNodeFiles) {
            const nodeIdMatch = file.fileKey.match(/\/node\/(id-[^/.]+)(?:\.ya?ml)?$/i)?.[1];
            if (!nodeIdMatch) {
              continue;
            }
            let parsedNode: unknown;
            try {
              parsedNode = YAML.parse(file.yaml);
            } catch {
              parsedNode = undefined;
            }
            const parsedObject = parsedNode && typeof parsedNode === "object" && !Array.isArray(parsedNode)
              ? (parsedNode as Record<string, unknown>)
              : {};
            nodeMetaByKey.set(keyFromNodeId(nodeIdMatch), {
              nodeId: nodeIdMatch,
              type: typeof parsedObject.type === "string" ? parsedObject.type : undefined,
              name: typeof parsedObject.name === "string" ? parsedObject.name : undefined,
              fileKey: file.fileKey
            });
          }

          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          if (treeFile) {
            const treeYaml = YAML.parse(treeFile.yaml);
            const targetKey = keyFromNodeId(nodeId);
            const targetPath = findNodePathByKey(treeYaml, targetKey);
            if (!targetPath) {
              throw new Error(`Widget node not found in page widget tree: ${nodeId}`);
            }
            const slot = findParentChildrenSlotByKey(treeYaml, targetKey);
            const siblings: Array<Record<string, unknown>> = [];
            let parentInfo: Record<string, unknown> | undefined;
            if (slot) {
              const siblingsRaw = getAtPath(treeYaml, slot.childrenPath);
              const parentPath = slot.childrenPath.slice(0, -1);
              const parentNode = getAtPath(treeYaml, parentPath);
              const parentKey = parentNode && typeof parentNode === "object" && !Array.isArray(parentNode)
                ? (parentNode as Record<string, unknown>).key
                : undefined;
              parentInfo = {
                nodeId: typeof parentKey === "string" ? nodeIdFromKey(parentKey) : undefined,
                key: typeof parentKey === "string" ? parentKey : undefined,
                selector: selectorFromPath(parentPath),
                index: slot.index
              };
              if (Array.isArray(siblingsRaw)) {
                for (let index = 0; index < siblingsRaw.length; index += 1) {
                  const entry = siblingsRaw[index];
                  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                    continue;
                  }
                  const key = (entry as Record<string, unknown>).key;
                  if (typeof key !== "string") {
                    continue;
                  }
                  const meta = nodeMetaByKey.get(key);
                  siblings.push({
                    index,
                    nodeId: nodeIdFromKey(key),
                    key,
                    type: meta?.type,
                    name: meta?.name,
                    fileKey: meta?.fileKey,
                    isTarget: index === slot.index
                  });
                }
              }
            }

            const targetMeta = nodeMetaByKey.get(targetKey);
            return this.ok(parsed.cmd, {
              snapshotId,
              page: {
                pageId,
                name: resolved.page.name,
                fileKey: resolved.page.fileKey
              },
              node: {
                nodeId,
                key: targetKey,
                type: targetMeta?.type,
                name: targetMeta?.name,
                fileKey: targetMeta?.fileKey,
                selector: selectorFromPath(targetPath)
              },
              parent: parentInfo,
              siblings,
              treeFileKey: treeFile.fileKey,
              selection: {
                pageId,
                nodeId,
                fileKey: targetMeta?.fileKey ?? treeFile.fileKey
              }
            });
          }

          const parsedYaml = YAML.parse(resolved.file.yaml);
          const nodePath = findNodePathById(parsedYaml, nodeId);
          if (!nodePath) {
            throw new Error(`Widget node not found: ${nodeId}`);
          }
          const parentPath = nodePath.slice(0, -1);
          const leaf = nodePath[nodePath.length - 1];
          const parent = getAtPath(parsedYaml, parentPath);
          const siblings: Array<Record<string, unknown>> = [];
          if (Array.isArray(parent)) {
            for (let index = 0; index < parent.length; index += 1) {
              const entry = parent[index];
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                continue;
              }
              const row = entry as Record<string, unknown>;
              const siblingNodeId = typeof row.id === "string" ? row.id : undefined;
              siblings.push({
                index,
                nodeId: siblingNodeId,
                type: typeof row.type === "string" ? row.type : undefined,
                name: typeof row.name === "string" ? row.name : undefined,
                selector: selectorFromPath([...parentPath, index]),
                isTarget: typeof leaf === "number" ? leaf === index : false
              });
            }
          }
          const node = getAtPath(parsedYaml, nodePath);
          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            node: {
              nodeId,
              selector: selectorFromPath(nodePath),
              type: node && typeof node === "object" && !Array.isArray(node) && typeof (node as Record<string, unknown>).type === "string"
                ? (node as Record<string, unknown>).type
                : undefined,
              name: node && typeof node === "object" && !Array.isArray(node) && typeof (node as Record<string, unknown>).name === "string"
                ? (node as Record<string, unknown>).name
                : undefined,
              fileKey: resolved.file.fileKey
            },
            parent: parentPath.length > 0
              ? {
                  selector: selectorFromPath(parentPath),
                  index: typeof leaf === "number" ? leaf : undefined
                }
              : undefined,
            siblings,
            selection: {
              pageId,
              nodeId,
              fileKey: resolved.file.fileKey
            }
          });
        }

        case "tree.subtree": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false);
          const depth = Math.max(0, Math.min(numArg(args, "depth", 2), 8));
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitNodeFiles = this.snapshotRepo.listFiles(
            snapshotId,
            `page/${pageId}/page-widget-tree-outline/node/`,
            10_000
          );

          const nodeMetaByKey = new Map<string, { nodeId: string; type?: string; name?: string; fileKey: string }>();
          for (const file of splitNodeFiles) {
            const nodeIdMatch = file.fileKey.match(/\/node\/(id-[^/.]+)(?:\.ya?ml)?$/i)?.[1];
            if (!nodeIdMatch) {
              continue;
            }
            let parsedNode: unknown;
            try {
              parsedNode = YAML.parse(file.yaml);
            } catch {
              parsedNode = undefined;
            }
            const parsedObject = parsedNode && typeof parsedNode === "object" && !Array.isArray(parsedNode)
              ? (parsedNode as Record<string, unknown>)
              : {};
            nodeMetaByKey.set(keyFromNodeId(nodeIdMatch), {
              nodeId: nodeIdMatch,
              type: typeof parsedObject.type === "string" ? parsedObject.type : undefined,
              name: typeof parsedObject.name === "string" ? parsedObject.name : undefined,
              fileKey: file.fileKey
            });
          }

          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          if (treeFile) {
            const treeYaml = YAML.parse(treeFile.yaml);
            const rootKey = nodeId ? keyFromNodeId(nodeId) : keyFromNodeId(pageId);
            const rootPath = findNodePathByKey(treeYaml, rootKey);
            if (!rootPath) {
              throw new Error(`Widget node not found in page widget tree: ${nodeId || pageId}`);
            }
            const subtreeNode = getAtPath(treeYaml, rootPath);

            const formatTreeNode = (entry: unknown, currentDepth: number): Record<string, unknown> | undefined => {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return undefined;
              }
              const row = entry as Record<string, unknown>;
              const key = typeof row.key === "string" ? row.key : undefined;
              const meta = key ? nodeMetaByKey.get(key) : undefined;
              const rawChildren = Array.isArray(row.children) ? row.children : [];
              const result: Record<string, unknown> = {
                nodeId: key ? nodeIdFromKey(key) : undefined,
                key,
                type: meta?.type,
                name: meta?.name,
                fileKey: meta?.fileKey,
                childrenCount: rawChildren.length
              };
              if (currentDepth < depth && rawChildren.length > 0) {
                result.children = rawChildren
                  .map((child) => formatTreeNode(child, currentDepth + 1))
                  .filter((child): child is Record<string, unknown> => !!child);
              }
              return result;
            };

            return this.ok(parsed.cmd, {
              snapshotId,
              page: {
                pageId,
                name: resolved.page.name,
                fileKey: resolved.page.fileKey
              },
              root: formatTreeNode(subtreeNode, 0),
              rootSelector: selectorFromPath(rootPath),
              depth,
              selection: {
                pageId,
                nodeId: nodeId || nodeIdFromKey(rootKey),
                fileKey: treeFile.fileKey
              }
            });
          }

          const parsedYaml = YAML.parse(resolved.file.yaml);
          const rootPath = nodeId ? findNodePathById(parsedYaml, nodeId) : [];
          if (nodeId && !rootPath) {
            throw new Error(`Widget node not found: ${nodeId}`);
          }
          const subtreeNode = rootPath ? getAtPath(parsedYaml, rootPath) : parsedYaml;
          const formatYamlNode = (entry: unknown, currentDepth: number, path: Array<string | number>): Record<string, unknown> | undefined => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return undefined;
            }
            const row = entry as Record<string, unknown>;
            const children = Array.isArray(row.children) ? row.children : [];
            const result: Record<string, unknown> = {
              nodeId: typeof row.id === "string" ? row.id : undefined,
              type: typeof row.type === "string" ? row.type : undefined,
              name: typeof row.name === "string" ? row.name : undefined,
              selector: selectorFromPath(path),
              childrenCount: children.length
            };
            if (currentDepth < depth && children.length > 0) {
              result.children = children
                .map((child, index) => formatYamlNode(child, currentDepth + 1, [...path, "children", index]))
                .filter((child): child is Record<string, unknown> => !!child);
            }
            return result;
          };

          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            root: formatYamlNode(subtreeNode, 0, rootPath ?? []),
            rootSelector: selectorFromPath(rootPath ?? []),
            depth,
            selection: {
              pageId,
              nodeId: nodeId || pageId,
              fileKey: resolved.file.fileKey
            }
          });
        }

        case "tree.find": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const textQuery = strArg(args, "text", false);
          if (textQuery) {
            return await this.run({
              cmd: "widgets.findText",
              snapshot: snapshotId,
              args: {
                nameOrId: pageQuery,
                text: textQuery,
                exact: boolArg(args, "exact", false),
                type: strArg(args, "type", false),
                types: stringListArg(args, "types"),
                limit: numArg(args, "limit", 200),
                offset: numArg(args, "offset", 0)
              }
            });
          }
          const queryParts = [
            strArg(args, "q", false),
            strArg(args, "query", false),
            strArg(args, "name", false)
          ].filter((value) => value.length > 0);
          return await this.run({
            cmd: "widgets.find",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              q: queryParts.join(" ").trim(),
              type: strArg(args, "type", false),
              types: stringListArg(args, "types"),
              nameContains: strArg(args, "nameContains", false),
              textContains: strArg(args, "textContains", false),
              include: stringListArg(args, "include"),
              includeNode: boolArg(args, "includeNode", false),
              limit: numArg(args, "limit", 200),
              offset: numArg(args, "offset", 0)
            }
          });
        }

        case "tree.validate": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const includeOrphans = boolArg(args, "includeOrphans", true);
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitContext = loadSplitTreeContext(this.snapshotRepo, snapshotId, pageId);
          const report = validateSplitTreeContext(keyFromNodeId(pageId), splitContext, includeOrphans);
          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            ...report
          });
        }

        case "tree.repair": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const fixOrphans = boolArg(args, "fixOrphans", true);
          const fixMissingNodes = boolArg(args, "fixMissingNodes", true);
          const normalizeTree = boolArg(args, "normalizeTree", true);
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitContext = loadSplitTreeContext(this.snapshotRepo, snapshotId, pageId);
          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Repair tree ${resolved.page.name}`,
            strArg(args, "intent", false) || `Repair split tree integrity for ${resolved.page.name}`
          ).changesetId;

          const repairsApplied: string[] = [];
          const skipped: string[] = [];
          const remainingIssues: string[] = [];

          if (normalizeTree) {
            const normalized = YAML.stringify(splitContext.tree, { lineWidth: 0 });
            if (normalized !== splitContext.treeFileYaml) {
              this.changesets.addEntry(changesetId, splitContext.treeFileKey, {
                type: "replace-range",
                start: 0,
                end: splitContext.treeFileYaml.length,
                replacement: normalized
              }, "Normalize tree YAML");
              repairsApplied.push("normalizeTree");
            }
          }

          const report = validateSplitTreeContext(keyFromNodeId(pageId), splitContext, true);
          for (const issue of report.issues) {
            if (issue.code === "tree.orphan_node_file") {
              if (!fixOrphans || !issue.fileKey) {
                skipped.push(issue.message);
                continue;
              }
              const file = this.snapshotRepo.getFile(snapshotId, issue.fileKey);
              const end = file?.yaml.length ?? 0;
              this.changesets.addEntry(changesetId, issue.fileKey, {
                type: "replace-range",
                start: 0,
                end,
                replacement: ""
              }, "Remove orphan node file");
              repairsApplied.push(`orphan:${issue.fileKey}`);
              continue;
            }
            if (issue.code === "tree.missing_node_file") {
              if (!fixMissingNodes || !issue.message.includes("key ")) {
                skipped.push(issue.message);
                continue;
              }
              const key = issue.message.split("key ").pop()?.trim() ?? "";
              if (!key) {
                skipped.push(issue.message);
                continue;
              }
              const nodeId = nodeIdFromKey(key);
              const fileKey = `page/${pageId}/page-widget-tree-outline/node/${nodeId}.yaml`;
              const skeleton = YAML.stringify({
                key,
                type: "Container",
                props: {},
                parameterValues: {}
              }, { lineWidth: 0 });
              this.changesets.addEntry(changesetId, fileKey, {
                type: "replace-range",
                start: 0,
                end: 0,
                replacement: skeleton
              }, "Create missing node file skeleton");
              repairsApplied.push(`missing:${fileKey}`);
              continue;
            }
            remainingIssues.push(issue.message);
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            changesetId,
            repairsApplied,
            skipped,
            remainingIssues,
            preview,
            validation,
            applyResult
          });
        }

        case "widget.get": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false) || strArg(args, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }

          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitNodeFiles = this.snapshotRepo.listFiles(
            snapshotId,
            `page/${pageId}/page-widget-tree-outline/node/`,
            10_000
          );
          const splitNodeFile = splitNodeFiles.find((file) => {
            const normalized = file.fileKey.replace(/\.ya?ml$/i, "");
            return normalized.endsWith(`/node/${nodeId}`);
          });

          if (splitNodeFile) {
            const parsedNode = YAML.parse(splitNodeFile.yaml);
            return this.ok(parsed.cmd, {
              snapshotId,
              page: {
                pageId,
                name: resolved.page.name,
                fileKey: resolved.page.fileKey
              },
              widget: {
                nodeId,
                selector: "$",
                fileKey: splitNodeFile.fileKey,
                node: parsedNode
              },
              selection: {
                pageId,
                nodeId,
                fileKey: splitNodeFile.fileKey
              }
            });
          }

          const parsedYaml = YAML.parse(resolved.file.yaml);
          const nodePath = findNodePathById(parsedYaml, nodeId);
          if (!nodePath) {
            throw new Error(`Widget node not found: ${nodeId}`);
          }
          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            widget: {
              nodeId,
              selector: selectorFromPath(nodePath),
              fileKey: resolved.file.fileKey,
              node: getAtPath(parsedYaml, nodePath)
            },
            selection: {
              pageId,
              nodeId,
              fileKey: resolved.file.fileKey
            }
          });
        }

        case "widget.insert": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const type = strArg(args, "type");
          const parentNodeId = strArg(args, "parentNodeId", false);
          const beforeNodeId = strArg(args, "beforeNodeId", false);
          const afterNodeId = strArg(args, "afterNodeId", false);
          if (beforeNodeId && afterNodeId) {
            throw new Error("Provide only one of beforeNodeId or afterNodeId");
          }
          if (!parentNodeId && !beforeNodeId && !afterNodeId) {
            throw new Error("Missing placement: provide parentNodeId or beforeNodeId or afterNodeId");
          }

          const hasIndex = Object.prototype.hasOwnProperty.call(args, "index");
          const requestedIndex = hasIndex ? Math.max(0, numArg(args, "index", 0)) : undefined;
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;

          let effectiveParentNodeId = parentNodeId;
          let effectivePosition = requestedIndex ?? Number.MAX_SAFE_INTEGER;
          if (!effectiveParentNodeId && (beforeNodeId || afterNodeId)) {
            const anchorNodeId = beforeNodeId || afterNodeId;
            if (!anchorNodeId) {
              throw new Error("Missing anchor widget id");
            }

            const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
            if (treeFile) {
              const treeYaml = YAML.parse(treeFile.yaml);
              const anchorSlot = findParentChildrenSlotByKey(treeYaml, keyFromNodeId(anchorNodeId));
              if (!anchorSlot) {
                throw new Error(`Anchor widget not found in page widget tree: ${anchorNodeId}`);
              }
              const parentPath = anchorSlot.childrenPath.slice(0, -1);
              const parentNode = getAtPath(treeYaml, parentPath);
              const parentKey = parentNode && typeof parentNode === "object" && !Array.isArray(parentNode)
                ? (parentNode as Record<string, unknown>).key
                : undefined;
              if (typeof parentKey !== "string" || parentKey.trim().length === 0) {
                throw new Error(`Unable to resolve parent node for anchor: ${anchorNodeId}`);
              }
              effectiveParentNodeId = nodeIdFromKey(parentKey);
              effectivePosition = anchorSlot.index + (afterNodeId ? 1 : 0);
            } else {
              const parsedYaml = YAML.parse(resolved.file.yaml);
              const anchorPath = findNodePathById(parsedYaml, anchorNodeId);
              if (!anchorPath || anchorPath.length === 0) {
                throw new Error(`Anchor widget not found: ${anchorNodeId}`);
              }
              const parentPath = anchorPath.slice(0, -1);
              const leaf = anchorPath[anchorPath.length - 1];
              const siblings = getAtPath(parsedYaml, parentPath);
              if (!Array.isArray(siblings) || typeof leaf !== "number") {
                throw new Error("Anchor placement is not in a list-like children array. Provide parentNodeId explicitly.");
              }
              const parentNode = getAtPath(parsedYaml, parentPath.slice(0, -1));
              const parentId = parentNode && typeof parentNode === "object" && !Array.isArray(parentNode)
                ? (parentNode as Record<string, unknown>).id
                : undefined;
              if (typeof parentId !== "string" || parentId.trim().length === 0) {
                throw new Error("Unable to infer parentNodeId for non-split anchor. Provide parentNodeId explicitly.");
              }
              effectiveParentNodeId = parentId;
              effectivePosition = leaf + (afterNodeId ? 1 : 0);
            }
          }

          if (!effectiveParentNodeId) {
            throw new Error("Missing resolved parentNodeId for insert");
          }

          return await this.run({
            cmd: "widget.create",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              parentNodeId: effectiveParentNodeId,
              type,
              nodeId: strArg(args, "nodeId", false),
              name: strArg(args, "name", false),
              props: asObject(args.props),
              position: effectivePosition,
              changesetId: strArg(args, "changesetId", false),
              title: strArg(args, "title", false),
              intent: strArg(args, "intent", false),
              note: strArg(args, "note", false),
              preview: boolArg(args, "preview", true),
              apply: boolArg(args, "apply", false),
              remoteValidate: boolArg(args, "remoteValidate", false)
            }
          });
        }

        case "widget.create": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const position = Math.max(0, numArg(args, "position", Number.MAX_SAFE_INTEGER));
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const wrapNodeId = strArg(args, "wrapNodeId", false);
          const name = strArg(args, "name", false) || undefined;
          const props = asObject(args.props);
          if (wrapNodeId) {
            const wrapperType = strArg(args, "type", false) || "Row";
            return await this.run({
              cmd: "widget.wrap",
              snapshot: snapshotId,
              args: {
                nameOrId: pageQuery,
                nodeId: wrapNodeId,
                wrapperType,
                wrapperNodeId: strArg(args, "nodeId", false),
                name,
                props,
                changesetId: strArg(args, "changesetId", false),
                title: strArg(args, "title", false),
                intent: strArg(args, "intent", false),
                preview: boolArg(args, "preview", true),
                apply: applyNow,
                remoteValidate: remoteValidateOnApply
              }
            });
          }

          const parentNodeId = strArg(args, "parentNodeId");
          const type = strArg(args, "type");
          const nodeId = normalizeNodeId(strArg(args, "nodeId", false) || defaultNodeIdForType(type));

          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitNodeFiles = this.snapshotRepo.listFiles(
            snapshotId,
            `page/${pageId}/page-widget-tree-outline/node/`,
            10_000
          );
          const existingSplit = splitNodeFiles.find((file) => {
            const normalized = file.fileKey.replace(/\.ya?ml$/i, "");
            return normalized.endsWith(`/node/${nodeId}`);
          });
          if (existingSplit) {
            throw new Error(`Widget already exists: ${nodeId}`);
          }
          if (!existingSplit && splitNodeFiles.length === 0) {
            const parsedYaml = YAML.parse(resolved.file.yaml);
            const existingNodePath = findNodePathById(parsedYaml, nodeId);
            if (existingNodePath) {
              throw new Error(`Widget already exists: ${nodeId}`);
            }
          }

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Create widget ${nodeId}`,
            strArg(args, "intent", false) || `Create ${type} widget on ${resolved.page.name}`
          ).changesetId;

          const createdEntries = [];
          if (splitNodeFiles.length > 0) {
            const treeFileKey = `page/${pageId}/page-widget-tree-outline.yaml`;
            const treeFile = this.snapshotRepo.getFile(snapshotId, treeFileKey);
            if (!treeFile) {
              throw new Error(`Split widget tree file missing: ${treeFileKey}`);
            }
            const treeYaml = YAML.parse(treeFile.yaml);
            const parentPath = findNodePathByKey(treeYaml, keyFromNodeId(parentNodeId));
            if (!parentPath) {
              throw new Error(`Parent widget node not found in tree: ${parentNodeId}`);
            }
            const childrenPath = [...parentPath, "children"];
            let nextTree = treeYaml;
            let children = getAtPath(nextTree, childrenPath);
            if (!Array.isArray(children)) {
              nextTree = setAtPath(nextTree, childrenPath, []);
              children = getAtPath(nextTree, childrenPath);
            }
            if (!Array.isArray(children)) {
              throw new Error("Unable to create children array for target parent");
            }
            const insertion = { key: keyFromNodeId(nodeId) };
            const insertionIndex = Math.min(position, children.length);
            children.splice(insertionIndex, 0, insertion);
            const treeReplacement = YAML.stringify(nextTree, { lineWidth: 0 });
            createdEntries.push(this.changesets.addEntry(changesetId, treeFile.fileKey, {
              type: "replace-range",
              start: 0,
              end: treeFile.yaml.length,
              replacement: treeReplacement
            }, "Insert widget into tree"));

            const nodeFileKey = `page/${pageId}/page-widget-tree-outline/node/${nodeId}.yaml`;
            const nodeYaml = buildWidgetNodeYaml(nodeId, type, name, props);
            createdEntries.push(this.changesets.addEntry(changesetId, nodeFileKey, {
              type: "replace-range",
              start: 0,
              end: 0,
              replacement: nodeYaml
            }, "Create widget node file"));
          } else {
            const parsedYaml = YAML.parse(resolved.file.yaml);
            const parentPath = findNodePathById(parsedYaml, parentNodeId);
            if (!parentPath) {
              throw new Error(`Parent widget node not found: ${parentNodeId}`);
            }
            const childrenPath = [...parentPath, "children"];
            let nextPageYaml = parsedYaml;
            let children = getAtPath(nextPageYaml, childrenPath);
            if (!Array.isArray(children)) {
              nextPageYaml = setAtPath(nextPageYaml, childrenPath, []);
              children = getAtPath(nextPageYaml, childrenPath);
            }
            if (!Array.isArray(children)) {
              throw new Error("Unable to create children array for target parent");
            }
            const insertion = {
              id: nodeId,
              type,
              ...(name ? { name } : {}),
              ...(Object.keys(props).length > 0 ? { props } : {})
            };
            const insertionIndex = Math.min(position, children.length);
            children.splice(insertionIndex, 0, insertion);
            const replacement = YAML.stringify(nextPageYaml, { lineWidth: 0 });
            createdEntries.push(this.changesets.addEntry(changesetId, resolved.file.fileKey, {
              type: "replace-range",
              start: 0,
              end: resolved.file.yaml.length,
              replacement
            }, "Insert widget object into page YAML"));
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            nodeId,
            type,
            changesetId,
            entries: createdEntries,
            preview,
            validation,
            applyResult
          });
        }

        case "widgets.copyPaste": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const mode = strArg(args, "mode");
          if (mode !== "copy" && mode !== "paste") {
            throw new Error("mode must be one of: copy, paste");
          }

          if (mode === "copy") {
            const pageQuery =
              strArg(args, "nameOrId", false) ||
              strArg(args, "pageId", false) ||
              strArg(args, "id", false) ||
              strArg(args, "fileKey", false);
            if (!pageQuery) {
              throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
            }
            const nodeId = strArg(args, "nodeId");
            const resolved = this.resolvePage(snapshotId, pageQuery);
            if (!resolved) {
              throw new Error(`Page not found: ${pageQuery}`);
            }
            const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
            const splitContext = loadSplitTreeContext(this.snapshotRepo, snapshotId, pageId);
            const rootKey = keyFromNodeId(nodeId);
            const rootPath = svcFindNodePathByKey(splitContext.tree, rootKey);
            if (!rootPath) {
              throw new Error(`Widget node not found in page widget tree: ${nodeId}`);
            }
            const treeNode = cloneTreeNode(getAtPath(splitContext.tree, rootPath));
            const keys = [...svcCollectWidgetTreeKeys(treeNode)];
            const nodeYamls: Record<string, string> = {};
            for (const key of keys) {
              const nodeFile = splitContext.nodeFileByKey.get(key);
              if (nodeFile) {
                nodeYamls[key] = nodeFile.yaml;
              }
            }
            const clipboardId = orbitId("clip");
            const entry: ClipboardEntry = {
              clipboardId,
              snapshotId,
              pageId,
              rootNodeId: nodeId,
              createdAt: new Date().toISOString(),
              keys,
              nodeYamls,
              treeNode
            };
            this.clipboards.set(clipboardId, entry);
            return this.ok(parsed.cmd, {
              snapshotId,
              mode,
              clipboardId,
              pageId,
              rootNodeId: nodeId,
              copiedNodes: keys.length
            });
          }

          const clipboardId = strArg(args, "clipboardId");
          const clipboard = this.clipboards.get(clipboardId);
          if (!clipboard) {
            throw new Error(`Clipboard not found: ${clipboardId}`);
          }
          if (clipboard.snapshotId !== snapshotId) {
            throw new Error(`Clipboard ${clipboardId} belongs to snapshot ${clipboard.snapshotId}, not ${snapshotId}`);
          }

          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false) ||
            clipboard.pageId;
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitContext = loadSplitTreeContext(this.snapshotRepo, snapshotId, pageId);
          const beforeNodeId = strArg(args, "beforeNodeId", false);
          const afterNodeId = strArg(args, "afterNodeId", false);
          const parentNodeId = strArg(args, "targetParentNodeId", false) || strArg(args, "parentNodeId", false);
          if ([beforeNodeId, afterNodeId, parentNodeId].filter((value) => !!value).length !== 1) {
            throw new Error("Paste requires exactly one placement: targetParentNodeId/parentNodeId or beforeNodeId or afterNodeId");
          }
          let destinationParentKey = "";
          let destinationIndex = 0;
          if (beforeNodeId || afterNodeId) {
            const anchorNodeId = beforeNodeId || afterNodeId;
            const slot = svcFindParentChildrenSlotByKey(splitContext.tree, keyFromNodeId(anchorNodeId!));
            if (!slot) {
              throw new Error(`Anchor widget not found in page widget tree: ${anchorNodeId}`);
            }
            const parentPath = slot.childrenPath.slice(0, -1);
            const parent = getAtPath(splitContext.tree, parentPath);
            const parentKey = parent && typeof parent === "object" && !Array.isArray(parent)
              ? (parent as Record<string, unknown>).key
              : undefined;
            if (typeof parentKey !== "string") {
              throw new Error(`Unable to resolve parent for anchor ${anchorNodeId}`);
            }
            destinationParentKey = parentKey;
            destinationIndex = slot.index + (afterNodeId ? 1 : 0);
          } else {
            destinationParentKey = keyFromNodeId(parentNodeId!);
            const indexProvided = Object.prototype.hasOwnProperty.call(args, "index");
            destinationIndex = indexProvided ? Math.max(0, numArg(args, "index", 0)) : Number.MAX_SAFE_INTEGER;
          }

          const keyMap = new Map<string, string>();
          const idMap = new Map<string, string>();
          for (const oldKey of clipboard.keys) {
            const oldNodeId = nodeIdFromKey(oldKey);
            let inferredType = "Widget";
            const oldYaml = clipboard.nodeYamls[oldKey];
            if (oldYaml) {
              try {
                const parsed = YAML.parse(oldYaml);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  const type = (parsed as Record<string, unknown>).type;
                  if (typeof type === "string" && type.trim()) {
                    inferredType = type;
                  }
                }
              } catch {
                // ignore type inference error
              }
            }
            const newNodeId = defaultNodeIdForType(inferredType);
            idMap.set(oldNodeId, newNodeId);
            keyMap.set(oldKey, keyFromNodeId(newNodeId));
          }

          const pastedTreeNode = replaceKeyRefsDeep(cloneTreeNode(clipboard.treeNode), keyMap);
          const attachResult = attachChildAt(splitContext.tree, destinationParentKey, pastedTreeNode, destinationIndex);
          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Paste subtree ${clipboard.rootNodeId}`,
            strArg(args, "intent", false) || `Paste subtree from clipboard ${clipboardId}`
          ).changesetId;

          const treeReplacement = YAML.stringify(splitContext.tree, { lineWidth: 0 });
          this.changesets.addEntry(changesetId, splitContext.treeFileKey, {
            type: "replace-range",
            start: 0,
            end: splitContext.treeFileYaml.length,
            replacement: treeReplacement
          }, "Paste subtree into tree outline");

          const createdNodeIds: string[] = [];
          for (const [oldKey, oldYaml] of Object.entries(clipboard.nodeYamls)) {
            const newKey = keyMap.get(oldKey);
            if (!newKey) {
              continue;
            }
            const newNodeId = nodeIdFromKey(newKey);
            createdNodeIds.push(newNodeId);
            let replacement = oldYaml;
            try {
              const parsed = YAML.parse(oldYaml);
              replacement = YAML.stringify(replaceKeyRefsDeep(parsed, keyMap), { lineWidth: 0 });
            } catch {
              // keep raw yaml on parse failures
            }
            const fileKey = `page/${pageId}/page-widget-tree-outline/node/${newNodeId}.yaml`;
            this.changesets.addEntry(changesetId, fileKey, {
              type: "replace-range",
              start: 0,
              end: 0,
              replacement
            }, "Create pasted node file");
          }

          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;
          const rootNewNodeId = idMap.get(clipboard.rootNodeId) ?? createdNodeIds[0];

          return this.ok(parsed.cmd, {
            snapshotId,
            mode,
            clipboardId,
            pageId,
            changesetId,
            pastedRootNodeId: rootNewNodeId,
            createdNodeIds,
            placement: {
              parentNodeId: nodeIdFromKey(destinationParentKey),
              index: attachResult.index
            },
            preview,
            validation,
            applyResult,
            selection: rootNewNodeId
              ? { pageId, nodeId: rootNewNodeId, fileKey: `page/${pageId}/page-widget-tree-outline/node/${rootNewNodeId}.yaml` }
              : undefined
          });
        }

        case "widget.duplicate": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId");
          const count = Math.max(1, numArg(args, "count", 1));
          const beforeNodeId = strArg(args, "beforeNodeId", false);
          const afterNodeId = strArg(args, "afterNodeId", false);
          const targetParentNodeId = strArg(args, "targetParentNodeId", false);
          const index = Object.prototype.hasOwnProperty.call(args, "index") ? Math.max(0, numArg(args, "index", 0)) : undefined;
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Duplicate widget ${nodeId}`,
            strArg(args, "intent", false) || `Duplicate widget ${nodeId}`
          ).changesetId;

          const copied = await this.run({
            cmd: "widgets.copyPaste",
            snapshot: snapshotId,
            args: {
              mode: "copy",
              nameOrId: pageQuery,
              nodeId
            }
          });
          if (!copied.ok) {
            return copied;
          }
          const copiedData = asObject(copied.data);
          const clipboardId = typeof copiedData.clipboardId === "string" ? copiedData.clipboardId : "";
          if (!clipboardId) {
            throw new Error("widgets.copyPaste(copy) did not return clipboardId");
          }

          const createdNodeIds: string[] = [];
          const anchorAfterNodeId = afterNodeId || (!beforeNodeId && !targetParentNodeId ? nodeId : "");
          for (let i = 0; i < count; i += 1) {
            const pasted = await this.run({
              cmd: "widgets.copyPaste",
              snapshot: snapshotId,
              args: {
                mode: "paste",
                clipboardId,
                nameOrId: pageQuery,
                changesetId,
                ...(targetParentNodeId ? { targetParentNodeId, ...(index !== undefined ? { index: index + i } : {}) } : {}),
                ...(beforeNodeId ? { beforeNodeId } : {}),
                ...(anchorAfterNodeId ? { afterNodeId: anchorAfterNodeId } : {}),
                preview: false,
                apply: false
              }
            });
            if (!pasted.ok) {
              return pasted;
            }
            const pastedData = asObject(pasted.data);
            const rootId = typeof pastedData.pastedRootNodeId === "string" ? pastedData.pastedRootNodeId : "";
            if (rootId) {
              createdNodeIds.push(rootId);
            }
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            changesetId,
            sourceNodeId: nodeId,
            rootNewNodeId: createdNodeIds[0],
            createdNodeIds,
            filesChanged: preview?.impact.filesTouched,
            selection: createdNodeIds[0] ? { nodeId: createdNodeIds[0] } : undefined,
            preview,
            validation,
            applyResult
          });
        }

        case "widget.deleteSubtree": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId");
          const keepNodeIds = new Set(stringListArg(args, "keepNodeIds"));
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);

          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitContext = loadSplitTreeContext(this.snapshotRepo, snapshotId, pageId);
          const targetKey = keyFromNodeId(nodeId);
          const slot = svcFindParentChildrenSlotByKey(splitContext.tree, targetKey);
          if (!slot) {
            throw new Error(`Widget node not found in page widget tree: ${nodeId}`);
          }
          const siblings = getAtPath(splitContext.tree, slot.childrenPath);
          if (!Array.isArray(siblings)) {
            throw new Error("Unable to resolve siblings while deleting subtree");
          }
          const removedRoot = siblings[slot.index];
          const subtreeKeys = svcCollectWidgetTreeKeys(removedRoot);
          siblings.splice(slot.index, 1);

          const keptKeys = new Set<string>();
          for (const keepNodeId of keepNodeIds) {
            const key = keyFromNodeId(keepNodeId);
            if (subtreeKeys.has(key)) {
              keptKeys.add(key);
            }
          }
          for (const keepKey of keptKeys) {
            const keepPath = svcFindNodePathByKey(removedRoot, keepKey);
            if (!keepPath) {
              continue;
            }
            const keepNode = cloneTreeNode(getAtPath(removedRoot, keepPath));
            siblings.splice(slot.index, 0, keepNode);
          }

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Delete subtree ${nodeId}`,
            strArg(args, "intent", false) || `Delete subtree ${nodeId}`
          ).changesetId;

          const treeReplacement = YAML.stringify(splitContext.tree, { lineWidth: 0 });
          this.changesets.addEntry(changesetId, splitContext.treeFileKey, {
            type: "replace-range",
            start: 0,
            end: splitContext.treeFileYaml.length,
            replacement: treeReplacement
          }, "Delete subtree from tree outline");

          let removedFiles = 0;
          for (const key of subtreeKeys) {
            if (keptKeys.has(key)) {
              continue;
            }
            const nodeFile = splitContext.nodeFileByKey.get(key);
            if (!nodeFile) {
              continue;
            }
            this.changesets.addEntry(changesetId, nodeFile.fileKey, {
              type: "replace-range",
              start: 0,
              end: nodeFile.yaml.length,
              replacement: ""
            }, "Delete subtree node file");
            removedFiles += 1;
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            pageId,
            nodeId,
            removedNodes: subtreeKeys.size - keptKeys.size,
            removedFiles,
            keptNodes: [...keptKeys].map((key) => nodeIdFromKey(key)),
            changesetId,
            preview,
            validation,
            applyResult
          });
        }

        case "widget.removeChildren": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId");
          const keepNodeIds = new Set(stringListArg(args, "keepNodeIds"));
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);

          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitContext = loadSplitTreeContext(this.snapshotRepo, snapshotId, pageId);
          const parentPath = svcFindNodePathByKey(splitContext.tree, keyFromNodeId(nodeId));
          if (!parentPath) {
            throw new Error(`Parent widget node not found in page widget tree: ${nodeId}`);
          }
          const parent = getAtPath(splitContext.tree, parentPath);
          if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
            throw new Error("Unable to resolve parent widget object");
          }
          const childrenRaw = (parent as Record<string, unknown>).children;
          if (!Array.isArray(childrenRaw)) {
            return this.ok(parsed.cmd, {
              snapshotId,
              pageId,
              nodeId,
              removedChildrenCount: 0,
              removedNodeFilesCount: 0
            });
          }
          const removedTreeNodes = childrenRaw.filter((child) => {
            if (!child || typeof child !== "object" || Array.isArray(child)) {
              return false;
            }
            const key = (child as Record<string, unknown>).key;
            if (typeof key !== "string") {
              return true;
            }
            return !keepNodeIds.has(nodeIdFromKey(key));
          });
          (parent as Record<string, unknown>).children = childrenRaw.filter((child) => {
            if (!child || typeof child !== "object" || Array.isArray(child)) {
              return false;
            }
            const key = (child as Record<string, unknown>).key;
            return typeof key === "string" && keepNodeIds.has(nodeIdFromKey(key));
          });

          const removedKeys = new Set<string>();
          for (const child of removedTreeNodes) {
            for (const key of svcCollectWidgetTreeKeys(child)) {
              removedKeys.add(key);
            }
          }
          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Remove children from ${nodeId}`,
            strArg(args, "intent", false) || `Remove children from ${nodeId}`
          ).changesetId;
          this.changesets.addEntry(changesetId, splitContext.treeFileKey, {
            type: "replace-range",
            start: 0,
            end: splitContext.treeFileYaml.length,
            replacement: YAML.stringify(splitContext.tree, { lineWidth: 0 })
          }, "Remove widget children");

          let removedNodeFilesCount = 0;
          for (const key of removedKeys) {
            const nodeFile = splitContext.nodeFileByKey.get(key);
            if (!nodeFile) {
              continue;
            }
            this.changesets.addEntry(changesetId, nodeFile.fileKey, {
              type: "replace-range",
              start: 0,
              end: nodeFile.yaml.length,
              replacement: ""
            }, "Remove descendant node file");
            removedNodeFilesCount += 1;
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;
          return this.ok(parsed.cmd, {
            snapshotId,
            pageId,
            nodeId,
            removedChildrenCount: removedTreeNodes.length,
            removedNodeFilesCount,
            changesetId,
            preview,
            validation,
            applyResult
          });
        }

        case "widgets.updateMany": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const filter = parseWidgetFilterSpec(args.filter);
          const setSpec = parseWidgetUpdateSpec(args.set);
          if (!setSpec.text && !setSpec.keyValuePairs && !setSpec.patch) {
            throw new Error("set must include at least one of text, keyValuePairs, patch");
          }
          const limit = Math.max(1, Math.min(numArg(args, "limit", 1000), 2000));
          const dryRun = boolArg(args, "dryRun", false);
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const list = await this.run({
            cmd: "widgets.list",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              includeNode: true,
              limit: 10_000
            }
          });
          if (!list.ok) {
            return list;
          }
          const widgets = Array.isArray(asObject(list.data).widgets) ? asObject(list.data).widgets as unknown[] : [];
          const page = asObject(asObject(list.data).page);
          const pageId = typeof page.pageId === "string" ? page.pageId : undefined;
          const matched = widgets
            .map((entry) => asObject(entry))
            .filter((row) => {
              const node = asObject(row.node);
              const nodeId = typeof row.nodeId === "string" ? row.nodeId : undefined;
              const type = typeof row.type === "string" ? row.type : undefined;
              return matchesWidgetFilter(node, nodeId, type, filter);
            })
            .slice(0, limit);

          if (dryRun) {
            return this.ok(parsed.cmd, {
              snapshotId,
              pageId,
              dryRun: true,
              matched: matched.length,
              targets: matched.map((row) => ({
                nodeId: row.nodeId,
                type: row.type,
                name: row.name,
                fileKey: row.fileKey
              }))
            });
          }

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Update many widgets on ${pageQuery}`,
            strArg(args, "intent", false) || `Batch update widgets on ${pageQuery}`
          ).changesetId;
          const updated: Array<{ nodeId: string; action: string }> = [];
          const skipped: Array<{ nodeId: string; reason: string }> = [];
          for (const row of matched) {
            const nodeId = typeof row.nodeId === "string" ? row.nodeId : "";
            if (!nodeId) {
              continue;
            }
            try {
              if (setSpec.text) {
                await this.run({
                  cmd: "widget.set",
                  snapshot: snapshotId,
                  args: {
                    changesetId,
                    nameOrId: pageQuery,
                    nodeId,
                    text: setSpec.text,
                    preview: false
                  }
                });
                updated.push({ nodeId, action: "text" });
              }
              if (setSpec.keyValuePairs) {
                for (const [key, value] of Object.entries(setSpec.keyValuePairs)) {
                  await this.run({
                    cmd: "widget.set",
                    snapshot: snapshotId,
                    args: {
                      changesetId,
                      nameOrId: pageQuery,
                      nodeId,
                      key,
                      value,
                      preview: false
                    }
                  });
                  updated.push({ nodeId, action: `key:${key}` });
                }
              }
              if (setSpec.patch) {
                await this.run({
                  cmd: "widget.set",
                  snapshot: snapshotId,
                  args: {
                    changesetId,
                    nameOrId: pageQuery,
                    nodeId,
                    patch: setSpec.patch,
                    preview: false
                  }
                });
                updated.push({ nodeId, action: "patch" });
              }
            } catch (error) {
              skipped.push({
                nodeId,
                reason: error instanceof Error ? error.message : String(error)
              });
            }
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            pageId,
            changesetId,
            matched: matched.length,
            updated: updated.length,
            skippedCount: skipped.length,
            skipped,
            preview,
            validation,
            applyResult
          });
        }

        case "widget.replaceType": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId");
          const toType = strArg(args, "toType");
          const propMode = strArg(args, "propMode", false) || "safe";
          const patchProps = asObject(args.props);
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const getResult = await this.run({
            cmd: "widget.get",
            snapshot: snapshotId,
            args: { nameOrId: pageQuery, nodeId }
          });
          if (!getResult.ok) {
            return getResult;
          }
          const data = asObject(getResult.data);
          const widget = asObject(data.widget);
          const node = asObject(widget.node);
          const oldType = typeof node.type === "string" ? node.type : undefined;
          const props = asObject(node.props);
          const keptProps: string[] = [];
          const droppedProps: string[] = [];
          let nextProps: Record<string, unknown> = {};
          if (propMode === "force") {
            nextProps = { ...props };
            keptProps.push(...Object.keys(props));
          } else {
            const safeKeys = new Set(["padding", "responsiveVisibility", "alignment", "width", "height"]);
            for (const [key, value] of Object.entries(props)) {
              if (safeKeys.has(key)) {
                nextProps[key] = value;
                keptProps.push(key);
              } else {
                droppedProps.push(key);
              }
            }
          }
          nextProps = { ...nextProps, ...patchProps };
          const fileKey = typeof widget.fileKey === "string" ? widget.fileKey : "";
          if (!fileKey) {
            throw new Error("widget.get did not return fileKey");
          }
          const file = this.snapshotRepo.getFile(snapshotId, fileKey);
          if (!file) {
            throw new Error(`Widget file missing from snapshot: ${fileKey}`);
          }
          const parsedNode = YAML.parse(file.yaml);
          if (!parsedNode || typeof parsedNode !== "object" || Array.isArray(parsedNode)) {
            throw new Error(`Widget node YAML is not an object: ${fileKey}`);
          }
          (parsedNode as Record<string, unknown>).type = toType;
          (parsedNode as Record<string, unknown>).props = nextProps;
          const replacement = YAML.stringify(parsedNode, { lineWidth: 0 });

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Replace widget type ${nodeId}`,
            strArg(args, "intent", false) || `Replace ${nodeId} type to ${toType}`
          ).changesetId;
          const entry = this.changesets.addEntry(changesetId, fileKey, {
            type: "replace-range",
            start: 0,
            end: file.yaml.length,
            replacement
          }, "Replace widget type");
          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;
          return this.ok(parsed.cmd, {
            snapshotId,
            nodeId,
            fromType: oldType,
            toType,
            propMode,
            droppedProps,
            keptProps,
            changesetId,
            entry,
            preview,
            validation,
            applyResult
          });
        }

        case "widget.wrap": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const targetNodeId =
            strArg(args, "nodeId", false) ||
            strArg(args, "targetNodeId", false) ||
            strArg(args, "wrapNodeId", false);
          if (!targetNodeId) {
            throw new Error("Missing string arg: nodeId (aliases: targetNodeId, wrapNodeId)");
          }
          const wrapperType = strArg(args, "wrapperType", false) || strArg(args, "type", false) || "Row";
          const wrapperNodeId = normalizeNodeId(
            strArg(args, "wrapperNodeId", false) ||
              strArg(args, "newNodeId", false) ||
              defaultNodeIdForType(wrapperType)
          );
          if (wrapperNodeId === targetNodeId) {
            throw new Error("wrapperNodeId must differ from nodeId being wrapped");
          }
          const wrapperName = strArg(args, "name", false) || undefined;
          const wrapperProps = asObject(args.props);
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);

          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Wrap widget ${targetNodeId} with ${wrapperType}`,
            strArg(args, "intent", false) || `Wrap widget ${targetNodeId} with ${wrapperType} on ${resolved.page.name}`
          ).changesetId;

          const splitNodeFiles = this.snapshotRepo.listFiles(
            snapshotId,
            `page/${pageId}/page-widget-tree-outline/node/`,
            10_000
          );
          const existingSplitWrapper = splitNodeFiles.find((file) =>
            file.fileKey.replace(/\.ya?ml$/i, "").endsWith(`/node/${wrapperNodeId}`)
          );
          if (existingSplitWrapper) {
            throw new Error(`Widget already exists: ${wrapperNodeId}`);
          }

          const entries = [];
          if (splitNodeFiles.length > 0) {
            const treeFileKey = `page/${pageId}/page-widget-tree-outline.yaml`;
            const treeFile = this.snapshotRepo.getFile(snapshotId, treeFileKey);
            if (!treeFile) {
              throw new Error(`Split widget tree file missing: ${treeFileKey}`);
            }
            const treeYaml = YAML.parse(treeFile.yaml);
            const targetKey = keyFromNodeId(targetNodeId);
            const slot = findParentChildrenSlotByKey(treeYaml, targetKey);
            if (!slot) {
              throw new Error(`Widget node not found in page widget tree: ${targetNodeId}`);
            }
            const children = getAtPath(treeYaml, slot.childrenPath);
            if (!Array.isArray(children)) {
              throw new Error("Target parent does not expose a children array in page widget tree");
            }

            children.splice(slot.index, 1, {
              key: keyFromNodeId(wrapperNodeId),
              children: [{ key: targetKey }]
            });

            const treeReplacement = YAML.stringify(treeYaml, { lineWidth: 0 });
            entries.push(this.changesets.addEntry(changesetId, treeFile.fileKey, {
              type: "replace-range",
              start: 0,
              end: treeFile.yaml.length,
              replacement: treeReplacement
            }, "Wrap widget in tree outline"));

            const wrapperNodeFileKey = `page/${pageId}/page-widget-tree-outline/node/${wrapperNodeId}.yaml`;
            const wrapperNodeYaml = buildWidgetNodeYaml(wrapperNodeId, wrapperType, wrapperName, wrapperProps);
            entries.push(this.changesets.addEntry(changesetId, wrapperNodeFileKey, {
              type: "replace-range",
              start: 0,
              end: 0,
              replacement: wrapperNodeYaml
            }, "Create wrapper widget node file"));
          } else {
            const parsedYaml = YAML.parse(resolved.file.yaml);
            const targetPath = findNodePathById(parsedYaml, targetNodeId);
            if (!targetPath || targetPath.length === 0) {
              throw new Error(`Widget node not found or cannot wrap root: ${targetNodeId}`);
            }

            const parentPath = targetPath.slice(0, -1);
            const leaf = targetPath[targetPath.length - 1]!;
            const parent = getAtPath(parsedYaml, parentPath);
            let targetNode: unknown;
            if (Array.isArray(parent) && typeof leaf === "number") {
              targetNode = parent[leaf];
              parent[leaf] = {
                id: wrapperNodeId,
                type: wrapperType,
                ...(wrapperName ? { name: wrapperName } : {}),
                ...(Object.keys(wrapperProps).length > 0 ? { props: wrapperProps } : {}),
                children: [targetNode]
              };
            } else if (parent !== null && typeof parent === "object" && typeof leaf === "string") {
              targetNode = (parent as Record<string, unknown>)[leaf];
              (parent as Record<string, unknown>)[leaf] = {
                id: wrapperNodeId,
                type: wrapperType,
                ...(wrapperName ? { name: wrapperName } : {}),
                ...(Object.keys(wrapperProps).length > 0 ? { props: wrapperProps } : {}),
                children: [targetNode]
              };
            } else {
              throw new Error(`Unable to wrap widget at ${selectorFromPath(targetPath)}`);
            }
            const replacement = YAML.stringify(parsedYaml, { lineWidth: 0 });
            entries.push(this.changesets.addEntry(changesetId, resolved.file.fileKey, {
              type: "replace-range",
              start: 0,
              end: resolved.file.yaml.length,
              replacement
            }, "Wrap widget object in page YAML"));
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            targetNodeId,
            wrapperNodeId,
            wrapperType,
            changesetId,
            entries,
            preview,
            validation,
            applyResult
          });
        }

        case "widget.move": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false) || strArg(args, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }
          const parentNodeId = strArg(args, "parentNodeId", false);
          const beforeNodeId = strArg(args, "beforeNodeId", false);
          const afterNodeId = strArg(args, "afterNodeId", false);
          if (beforeNodeId && afterNodeId) {
            throw new Error("Provide only one of beforeNodeId or afterNodeId");
          }
          const hasIndex = Object.prototype.hasOwnProperty.call(args, "index");
          const requestedIndex = hasIndex ? Math.max(0, numArg(args, "index", 0)) : undefined;
          if (!parentNodeId && !beforeNodeId && !afterNodeId && requestedIndex === undefined) {
            throw new Error("Provide destination via parentNodeId(+index), beforeNodeId, afterNodeId, or index for same-parent reorder");
          }

          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const treeFileKey = `page/${pageId}/page-widget-tree-outline.yaml`;
          const treeFile = this.snapshotRepo.getFile(snapshotId, treeFileKey);
          if (!treeFile) {
            throw new Error("widget.move currently requires split page-widget-tree-outline mode");
          }

          const treeYaml = YAML.parse(treeFile.yaml);
          const sourceKey = keyFromNodeId(nodeId);
          const sourcePath = findNodePathByKey(treeYaml, sourceKey);
          if (!sourcePath) {
            throw new Error(`Widget node not found in page widget tree: ${nodeId}`);
          }
          const sourceSlot = findParentChildrenSlotByKey(treeYaml, sourceKey);
          if (!sourceSlot) {
            throw new Error(`Cannot move root widget: ${nodeId}`);
          }
          const sourceParentPath = sourceSlot.childrenPath.slice(0, -1);
          const sourceParentNode = getAtPath(treeYaml, sourceParentPath);
          const sourceParentKey = sourceParentNode && typeof sourceParentNode === "object" && !Array.isArray(sourceParentNode)
            ? (sourceParentNode as Record<string, unknown>).key
            : undefined;

          const sourceChildren = getAtPath(treeYaml, sourceSlot.childrenPath);
          if (!Array.isArray(sourceChildren) || sourceSlot.index < 0 || sourceSlot.index >= sourceChildren.length) {
            throw new Error("Unable to resolve source sibling slot in tree");
          }
          const sourceEntry = sourceChildren[sourceSlot.index];
          const descendants = collectWidgetTreeKeys(sourceEntry);
          sourceChildren.splice(sourceSlot.index, 1);

          let destinationChildrenPath: Array<string | number> = sourceSlot.childrenPath;
          let destinationIndex = sourceSlot.index;

          if (beforeNodeId || afterNodeId) {
            const anchorNodeId = beforeNodeId || afterNodeId;
            const anchorKey = keyFromNodeId(anchorNodeId);
            if (descendants.has(anchorKey) && anchorKey !== sourceKey) {
              throw new Error("Cannot move a node relative to one of its descendants");
            }
            const anchorSlot = findParentChildrenSlotByKey(treeYaml, anchorKey);
            if (!anchorSlot) {
              throw new Error(`Anchor widget not found in page widget tree: ${anchorNodeId}`);
            }
            destinationChildrenPath = anchorSlot.childrenPath;
            destinationIndex = anchorSlot.index + (afterNodeId ? 1 : 0);
          } else if (parentNodeId) {
            const destinationParentKey = keyFromNodeId(parentNodeId);
            if (descendants.has(destinationParentKey) || destinationParentKey === sourceKey) {
              throw new Error("Cannot move a node into itself or its descendant");
            }
            const destinationParentPath = findNodePathByKey(treeYaml, destinationParentKey);
            if (!destinationParentPath) {
              throw new Error(`Destination parent not found in page widget tree: ${parentNodeId}`);
            }
            destinationChildrenPath = [...destinationParentPath, "children"];
            let destinationChildren = getAtPath(treeYaml, destinationChildrenPath);
            if (!Array.isArray(destinationChildren)) {
              setAtPath(treeYaml, destinationChildrenPath, []);
              destinationChildren = getAtPath(treeYaml, destinationChildrenPath);
            }
            if (!Array.isArray(destinationChildren)) {
              throw new Error("Unable to create children array for destination parent");
            }
            destinationIndex = requestedIndex === undefined
              ? destinationChildren.length
              : Math.min(requestedIndex, destinationChildren.length);
          } else if (requestedIndex !== undefined) {
            const currentSiblings = getAtPath(treeYaml, sourceSlot.childrenPath);
            if (!Array.isArray(currentSiblings)) {
              throw new Error("Unable to resolve sibling list for reorder");
            }
            destinationChildrenPath = sourceSlot.childrenPath;
            destinationIndex = Math.min(requestedIndex, currentSiblings.length);
          }

          const destinationChildren = getAtPath(treeYaml, destinationChildrenPath);
          if (!Array.isArray(destinationChildren)) {
            throw new Error("Unable to resolve destination children list");
          }
          destinationChildren.splice(Math.min(destinationIndex, destinationChildren.length), 0, sourceEntry);

          const destinationParentPath = destinationChildrenPath.slice(0, -1);
          const destinationParentNode = getAtPath(treeYaml, destinationParentPath);
          const destinationParentKey = destinationParentNode && typeof destinationParentNode === "object" && !Array.isArray(destinationParentNode)
            ? (destinationParentNode as Record<string, unknown>).key
            : undefined;

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Move widget ${nodeId}`,
            strArg(args, "intent", false) || `Move widget ${nodeId} on ${resolved.page.name}`
          ).changesetId;
          const replacement = YAML.stringify(treeYaml, { lineWidth: 0 });
          const entry = this.changesets.addEntry(changesetId, treeFile.fileKey, {
            type: "replace-range",
            start: 0,
            end: treeFile.yaml.length,
            replacement
          }, strArg(args, "note", false) || undefined);

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            nodeId,
            from: {
              parentNodeId: typeof sourceParentKey === "string" ? nodeIdFromKey(sourceParentKey) : undefined,
              parentKey: typeof sourceParentKey === "string" ? sourceParentKey : undefined,
              index: sourceSlot.index
            },
            to: {
              parentNodeId: typeof destinationParentKey === "string" ? nodeIdFromKey(destinationParentKey) : undefined,
              parentKey: typeof destinationParentKey === "string" ? destinationParentKey : undefined,
              index: Math.min(destinationIndex, Math.max(0, destinationChildren.length - 1))
            },
            fileKey: treeFile.fileKey,
            changesetId,
            entry,
            preview,
            validation,
            applyResult,
            selection: {
              pageId,
              nodeId,
              fileKey: treeFile.fileKey
            }
          });
        }

        case "widget.reorder": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false) || strArg(args, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }
          const direction = strArg(args, "direction").toLowerCase();
          if (direction !== "up" && direction !== "down") {
            throw new Error("direction must be one of: up, down");
          }
          const steps = Math.max(1, numArg(args, "steps", 1));
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          if (!treeFile) {
            throw new Error("widget.reorder currently requires split page-widget-tree-outline mode");
          }
          const treeYaml = YAML.parse(treeFile.yaml);
          const slot = findParentChildrenSlotByKey(treeYaml, keyFromNodeId(nodeId));
          if (!slot) {
            throw new Error(`Widget node not found or not movable: ${nodeId}`);
          }
          const siblings = getAtPath(treeYaml, slot.childrenPath);
          if (!Array.isArray(siblings)) {
            throw new Error("Unable to resolve siblings for reorder");
          }
          const delta = direction === "up" ? -steps : steps;
          const targetIndex = Math.max(0, Math.min(siblings.length - 1, slot.index + delta));
          if (targetIndex === slot.index) {
            return this.ok(parsed.cmd, {
              snapshotId,
              page: {
                pageId,
                name: resolved.page.name,
                fileKey: resolved.page.fileKey
              },
              nodeId,
              changed: false,
              reason: "Node already at requested relative position."
            });
          }

          const anchor = siblings[targetIndex];
          if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
            throw new Error("Unable to resolve anchor node for reorder");
          }
          const anchorKey = (anchor as Record<string, unknown>).key;
          if (typeof anchorKey !== "string") {
            throw new Error("Anchor node is missing key for reorder");
          }

          return await this.run({
            cmd: "widget.move",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              nodeId,
              ...(direction === "up"
                ? { beforeNodeId: nodeIdFromKey(anchorKey) }
                : { afterNodeId: nodeIdFromKey(anchorKey) }),
              preview: boolArg(args, "preview", true),
              apply: boolArg(args, "apply", false),
              remoteValidate: boolArg(args, "remoteValidate", false),
              changesetId: strArg(args, "changesetId", false),
              title: strArg(args, "title", false),
              intent: strArg(args, "intent", false),
              note: strArg(args, "note", false)
            }
          });
        }

        case "widget.moveMany": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeIds = stringListArg(args, "nodeIds");
          if (nodeIds.length === 0) {
            throw new Error("Missing array arg: nodeIds");
          }
          const parentNodeId = strArg(args, "parentNodeId", false);
          const beforeNodeId = strArg(args, "beforeNodeId", false);
          const afterNodeId = strArg(args, "afterNodeId", false);
          const placementCount = [parentNodeId, beforeNodeId, afterNodeId].filter((value) => value.length > 0).length;
          if (placementCount !== 1) {
            throw new Error("Provide exactly one placement mode: parentNodeId or beforeNodeId or afterNodeId");
          }

          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const preserveOrder = boolArg(args, "preserveOrder", true);
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const treeFileKey = `page/${pageId}/page-widget-tree-outline.yaml`;
          const treeFile = this.snapshotRepo.getFile(snapshotId, treeFileKey);
          if (!treeFile) {
            throw new Error("This command requires split tree mode (page/<id>/page-widget-tree-outline.yaml + node files). Run snapshots.ensureFresh then retry.");
          }
          const treeYaml = YAML.parse(treeFile.yaml);

          const uniqueIds = [...new Set(nodeIds)];
          const sourceSlots = uniqueIds.map((nodeId) => {
            const key = keyFromNodeId(nodeId);
            const slot = findParentChildrenSlotByKey(treeYaml, key);
            if (!slot) {
              throw new Error(`Widget node not found in page widget tree: ${nodeId}`);
            }
            const siblings = getAtPath(treeYaml, slot.childrenPath);
            if (!Array.isArray(siblings) || slot.index < 0 || slot.index >= siblings.length) {
              throw new Error(`Unable to resolve source slot for ${nodeId}`);
            }
            const parentPath = slot.childrenPath.slice(0, -1);
            const parent = getAtPath(treeYaml, parentPath);
            const parentKey = parent && typeof parent === "object" && !Array.isArray(parent)
              ? (parent as Record<string, unknown>).key
              : undefined;
            return {
              nodeId,
              key,
              slot,
              parentKey: typeof parentKey === "string" ? parentKey : undefined,
              entry: siblings[slot.index] as unknown
            };
          });

          const toMove = preserveOrder
            ? sourceSlots
                .slice()
                .sort((a, b) => {
                  const aPath = `${selectorFromPath(a.slot.childrenPath)}#${a.slot.index.toString().padStart(5, "0")}`;
                  const bPath = `${selectorFromPath(b.slot.childrenPath)}#${b.slot.index.toString().padStart(5, "0")}`;
                  return aPath.localeCompare(bPath);
                })
            : sourceSlots;

          // Remove in reverse index order per siblings path.
          const grouped = new Map<string, Array<{ slot: { childrenPath: Array<string | number>; index: number } }>>();
          for (const row of toMove) {
            const key = selectorFromPath(row.slot.childrenPath);
            const list = grouped.get(key) ?? [];
            list.push({ slot: row.slot });
            grouped.set(key, list);
          }
          for (const [, rows] of grouped.entries()) {
            rows.sort((a, b) => b.slot.index - a.slot.index);
            for (const row of rows) {
              const siblings = getAtPath(treeYaml, row.slot.childrenPath);
              if (!Array.isArray(siblings) || row.slot.index < 0 || row.slot.index >= siblings.length) {
                throw new Error("Unable to remove source node during moveMany");
              }
              siblings.splice(row.slot.index, 1);
            }
          }

          let destinationChildrenPath: Array<string | number>;
          let destinationIndex: number;
          if (beforeNodeId || afterNodeId) {
            const anchorNodeId = beforeNodeId || afterNodeId;
            const anchorSlot = findParentChildrenSlotByKey(treeYaml, keyFromNodeId(anchorNodeId));
            if (!anchorSlot) {
              throw new Error(`Anchor widget not found in page widget tree: ${anchorNodeId}`);
            }
            destinationChildrenPath = anchorSlot.childrenPath;
            destinationIndex = anchorSlot.index + (afterNodeId ? 1 : 0);
          } else {
            const parentPath = findNodePathByKey(treeYaml, keyFromNodeId(parentNodeId));
            if (!parentPath) {
              throw new Error(`Destination parent not found in page widget tree: ${parentNodeId}`);
            }
            destinationChildrenPath = [...parentPath, "children"];
            let siblings = getAtPath(treeYaml, destinationChildrenPath);
            if (!Array.isArray(siblings)) {
              setAtPath(treeYaml, destinationChildrenPath, []);
              siblings = getAtPath(treeYaml, destinationChildrenPath);
            }
            if (!Array.isArray(siblings)) {
              throw new Error("Unable to resolve destination children list");
            }
            const requestedIndex = Object.prototype.hasOwnProperty.call(args, "index")
              ? Math.max(0, numArg(args, "index", siblings.length))
              : siblings.length;
            destinationIndex = Math.min(requestedIndex, siblings.length);
          }

          const destinationSiblings = getAtPath(treeYaml, destinationChildrenPath);
          if (!Array.isArray(destinationSiblings)) {
            throw new Error("Unable to resolve destination children list");
          }
          const moved: WidgetMoveManyResult["moved"] = [];
          let insertAt = destinationIndex;
          for (const row of toMove) {
            destinationSiblings.splice(Math.min(insertAt, destinationSiblings.length), 0, row.entry);
            const destinationParentPath = destinationChildrenPath.slice(0, -1);
            const destinationParent = getAtPath(treeYaml, destinationParentPath);
            const destinationParentKey = destinationParent && typeof destinationParent === "object" && !Array.isArray(destinationParent)
              ? (destinationParent as Record<string, unknown>).key
              : undefined;
            moved.push({
              nodeId: row.nodeId,
              from: { parentNodeId: row.parentKey ? nodeIdFromKey(row.parentKey) : undefined, index: row.slot.index },
              to: { parentNodeId: typeof destinationParentKey === "string" ? nodeIdFromKey(destinationParentKey) : undefined, index: insertAt }
            });
            insertAt += 1;
          }

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Move ${uniqueIds.length} widgets`,
            strArg(args, "intent", false) || `Move ${uniqueIds.join(", ")} on ${resolved.page.name}`
          ).changesetId;
          const replacement = YAML.stringify(treeYaml, { lineWidth: 0 });
          this.changesets.addEntry(changesetId, treeFile.fileKey, {
            type: "replace-range",
            start: 0,
            end: treeFile.yaml.length,
            replacement
          }, "Move multiple widgets");

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          const result: WidgetMoveManyResult = {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            movedCount: moved.length,
            moved,
            changesetId,
            preview,
            validation,
            applyResult
          };
          return this.ok(parsed.cmd, {
            ...result,
            selection: moved[0]
              ? {
                  pageId,
                  nodeId: moved[0].nodeId,
                  fileKey: treeFile.fileKey
                }
              : undefined
          });
        }

        case "widget.unwrap": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false) || strArg(args, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          if (!treeFile) {
            throw new Error("This command requires split tree mode (page/<id>/page-widget-tree-outline.yaml + node files). Run snapshots.ensureFresh then retry.");
          }
          const treeYaml = YAML.parse(treeFile.yaml);
          const wrapperKey = keyFromNodeId(nodeId);
          const rootPath = findNodePathByKey(treeYaml, keyFromNodeId(pageId));
          const wrapperPath = findNodePathByKey(treeYaml, wrapperKey);
          if (!wrapperPath) {
            throw new Error(`Widget node not found in page widget tree: ${nodeId}`);
          }
          if (rootPath && selectorFromPath(wrapperPath) === selectorFromPath(rootPath)) {
            throw new Error("Cannot unwrap root page node.");
          }
          const slot = findParentChildrenSlotByKey(treeYaml, wrapperKey);
          if (!slot) {
            throw new Error(`Unable to resolve wrapper parent slot: ${nodeId}`);
          }
          const siblings = getAtPath(treeYaml, slot.childrenPath);
          if (!Array.isArray(siblings) || slot.index < 0 || slot.index >= siblings.length) {
            throw new Error("Unable to resolve wrapper sibling position");
          }
          const wrapperEntry = siblings[slot.index];
          if (!wrapperEntry || typeof wrapperEntry !== "object" || Array.isArray(wrapperEntry)) {
            throw new Error("Wrapper node is not an object entry");
          }
          const wrapperChildren = Array.isArray((wrapperEntry as Record<string, unknown>).children)
            ? ((wrapperEntry as Record<string, unknown>).children as unknown[])
            : [];
          if (wrapperChildren.length === 0) {
            throw new Error("Cannot unwrap wrapper without children.");
          }
          const promotedChildNodeIds = wrapperChildren
            .map((entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).key : ""))
            .filter((key): key is string => typeof key === "string" && key.length > 0)
            .map((key) => nodeIdFromKey(key));

          siblings.splice(slot.index, 1, ...wrapperChildren);

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Unwrap ${nodeId}`,
            strArg(args, "intent", false) || `Unwrap ${nodeId} on ${resolved.page.name}`
          ).changesetId;
          const entries: ChangesetEntry[] = [];
          entries.push(this.changesets.addEntry(changesetId, treeFile.fileKey, {
            type: "replace-range",
            start: 0,
            end: treeFile.yaml.length,
            replacement: YAML.stringify(treeYaml, { lineWidth: 0 })
          }, "Unwrap widget in tree"));

          const wrapperNodeFileKey = `page/${pageId}/page-widget-tree-outline/node/${nodeId}.yaml`;
          const wrapperNodeFile = this.snapshotRepo.getFile(snapshotId, wrapperNodeFileKey);
          if (wrapperNodeFile) {
            entries.push(this.changesets.addEntry(changesetId, wrapperNodeFileKey, {
              type: "replace-range",
              start: 0,
              end: wrapperNodeFile.yaml.length,
              replacement: ""
            }, "Delete wrapper node file"));
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            unwrappedNodeId: nodeId,
            promotedChildNodeIds,
            changesetId,
            entries,
            preview,
            validation,
            applyResult,
            selection: {
              pageId,
              nodeId,
              fileKey: treeFile.fileKey
            }
          });
        }

        case "widget.action.list": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false) || strArg(args, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }
          const includePayload = boolArg(args, "includePayload", false);
          const limit = Math.max(1, Math.min(numArg(args, "limit", 200), 1000));
          const offset = Math.max(0, numArg(args, "offset", 0));

          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          if (!treeFile) {
            throw new Error("This command requires split tree mode (page/<id>/page-widget-tree-outline.yaml + node files). Run snapshots.ensureFresh then retry.");
          }

          const triggerPrefix = `page/${pageId}/page-widget-tree-outline/node/${nodeId}/trigger_actions/`;
          const triggerFiles = this.snapshotRepo
            .listFiles(snapshotId, triggerPrefix, 10_000)
            .filter((file) => /\/trigger_actions\/id-[^/]+(\.ya?ml)?$/i.test(file.fileKey));
          const actionFiles = this.snapshotRepo
            .listFiles(snapshotId, `${triggerPrefix}id-`, 10_000)
            .filter((file) => /\/trigger_actions\/id-[^/]+\/action\/id-[^/]+(\.ya?ml)?$/i.test(file.fileKey));
          const actionByTrigger = new Map<string, Array<{ fileKey: string; actionNodeId: string }>>();
          for (const file of actionFiles) {
            const match = file.fileKey.match(/\/trigger_actions\/(id-[^/]+)\/action\/(id-[^/.]+)(?:\.ya?ml)?$/i);
            if (!match) {
              continue;
            }
            const triggerId = match[1]!;
            const actionNodeId = match[2]!;
            const list = actionByTrigger.get(triggerId) ?? [];
            list.push({ fileKey: file.fileKey, actionNodeId });
            actionByTrigger.set(triggerId, list);
          }

          const actions: WidgetActionSummary[] = [];
          for (const triggerFile of triggerFiles) {
            const triggerId = triggerFile.fileKey.match(/\/trigger_actions\/(id-[^/.]+)(?:\.ya?ml)?$/i)?.[1];
            if (!triggerId) {
              continue;
            }
            const actionRows = actionByTrigger.get(triggerId) ?? [];
            if (actionRows.length === 0) {
              const parsed = parseTriggerAndActionFromYaml(triggerFile.yaml);
              actions.push({
                trigger: parsed.triggerType || triggerId.replace(/^id-/, ""),
                triggerNodeId: triggerId,
                triggerFileKey: triggerFile.fileKey,
                actionNodeId: parsed.actionNodeId,
                actionType: parsed.actionType,
                navigateTargetPageId: parsed.navigateTargetPageId,
                ...(includePayload ? { action: parsed.action } : {}),
                selection: { pageId, nodeId, fileKey: triggerFile.fileKey }
              } as WidgetActionSummary & { action?: Record<string, unknown> });
              continue;
            }
            for (const actionRow of actionRows) {
              const parsed = parseTriggerAndActionFromYaml(triggerFile.yaml, actionRow.fileKey);
              actions.push({
                trigger: parsed.triggerType || triggerId.replace(/^id-/, ""),
                triggerNodeId: triggerId,
                triggerFileKey: triggerFile.fileKey,
                actionNodeId: actionRow.actionNodeId,
                actionFileKey: actionRow.fileKey,
                actionType: parsed.actionType,
                navigateTargetPageId: parsed.navigateTargetPageId,
                ...(includePayload ? { action: parsed.action } : {}),
                selection: { pageId, nodeId, fileKey: actionRow.fileKey }
              } as WidgetActionSummary & { action?: Record<string, unknown> });
            }
          }

          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            nodeId,
            totalActions: actions.length,
            limit,
            offset,
            actions: actions.slice(offset, offset + limit)
          });
        }

        case "widget.action.get": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false) || strArg(args, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }
          const triggerArg = strArg(args, "trigger");
          const actionNodeId = strArg(args, "actionNodeId", false) || strArg(args, "actionId", false);
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          if (!treeFile) {
            throw new Error("This command requires split tree mode (page/<id>/page-widget-tree-outline.yaml + node files). Run snapshots.ensureFresh then retry.");
          }
          const triggerId = triggerArg.startsWith("id-") ? triggerArg : `id-${normalizeTriggerType(triggerArg)}`;
          const triggerFileKey = `page/${pageId}/page-widget-tree-outline/node/${nodeId}/trigger_actions/${triggerId}.yaml`;
          const triggerFile = this.snapshotRepo.getFile(snapshotId, triggerFileKey);
          if (!triggerFile) {
            throw new Error(`Trigger not found: ${triggerArg}`);
          }
          const actionPrefix = `page/${pageId}/page-widget-tree-outline/node/${nodeId}/trigger_actions/${triggerId}/action/`;
          const actionFiles = this.snapshotRepo
            .listFiles(snapshotId, actionPrefix, 200)
            .filter((file) => /\/action\/id-[^/]+(\.ya?ml)?$/i.test(file.fileKey));
          const selectedAction = actionNodeId
            ? actionFiles.find((file) => file.fileKey.includes(`/${actionNodeId}`) || file.fileKey.includes(`/${actionNodeId}.yaml`))
            : actionFiles[0];
          const parsedAction = parseTriggerAndActionFromYaml(triggerFile.yaml, selectedAction?.fileKey);
          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            nodeId,
            trigger: parsedAction.triggerType || triggerArg,
            triggerFileKey,
            actionNodeId: selectedAction
              ? (selectedAction.fileKey.match(/\/action\/(id-[^/.]+)(?:\.ya?ml)?$/i)?.[1] || parsedAction.actionNodeId)
              : parsedAction.actionNodeId,
            actionFileKey: selectedAction?.fileKey,
            action: parsedAction.action,
            selection: {
              pageId,
              nodeId,
              fileKey: selectedAction?.fileKey || triggerFileKey
            }
          });
        }

        case "widget.bindData": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false) || strArg(args, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }
          const key = strArg(args, "key");
          if (!Object.prototype.hasOwnProperty.call(args, "binding")) {
            throw new Error("Missing arg: binding");
          }
          const binding = args.binding;
          const nested = await this.run({
            cmd: "widget.set",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              nodeId,
              key,
              value: binding,
              mirrorMostRecent: boolArg(args, "mirrorMostRecent", true),
              preview: boolArg(args, "preview", true),
              apply: boolArg(args, "apply", false),
              remoteValidate: boolArg(args, "remoteValidate", false),
              changesetId: strArg(args, "changesetId", false),
              title: strArg(args, "title", false),
              intent: strArg(args, "intent", false),
              note: strArg(args, "note", false)
            }
          });
          if (!nested.ok) {
            return nested;
          }
          const data = asObject(nested.data);
          return this.ok(parsed.cmd, {
            snapshotId,
            nodeId,
            selector: data.selector,
            fileKey: data.fileKey,
            changesetId: data.changesetId,
            preview: data.preview,
            validation: data.validation,
            applyResult: data.applyResult,
            selection: {
              pageId: pageQuery,
              nodeId,
              fileKey: typeof data.fileKey === "string" ? data.fileKey : undefined
            }
          }, nested.warnings ?? []);
        }

        case "widget.bindAction": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false) || strArg(args, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }

          const mode = (strArg(args, "mode", false) || "upsert").toLowerCase() as ActionBindMode;
          if (!["upsert", "replace", "delete"].includes(mode)) {
            throw new Error("mode must be one of: upsert, replace, delete");
          }
          const triggerRaw = strArg(args, "trigger", false) || "ON_TAP";
          const triggerType = normalizeTriggerType(triggerRaw);
          const triggerId = triggerNodeId(triggerType);
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;

          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          if (!treeFile) {
            throw new Error("widget.bindAction requires split page-widget-tree-outline mode. Refresh/create split snapshot first.");
          }

          const triggerPrefix = `page/${pageId}/page-widget-tree-outline/node/${nodeId}/trigger_actions/${triggerId}`;
          const triggerFileKey = `${triggerPrefix}.yaml`;
          const actionPrefix = `${triggerPrefix}/action/`;
          const existingActionFiles = this.snapshotRepo
            .listFiles(snapshotId, actionPrefix, 200)
            .filter((file) => /\/action\/id-[^/]+(\.ya?ml)?$/i.test(file.fileKey));
          const existingTriggerFile = this.snapshotRepo.getFile(snapshotId, triggerFileKey);

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Bind ${triggerType} action for ${nodeId}`,
            strArg(args, "intent", false) || `Bind ${triggerType} action on ${resolved.page.name}:${nodeId}`
          ).changesetId;

          const entries: ChangesetEntry[] = [];
          let actionFileKey = "";
          let removed = false;

          if (mode === "delete") {
            if (existingTriggerFile) {
              entries.push(this.changesets.addEntry(changesetId, triggerFileKey, {
                type: "replace-range",
                start: 0,
                end: existingTriggerFile.yaml.length,
                replacement: ""
              }, "Delete trigger binding file"));
              removed = true;
            }
            for (const file of existingActionFiles) {
              entries.push(this.changesets.addEntry(changesetId, file.fileKey, {
                type: "replace-range",
                start: 0,
                end: file.yaml.length,
                replacement: ""
              }, "Delete trigger action file"));
              removed = true;
            }
          } else {
            const action = asObject(args.action);
            if (Object.keys(action).length === 0) {
              throw new Error("Missing object arg: action");
            }
            const requestedActionId = strArg(args, "actionNodeId", false) || strArg(args, "actionId", false);
            const existingActionId = existingActionFiles[0]?.fileKey.match(/\/action\/(id-[^/.]+)(?:\.ya?ml)?$/i)?.[1];
            const actionNodeId = ensureActionNodeId(requestedActionId || existingActionId);
            actionFileKey = `${triggerPrefix}/action/${actionNodeId}.yaml`;

            const triggerYaml = buildTriggerYaml({
              triggerType,
              actionNodeId,
              action
            });
            const actionYaml = buildActionYaml(actionNodeId, action);

            entries.push(this.changesets.addEntry(changesetId, triggerFileKey, {
              type: "replace-range",
              start: 0,
              end: existingTriggerFile?.yaml.length ?? 0,
              replacement: triggerYaml
            }, "Upsert trigger binding file"));

            const existingAction = this.snapshotRepo.getFile(snapshotId, actionFileKey);
            entries.push(this.changesets.addEntry(changesetId, actionFileKey, {
              type: "replace-range",
              start: 0,
              end: existingAction?.yaml.length ?? 0,
              replacement: actionYaml
            }, "Upsert trigger action file"));

            if (mode === "replace") {
              for (const file of existingActionFiles) {
                if (file.fileKey === actionFileKey) {
                  continue;
                }
                entries.push(this.changesets.addEntry(changesetId, file.fileKey, {
                  type: "replace-range",
                  start: 0,
                  end: file.yaml.length,
                  replacement: ""
                }, "Remove superseded trigger action file"));
              }
            }
          }

          if (entries.length === 0) {
            return this.ok(parsed.cmd, {
              snapshotId,
              trigger: triggerType,
              mode,
              triggerFileKey,
              actionFileKey: undefined,
              changesetId,
              entries: [],
              removed: false,
              preview: undefined,
              validation: undefined,
              applyResult: undefined,
              selection: {
                pageId,
                nodeId,
                fileKey: triggerFileKey
              }
            });
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;

          return this.ok(parsed.cmd, {
            snapshotId,
            trigger: triggerType,
            mode,
            triggerFileKey,
            actionFileKey: actionFileKey || undefined,
            changesetId,
            entries,
            removed,
            preview,
            validation,
            applyResult,
            selection: {
              pageId,
              nodeId,
              fileKey: actionFileKey || triggerFileKey
            }
          });
        }

        case "widget.set": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "name", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId");
          const key = strArg(args, "key", false);
          const patch = asObject(args.patch);
          const inlineText = strArg(args, "text", false);
          if (!key && !inlineText && Object.keys(patch).length === 0) {
            throw new Error("Provide key/value or text or patch for widget.set");
          }
          if (key && key.trim().toLowerCase().includes("parentnodeid")) {
            throw new Error("Reparenting is tree-level. Use widget.wrap instead of setting parentNodeId.");
          }
          const value = "value" in args ? args.value : inlineText;
          if (key && !("value" in args) && !inlineText) {
            throw new Error("Missing arg: value");
          }
          const mirrorMostRecent = boolArg(args, "mirrorMostRecent", true);
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);

          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const splitNodeFiles = this.snapshotRepo.listFiles(
            snapshotId,
            `page/${pageId}/page-widget-tree-outline/node/`,
            10_000
          );
          const splitNodeFile = splitNodeFiles.find((file) => {
            const normalized = file.fileKey.replace(/\.ya?ml$/i, "");
            return normalized.endsWith(`/node/${nodeId}`);
          });

          let targetFileKey = resolved.file.fileKey;
          let selector = "";
          let targetYaml = resolved.file.yaml;
          let baseSelector = "";
          let nodeLocalYaml = "";
          if (splitNodeFile) {
            targetFileKey = splitNodeFile.fileKey;
            targetYaml = splitNodeFile.yaml;
          } else {
            const parsedYaml = YAML.parse(resolved.file.yaml);
            const nodePath = findNodePathById(parsedYaml, nodeId);
            if (!nodePath) {
              throw new Error(`Widget node not found: ${nodeId}`);
            }
            baseSelector = selectorFromPath(nodePath);
            const nodeObj = getAtPath(parsedYaml, nodePath);
            nodeLocalYaml = YAML.stringify(nodeObj, { lineWidth: 0 });
          }

          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Set widget key ${nodeId}`,
            strArg(args, "intent", false) || `Set ${key} on widget ${nodeId} in ${resolved.page.name}`
          ).changesetId;

          let entry;
          let mirroredEntry;
          if (Object.keys(patch).length > 0) {
            let mergeSelector = "$.props";
            try {
              const effectiveYaml = splitNodeFile ? targetYaml : (nodeLocalYaml || targetYaml);
              const parsedTarget = YAML.parse(effectiveYaml);
              const type = typeof (parsedTarget as Record<string, unknown>)?.type === "string"
                ? String((parsedTarget as Record<string, unknown>).type).toLowerCase()
                : "";
              if (type === "text" && !("text" in patch)) {
                mergeSelector = "$.props.text";
              } else if (type === "button" && !("button" in patch)) {
                mergeSelector = "$.props.button";
              } else if (type === "textfield" && !("textField" in patch)) {
                mergeSelector = "$.props.textField";
              }
            } catch {
              // ignore and use default selector
            }
            selector = baseSelector ? `${baseSelector}${mergeSelector.slice(1)}` : mergeSelector;
            entry = this.changesets.addEntry(changesetId, targetFileKey, {
              type: "yaml-merge",
              selector,
              value: patch
            }, strArg(args, "note", false) || undefined);
          } else {
            const effectiveKey = key || "props.text.textValue.inputValue";
            const effectiveYaml = splitNodeFile ? targetYaml : (nodeLocalYaml || targetYaml);
            const localSelector = resolveWidgetSelector(effectiveYaml, effectiveKey);
            selector = baseSelector ? `${baseSelector}${localSelector.slice(1)}` : localSelector;
            entry = this.changesets.addEntry(changesetId, targetFileKey, {
              type: "jsonpath",
              selector,
              value
            }, strArg(args, "note", false) || undefined);

            if (mirrorMostRecent && selector.endsWith(".inputValue")) {
              const mirrorSelector = selector.replace(/\.inputValue$/, ".mostRecentInputValue");
              try {
                const parsedTarget = YAML.parse(targetYaml);
                if (getAtPath(parsedTarget, selectorToPath(mirrorSelector)) !== undefined) {
                  mirroredEntry = this.changesets.addEntry(changesetId, targetFileKey, {
                    type: "jsonpath",
                    selector: mirrorSelector,
                    value
                  }, "Auto-mirrored mostRecentInputValue");
                }
              } catch {
                // ignore optional mirroring if target cannot be parsed
              }
            }
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;
          return this.ok(parsed.cmd, {
            snapshotId,
            changesetId,
            fileKey: targetFileKey,
            nodeId,
            selector,
            entry,
            mirroredEntry,
            preview,
            validation,
            applyResult
          });
        }

        case "widget.delete": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId");
          const key = strArg(args, "key", false);
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }

          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const treeFileKey = `page/${pageId}/page-widget-tree-outline.yaml`;
          const treeFile = this.snapshotRepo.getFile(snapshotId, treeFileKey);
          const changesetId = strArg(args, "changesetId", false) || this.changesets.newChangeset(
            snapshotId,
            strArg(args, "title", false) || `Delete widget ${nodeId}`,
            strArg(args, "intent", false) || `Delete widget ${nodeId} from ${resolved.page.name}`
          ).changesetId;

          let fileKey = resolved.file.fileKey;
          let selector = "";
          let entry;
          const applyNow = boolArg(args, "apply", false);
          const remoteValidateOnApply = boolArg(args, "remoteValidate", false);

          if (key) {
            const splitNodeFiles = this.snapshotRepo.listFiles(
              snapshotId,
              `page/${pageId}/page-widget-tree-outline/node/`,
              10_000
            );
            const splitNodeFile = splitNodeFiles.find((file) => {
              const normalized = file.fileKey.replace(/\.ya?ml$/i, "");
              return normalized.endsWith(`/node/${nodeId}`);
            });

            const targetFile = splitNodeFile ?? resolved.file;
            const parsedTarget = YAML.parse(targetFile.yaml);
            let baseSelector = "";
            let localYaml = targetFile.yaml;
            if (!splitNodeFile) {
              const nodePath = findNodePathById(parsedTarget, nodeId);
              if (!nodePath) {
                throw new Error(`Widget node not found: ${nodeId}`);
              }
              baseSelector = selectorFromPath(nodePath);
              const nodeObj = getAtPath(parsedTarget, nodePath);
              localYaml = YAML.stringify(nodeObj, { lineWidth: 0 });
            }

            const localSelector = resolveWidgetSelector(localYaml, key);
            selector = baseSelector ? `${baseSelector}${localSelector.slice(1)}` : localSelector;
            const deleted = deleteAtPath(parsedTarget, selectorToPath(selector));
            if (!deleted) {
              throw new Error(`Property not found for delete at ${selector}`);
            }
            const replacement = YAML.stringify(parsedTarget, { lineWidth: 0 });
            fileKey = targetFile.fileKey;
            entry = this.changesets.addEntry(changesetId, fileKey, {
              type: "replace-range",
              start: 0,
              end: targetFile.yaml.length,
              replacement
            }, strArg(args, "note", false) || undefined);
          } else if (treeFile) {
            const treeYaml = YAML.parse(treeFile.yaml);
            const removed = removeNodeFromWidgetTree(treeYaml, keyFromNodeId(nodeId));
            if (!removed) {
              throw new Error(`Widget node not found in page widget tree: ${nodeId}`);
            }
            const replacement = YAML.stringify(treeYaml, { lineWidth: 0 });
            fileKey = treeFile.fileKey;
            selector = "$.node";
            entry = this.changesets.addEntry(changesetId, fileKey, {
              type: "replace-range",
              start: 0,
              end: treeFile.yaml.length,
              replacement
            }, strArg(args, "note", false) || undefined);
          } else {
            const parsedYaml = YAML.parse(resolved.file.yaml);
            const nodePath = findNodePathById(parsedYaml, nodeId);
            if (!nodePath || nodePath.length === 0) {
              throw new Error(`Widget node not found or cannot delete root: ${nodeId}`);
            }

            const parentPath = nodePath.slice(0, -1);
            const leaf = nodePath[nodePath.length - 1]!;
            const parent = getAtPath(parsedYaml, parentPath);
            if (Array.isArray(parent) && typeof leaf === "number") {
              parent.splice(leaf, 1);
            } else if (parent !== null && typeof parent === "object" && typeof leaf === "string") {
              delete (parent as Record<string, unknown>)[leaf];
            } else {
              throw new Error(`Unable to delete widget node at ${selectorFromPath(nodePath)}`);
            }
            const replacement = YAML.stringify(parsedYaml, { lineWidth: 0 });
            selector = selectorFromPath(nodePath);
            entry = this.changesets.addEntry(changesetId, resolved.file.fileKey, {
              type: "replace-range",
              start: 0,
              end: resolved.file.yaml.length,
              replacement
            }, strArg(args, "note", false) || undefined);
          }

          const preview = boolArg(args, "preview", true) ? this.changesets.preview(changesetId) : undefined;
          const validation = applyNow ? this.changesets.validate(changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(changesetId, true, { remoteValidate: remoteValidateOnApply })
            : undefined;
          return this.ok(parsed.cmd, {
            snapshotId,
            changesetId,
            fileKey,
            nodeId,
            selector,
            entry,
            preview,
            validation,
            applyResult
          });
        }

        case "intent.run": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const text = strArg(args, "text", false) || strArg(args, "prompt", false);
          if (!text) {
            throw new Error("Missing string arg: text (alias: prompt)");
          }
          const intent = parseIntentText(text);
          const apply = boolArg(args, "apply", false);
          const preview = boolArg(args, "preview", true);
          const remoteValidate = boolArg(args, "remoteValidate", false);
          const selection = asObject(args.selection);
          const rememberedSelection = this.selectionBySnapshot.get(snapshotId) ?? this.lastSelection;
          const selectedPageId =
            (typeof selection.pageId === "string" ? selection.pageId : "") ||
            rememberedSelection?.pageId ||
            "";
          const selectedNodeId =
            (typeof selection.nodeId === "string" ? selection.nodeId : "") ||
            rememberedSelection?.nodeId ||
            "";
          const ensureFresh = boolArg(args, "ensureFresh", true);

          let mappedCommand = "";
          let mappedArgs: Record<string, unknown> = {};
          let result: OrbitCommandResult | undefined;
          let clarify: IntentRunResult["clarify"];

          if (intent.kind === "unknown") {
            clarify = {
              message: "I could not parse that intent. Try commands like: 'list text fields on login', 'change brand.ai to James NC on login', 'duplicate id-Text_x on login'.",
              suggestedNext: {
                cmd: "intent.run",
                args: { text: "delete page login2" }
              }
            };
          } else if (intent.kind === "widgets.list") {
            mappedCommand = "widgets.list";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              ...(intent.type ? { type: intent.type } : {})
            };
          } else if (intent.kind === "widgets.find") {
            mappedCommand = "widgets.find";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              ...(intent.type ? { type: intent.type } : {}),
              ...(intent.nameContains ? { nameContains: intent.nameContains } : {}),
              ...(intent.textContains ? { textContains: intent.textContains } : {})
            };
          } else if (intent.kind === "widgets.findText") {
            mappedCommand = "widgets.findText";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              text: intent.text
            };
          } else if (intent.kind === "widget.getMany") {
            mappedCommand = "widget.getMany";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeIds: intent.nodeIds
            };
          } else if (intent.kind === "widget.setText") {
            if (intent.nodeId && intent.text) {
              mappedCommand = "widget.set";
              mappedArgs = {
                nameOrId: intent.page || selectedPageId,
                nodeId: intent.nodeId,
                text: intent.text,
                apply,
                preview,
                remoteValidate
              };
            } else if (intent.fromText && intent.toText) {
              const findResult = await this.run({
                cmd: "widgets.findText",
                snapshot: snapshotId,
                args: {
                  nameOrId: intent.page || selectedPageId,
                  text: intent.fromText,
                  limit: 20
                }
              });
              if (!findResult.ok) {
                result = findResult;
              } else {
                const data = asObject(findResult.data);
                const matches = Array.isArray(data.matches) ? data.matches.map((entry) => asObject(entry)) : [];
                if (matches.length === 0) {
                  clarify = { message: `No widget text matched '${intent.fromText}'.` };
                } else if (matches.length > 1) {
                  clarify = {
                    message: `Found ${matches.length} widgets with '${intent.fromText}'. Provide nodeId or selection.`,
                    choices: matches.slice(0, 6).map((entry) => ({
                      label: `${entry.nodeId ?? "unknown"} (${entry.type ?? "Widget"})`,
                      value: String(entry.nodeId ?? "")
                    }))
                  };
                } else {
                  const nodeId = typeof matches[0]!.nodeId === "string" ? matches[0]!.nodeId : "";
                  mappedCommand = "widget.set";
                  mappedArgs = {
                    nameOrId: intent.page || selectedPageId,
                    nodeId,
                    text: intent.toText,
                    apply,
                    preview,
                    remoteValidate
                  };
                }
              }
            }
          } else if (intent.kind === "widget.bindData") {
            mappedCommand = "widget.bindData";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId,
              key: intent.key,
              binding: intent.binding,
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "widget.wrap") {
            mappedCommand = "widget.wrap";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId,
              wrapperType: intent.wrapperType || "Row",
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "widget.unwrap") {
            mappedCommand = "widget.unwrap";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId,
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "widget.move") {
            mappedCommand = "widget.move";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId,
              beforeNodeId: intent.beforeNodeId,
              afterNodeId: intent.afterNodeId,
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "widget.moveMany") {
            mappedCommand = "widget.moveMany";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeIds: intent.nodeIds,
              parentNodeId: intent.parentNodeId,
              beforeNodeId: intent.beforeNodeId,
              afterNodeId: intent.afterNodeId,
              index: intent.index,
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "widget.insert") {
            mappedCommand = "widget.insert";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              type: intent.type,
              beforeNodeId: intent.beforeNodeId,
              afterNodeId: intent.afterNodeId,
              parentNodeId: intent.parentNodeId,
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "widget.deleteSubtree") {
            mappedCommand = "widget.deleteSubtree";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId,
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "widget.duplicate") {
            mappedCommand = "widget.duplicate";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId,
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "routes.upsert") {
            mappedCommand = "routes.upsert";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId,
              toPageNameOrId: intent.toPageNameOrId,
              trigger: intent.trigger || "ON_TAP",
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "routes.delete") {
            mappedCommand = "routes.delete";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId,
              trigger: intent.trigger || "ON_TAP",
              apply,
              preview,
              remoteValidate
            };
          } else if (intent.kind === "widget.action.list") {
            mappedCommand = "widget.action.list";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId
            };
          } else if (intent.kind === "widget.action.get") {
            mappedCommand = "widget.action.get";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              nodeId: intent.nodeId || selectedNodeId,
              trigger: intent.trigger || "ON_TAP"
            };
          } else if (intent.kind === "routes.listByPage") {
            mappedCommand = "routes.listByPage";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              direction: intent.direction || "both"
            };
          } else if (intent.kind === "routes.validate") {
            mappedCommand = "routes.validate";
            mappedArgs = {
              nameOrId: intent.page || selectedPageId,
              strict: intent.strict ?? false
            };
          } else if (intent.kind === "snapshots.ensureFresh") {
            mappedCommand = "snapshots.ensureFresh";
            mappedArgs = {
              staleMinutes: intent.staleMinutes,
              force: intent.force ?? false
            };
          } else if (intent.kind === "snapshots.refresh") {
            const mode = intent.mode ?? "incremental";
            mappedCommand = "snapshots.refresh";
            mappedArgs = {
              mode,
              fetchStrategy: mode === "full" ? "bulk" : "auto",
              maxFetch: mode === "full" ? 0 : 25,
              concurrency: 1,
              sleepMs: mode === "full" ? 250 : 250,
              listRetries: 2,
              listRetryBaseMs: 1500
            };
          } else if (intent.kind === "changeset.rollback") {
            mappedCommand = "changeset.rollback";
            mappedArgs = {
              ...(intent.changesetId ? { changesetId: intent.changesetId } : { latestApplied: true }),
              confirm: true,
              preview,
              apply,
              remoteValidate: boolArg(args, "remoteValidate", true)
            };
          } else if (intent.kind === "page.scaffold") {
            const resolvedRecipe = intent.recipe || strArg(args, "recipe", false);
            const resolvedName =
              intent.name ||
              strArg(args, "name", false) ||
              strArg(args, "newName", false) ||
              strArg(args, "pageName", false);
            if (!resolvedRecipe || !resolvedName) {
              clarify = {
                message:
                  "Missing scaffold details. Provide both recipe and page name. Example: intent.run { text:'create a login page called login2' }",
                choices: [
                  { label: "auth.login", value: "auth.login" },
                  { label: "auth.signup", value: "auth.signup" },
                  { label: "settings.basic", value: "settings.basic" },
                  { label: "list.cards.search", value: "list.cards.search" },
                  { label: "detail.basic", value: "detail.basic" }
                ],
                suggestedNext: {
                  cmd: "page.scaffold",
                  args: {
                    name: resolvedName || "newPage",
                    recipe: resolvedRecipe || "auth.login",
                    preview: true
                  }
                }
              };
            } else {
              mappedCommand = "page.scaffold";
              mappedArgs = {
                name: resolvedName,
                recipe: resolvedRecipe,
                ...(intent.params && Object.keys(intent.params).length > 0 ? { params: intent.params } : {}),
                wireActions: boolArg(args, "wireActions", false),
                preview,
                apply,
                remoteValidate
              };
            }
          } else if (intent.kind === "page.remove") {
            mappedCommand = "page.remove";
            mappedArgs = {
              nameOrId: intent.nameOrId,
              apply,
              preview,
              ensureFresh,
              force: boolArg(args, "force", false)
            };
          } else if (intent.kind === "page.clone") {
            mappedCommand = "page.clone";
            mappedArgs = {
              nameOrId: intent.nameOrId,
              newName: intent.newName,
              apply,
              preview
            };
          }

          if (!result && mappedCommand) {
            const mappedNodeId = typeof mappedArgs.nodeId === "string" ? mappedArgs.nodeId : "";
            if (!mappedArgs.nameOrId && mappedNodeId) {
              const inferredPageId = inferPageIdForNodeId(this.snapshotRepo, snapshotId, mappedNodeId);
              if (inferredPageId) {
                mappedArgs.nameOrId = inferredPageId;
              }
            }

            if (
              !mappedArgs.nameOrId &&
              !["widgets.findText", "snapshots.ensureFresh", "snapshots.refresh", "changeset.rollback", "page.scaffold"].includes(
                mappedCommand
              )
            ) {
              clarify = {
                message: "Missing page context. Provide page name/id or include selection.pageId. Example: intent.run { text:'list widgets on login' }."
              };
            } else if (
              !mappedArgs.nodeId &&
              [
                "widget.wrap",
                "widget.unwrap",
                "widget.move",
                "widget.deleteSubtree",
                "widget.duplicate",
                "widget.bindData",
                "routes.upsert",
                "routes.delete",
                "widget.action.list",
                "widget.action.get"
              ].includes(mappedCommand)
            ) {
              clarify = {
                message: "Missing widget context. Provide nodeId or include selection.nodeId. Example: intent.run { text:'unwrap id-Row_x on login' }."
              };
            } else {
              const writeCommands = new Set([
                "widget.set",
                "widget.bindData",
                "widget.wrap",
                "widget.unwrap",
                "widget.move",
                "widget.moveMany",
                "widget.insert",
                "widget.deleteSubtree",
                "widget.duplicate",
                "widget.bindAction",
                "routes.upsert",
                "routes.delete",
                "changeset.rollback",
                "page.scaffold"
              ]);
              if (ensureFresh && writeCommands.has(mappedCommand)) {
                const ensureFreshResult = await this.run({
                  cmd: "snapshots.ensureFresh",
                  snapshot: snapshotId,
                  args: {
                    staleMinutes: args.staleMinutes,
                    mode: strArg(args, "freshMode", false) || "incremental"
                  }
                });
                if (!ensureFreshResult.ok) {
                  result = ensureFreshResult;
                }
              }
              if (!result) {
              result = await this.run({
                cmd: mappedCommand,
                snapshot: snapshotId,
                args: mappedArgs
              });
              }
            }
          }

          if (!result && !clarify) {
            clarify = { message: "Unable to map intent to a command." };
          }

          return this.ok(parsed.cmd, {
            snapshotId,
            mappedCommand: mappedCommand || undefined,
            mappedArgs: Object.keys(mappedArgs).length > 0 ? mappedArgs : undefined,
            clarify,
            result: result?.data,
            resultOk: result?.ok
          });
        }

        case "selection.get": {
          const snapshotId = strArg(args, "snapshotId", false) || parsed.snapshot || undefined;
          const selected = snapshotId
            ? this.selectionBySnapshot.get(snapshotId) || this.lastSelection
            : this.lastSelection;
          return this.ok(parsed.cmd, {
            selection: selected || null
          });
        }

        case "selection.clear": {
          const snapshotId = strArg(args, "snapshotId", false) || parsed.snapshot || undefined;
          if (snapshotId) {
            this.selectionBySnapshot.delete(snapshotId);
            if (this.lastSelection?.snapshotId === snapshotId) {
              this.lastSelection = undefined;
            }
          } else {
            this.selectionBySnapshot.clear();
            this.lastSelection = undefined;
          }
          return this.ok(parsed.cmd, {
            cleared: snapshotId ? { snapshotId } : { all: true }
          });
        }

        case "routes.list": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          return this.ok(parsed.cmd, {
            snapshotId,
            routes: this.indexRepo.listRoutes(snapshotId)
          }, this.snapshotDataWarnings(snapshotId));
        }

        case "routes.listByPage": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const directionRaw = (strArg(args, "direction", false) || "both").toLowerCase();
          const direction = directionRaw === "outgoing" || directionRaw === "incoming" ? directionRaw : "both";
          const includeWidgetActions = boolArg(args, "includeWidgetActions", true);

          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          if (!treeFile) {
            throw new Error(
              "This command requires split tree mode (page/<id>/page-widget-tree-outline.yaml + node files). Run snapshots.ensureFresh then retry."
            );
          }

          const pageCatalog = collectPagesForSnapshot(this.snapshotRepo, this.indexRepo, snapshotId, true, true).pages;
          const symbolToPageId = new Map<string, string>();
          const normalizedToPageId = new Map<string, string>();
          for (const row of pageCatalog) {
            const symbolId = row.symbolId || synthesizePageSymbolId(row.pageId);
            symbolToPageId.set(symbolId, row.pageId);
            normalizedToPageId.set(symbolId.replace(/^page:/, ""), row.pageId);
          }
          const toPageIdFromSymbol = (symbolId: string): string => {
            const direct = symbolToPageId.get(symbolId);
            if (direct) {
              return direct;
            }
            if (symbolId.startsWith("page:")) {
              const normalized = symbolId.slice("page:".length);
              const mapped = normalizedToPageId.get(normalized);
              if (mapped) {
                return mapped;
              }
            }
            return symbolId;
          };

          const routes: Array<{
            fromPageId: string;
            toPageId: string;
            fileKey: string;
            sourceNodeId?: string;
            trigger?: string;
            actionFileKey?: string;
          }> = [];
          const seen = new Set<string>();
          const addRouteRow = (row: {
            fromPageId: string;
            toPageId: string;
            fileKey: string;
            sourceNodeId?: string;
            trigger?: string;
            actionFileKey?: string;
          }) => {
            const isOutgoing = row.fromPageId === pageId;
            const isIncoming = row.toPageId === pageId;
            if (direction === "outgoing" && !isOutgoing) {
              return;
            }
            if (direction === "incoming" && !isIncoming) {
              return;
            }
            if (direction === "both" && !isOutgoing && !isIncoming) {
              return;
            }
            const key = [
              row.fromPageId,
              row.toPageId,
              row.fileKey,
              row.sourceNodeId || "",
              row.trigger || "",
              row.actionFileKey || ""
            ].join("|");
            if (seen.has(key)) {
              return;
            }
            seen.add(key);
            routes.push(row);
          };

          const indexRows = this.indexRepo
            .listEdges(snapshotId, "nav")
            .map((edge) => ({
              fromPageId: toPageIdFromSymbol(edge.fromId),
              toPageId: toPageIdFromSymbol(edge.toId),
              fileKey: edge.fileKey
            }));
          for (const row of indexRows) {
            addRouteRow(row);
          }

          if (includeWidgetActions) {
            const triggerFiles = this.snapshotRepo
              .listFiles(snapshotId, "page/", 10_000)
              .filter((file) =>
                /^page\/id-[^/]+\/page-widget-tree-outline\/node\/id-[^/]+\/trigger_actions\/id-[^/]+(\.ya?ml)?$/i.test(
                  file.fileKey
                )
              );
            for (const triggerFile of triggerFiles) {
              const match = triggerFile.fileKey.match(
                /^page\/(id-[^/]+)\/page-widget-tree-outline\/node\/(id-[^/]+)\/trigger_actions\/(id-[^/.]+)(?:\.ya?ml)?$/i
              );
              if (!match) {
                continue;
              }
              const fromPageId = match[1]!;
              const nodeId = match[2]!;
              const triggerNodeId = match[3]!;
              const triggerBase = triggerFile.fileKey.replace(/\.ya?ml$/i, "");
              const actionPrefix = `${triggerBase}/action/`;
              const actionFile = this.snapshotRepo
                .listFiles(snapshotId, actionPrefix, 200)
                .find((file) => /\/action\/id-[^/]+(\.ya?ml)?$/i.test(file.fileKey));
              const parsedAction = parseTriggerAndActionFromYaml(triggerFile.yaml, actionFile?.fileKey);
              if (!parsedAction.navigateTargetPageId) {
                continue;
              }
              addRouteRow({
                fromPageId,
                toPageId: parsedAction.navigateTargetPageId,
                fileKey: triggerFile.fileKey,
                sourceNodeId: nodeId,
                trigger: parsedAction.triggerType || triggerNodeId.replace(/^id-/, ""),
                actionFileKey: actionFile?.fileKey
              });
            }
          }

          routes.sort((a, b) => {
            const aKey = `${a.fromPageId}|${a.toPageId}|${a.sourceNodeId || ""}|${a.trigger || ""}|${a.fileKey}`;
            const bKey = `${b.fromPageId}|${b.toPageId}|${b.sourceNodeId || ""}|${b.trigger || ""}|${b.fileKey}`;
            return aKey.localeCompare(bKey);
          });

          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            direction,
            totalRoutes: routes.length,
            routes,
            selection: {
              pageId,
              nodeId: pageId,
              fileKey: resolved.page.fileKey
            }
          });
        }

        case "routes.validate": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const strict = boolArg(args, "strict", false);
          const includeOrphans = boolArg(args, "includeOrphans", true);
          const resolved = this.resolvePage(snapshotId, pageQuery);
          if (!resolved) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const pageId = pageIdFromFileKey(resolved.page.fileKey) ?? resolved.page.name;
          const treeFile = this.snapshotRepo.getFile(snapshotId, `page/${pageId}/page-widget-tree-outline.yaml`);
          if (!treeFile) {
            throw new Error(
              "This command requires split tree mode (page/<id>/page-widget-tree-outline.yaml + node files). Run snapshots.ensureFresh then retry."
            );
          }

          const pageCatalog = collectPagesForSnapshot(this.snapshotRepo, this.indexRepo, snapshotId, true, true).pages;
          const pageIdSet = new Set(pageCatalog.map((row) => row.pageId));
          const symbolToPageId = new Map<string, string>();
          const normalizedToPageId = new Map<string, string>();
          for (const row of pageCatalog) {
            const symbolId = row.symbolId || synthesizePageSymbolId(row.pageId);
            symbolToPageId.set(symbolId, row.pageId);
            normalizedToPageId.set(symbolId.replace(/^page:/, ""), row.pageId);
          }
          const toPageIdFromSymbol = (symbolId: string): string => {
            const direct = symbolToPageId.get(symbolId);
            if (direct) {
              return direct;
            }
            const normalized = symbolId.startsWith("page:") ? symbolId.slice("page:".length) : symbolId;
            return normalizedToPageId.get(normalized) || symbolId;
          };

          const issues: Array<{
            code:
              | "route.target_missing"
              | "route.self_loop"
              | "route.trigger_missing_action"
              | "route.action_missing_trigger"
              | "route.orphan_action_file"
              | "route.unindexed_navigation";
            severity: "error" | "warning";
            message: string;
            fileKey?: string;
          }> = [];

          const triggerFiles = this.snapshotRepo
            .listFiles(snapshotId, `page/${pageId}/page-widget-tree-outline/node/`, 10_000)
            .filter((file) =>
              /^page\/id-[^/]+\/page-widget-tree-outline\/node\/id-[^/]+\/trigger_actions\/id-[^/]+(\.ya?ml)?$/i.test(
                file.fileKey
              )
            );
          const actionFiles = this.snapshotRepo
            .listFiles(snapshotId, `page/${pageId}/page-widget-tree-outline/node/`, 10_000)
            .filter((file) =>
              /^page\/id-[^/]+\/page-widget-tree-outline\/node\/id-[^/]+\/trigger_actions\/id-[^/]+\/action\/id-[^/]+(\.ya?ml)?$/i.test(
                file.fileKey
              )
            );

          const triggerByNodeAndTrigger = new Map<string, { fileKey: string; expectedActionNodeId?: string; targetPageId?: string }>();
          for (const triggerFile of triggerFiles) {
            const match = triggerFile.fileKey.match(
              /^page\/(id-[^/]+)\/page-widget-tree-outline\/node\/(id-[^/]+)\/trigger_actions\/(id-[^/.]+)(?:\.ya?ml)?$/i
            );
            if (!match) {
              continue;
            }
            const nodeId = match[2]!;
            const triggerId = match[3]!;
            const parsedTrigger = parseTriggerAndActionFromYaml(triggerFile.yaml);
            const triggerKey = `${nodeId}|${triggerId}`;
            triggerByNodeAndTrigger.set(triggerKey, {
              fileKey: triggerFile.fileKey,
              expectedActionNodeId: parsedTrigger.actionNodeId,
              targetPageId: parsedTrigger.navigateTargetPageId
            });

            if (parsedTrigger.navigateTargetPageId) {
              if (!pageIdSet.has(parsedTrigger.navigateTargetPageId)) {
                issues.push(
                  makeRouteIssue(
                    "route.target_missing",
                    `Navigation target page not found: ${parsedTrigger.navigateTargetPageId}`,
                    triggerFile.fileKey
                  )
                );
              }
              if (strict && parsedTrigger.navigateTargetPageId === pageId) {
                issues.push(
                  makeRouteIssue(
                    "route.self_loop",
                    `Self-loop route detected on page ${pageId}`,
                    triggerFile.fileKey
                  )
                );
              }
            }
          }

          const actionByNodeAndTrigger = new Map<string, Array<{ fileKey: string; actionNodeId: string }>>();
          for (const actionFile of actionFiles) {
            const match = actionFile.fileKey.match(
              /^page\/(id-[^/]+)\/page-widget-tree-outline\/node\/(id-[^/]+)\/trigger_actions\/(id-[^/]+)\/action\/(id-[^/.]+)(?:\.ya?ml)?$/i
            );
            if (!match) {
              continue;
            }
            const nodeId = match[2]!;
            const triggerId = match[3]!;
            const actionNodeId = match[4]!;
            const key = `${nodeId}|${triggerId}`;
            const list = actionByNodeAndTrigger.get(key) ?? [];
            list.push({ fileKey: actionFile.fileKey, actionNodeId });
            actionByNodeAndTrigger.set(key, list);
          }

          for (const [key, trigger] of triggerByNodeAndTrigger.entries()) {
            const actionRows = actionByNodeAndTrigger.get(key) ?? [];
            if (trigger.expectedActionNodeId) {
              const expectedExists = actionRows.some((row) => row.actionNodeId === trigger.expectedActionNodeId);
              if (!expectedExists) {
                issues.push(
                  makeRouteIssue(
                    "route.trigger_missing_action",
                    `Trigger is missing expected action file ${trigger.expectedActionNodeId}`,
                    trigger.fileKey
                  )
                );
              }
            }
          }

          for (const [key, actionRows] of actionByNodeAndTrigger.entries()) {
            const trigger = triggerByNodeAndTrigger.get(key);
            if (!trigger) {
              for (const actionRow of actionRows) {
                issues.push(
                  makeRouteIssue(
                    "route.action_missing_trigger",
                    "Action file has no matching trigger file.",
                    actionRow.fileKey
                  )
                );
                if (includeOrphans) {
                  issues.push(
                    makeRouteIssue(
                      "route.orphan_action_file",
                      "Orphan action file is not connected to a valid trigger.",
                      actionRow.fileKey,
                      "warning"
                    )
                  );
                }
              }
              continue;
            }
            if (includeOrphans && trigger.expectedActionNodeId) {
              for (const actionRow of actionRows) {
                if (actionRow.actionNodeId !== trigger.expectedActionNodeId) {
                  issues.push(
                    makeRouteIssue(
                      "route.orphan_action_file",
                      `Action file ${actionRow.actionNodeId} does not match trigger root action ${trigger.expectedActionNodeId}.`,
                      actionRow.fileKey,
                      "warning"
                    )
                  );
                }
              }
            }
          }

          const sourceSymbolId = resolved.page.symbolId || synthesizePageSymbolId(pageId);
          const indexedTargets = new Set(
            this.indexRepo
              .listOutgoingEdges(snapshotId, "nav", sourceSymbolId)
              .map((edge) => toPageIdFromSymbol(edge.toId))
          );
          for (const trigger of triggerByNodeAndTrigger.values()) {
            if (!trigger.targetPageId) {
              continue;
            }
            if (!indexedTargets.has(trigger.targetPageId)) {
              issues.push(
                makeRouteIssue(
                  "route.unindexed_navigation",
                  `Navigation action to ${trigger.targetPageId} is not present in indexed route edges.`,
                  trigger.fileKey,
                  "warning"
                )
              );
            }
          }

          const errorCount = issues.filter((issue) => issue.severity === "error").length;
          const warningCount = issues.length - errorCount;
          const summaryByCode: Record<string, number> = {};
          for (const issue of issues) {
            summaryByCode[issue.code] = (summaryByCode[issue.code] ?? 0) + 1;
          }
          return this.ok(parsed.cmd, {
            snapshotId,
            page: {
              pageId,
              name: resolved.page.name,
              fileKey: resolved.page.fileKey
            },
            valid: errorCount === 0,
            issues,
            summary: {
              totalIssues: issues.length,
              errorCount,
              warningCount,
              byCode: summaryByCode
            },
            selection: {
              pageId,
              nodeId: pageId,
              fileKey: resolved.page.fileKey
            }
          });
        }

        case "routes.upsert": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const routeArgs = args as RouteUpsertArgs;
          const pageQuery =
            strArg(routeArgs as Record<string, unknown>, "nameOrId", false) ||
            strArg(routeArgs as Record<string, unknown>, "pageId", false) ||
            strArg(routeArgs as Record<string, unknown>, "id", false) ||
            strArg(routeArgs as Record<string, unknown>, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(routeArgs as Record<string, unknown>, "nodeId", false) ||
            strArg(routeArgs as Record<string, unknown>, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }
          const toPageNameOrId = strArg(routeArgs as Record<string, unknown>, "toPageNameOrId", false) ||
            strArg(routeArgs as Record<string, unknown>, "toPage", false);
          if (!toPageNameOrId) {
            throw new Error("Missing string arg: toPageNameOrId (alias: toPage)");
          }
          const source = this.resolvePage(snapshotId, pageQuery);
          if (!source) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const target = this.resolvePage(snapshotId, toPageNameOrId);
          if (!target) {
            throw new Error(`Target page not found: ${toPageNameOrId}`);
          }
          const sourcePageId = pageIdFromFileKey(source.page.fileKey) ?? source.page.name;
          const toPageId = pageIdFromFileKey(target.page.fileKey) ?? target.page.name;
          const action = buildNavigateAction({
            toPageId,
            allowBack: routeArgs.allowBack,
            navigateBack: routeArgs.navigateBack,
            passedParameters: asObject(routeArgs.passedParameters)
          });

          const nested = await this.run({
            cmd: "widget.bindAction",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              nodeId,
              trigger: strArg(routeArgs as Record<string, unknown>, "trigger", false) || "ON_TAP",
              action,
              mode: "upsert",
              preview: boolArg(routeArgs as Record<string, unknown>, "preview", true),
              apply: boolArg(routeArgs as Record<string, unknown>, "apply", false),
              remoteValidate: boolArg(routeArgs as Record<string, unknown>, "remoteValidate", false),
              changesetId: strArg(routeArgs as Record<string, unknown>, "changesetId", false),
              title: strArg(routeArgs as Record<string, unknown>, "title", false) || `Route ${nodeId} -> ${target.page.name}`,
              intent: strArg(routeArgs as Record<string, unknown>, "intent", false) || `Route ${nodeId} to ${target.page.name}`
            }
          });
          if (!nested.ok) {
            return nested;
          }
          const data = asObject(nested.data);
          return this.ok(parsed.cmd, {
            snapshotId,
            route: {
              fromPageId: sourcePageId,
              fromNodeId: nodeId,
              trigger: data.trigger,
              toPageId
            },
            changesetId: data.changesetId,
            preview: data.preview,
            validation: data.validation,
            applyResult: data.applyResult
          }, nested.warnings ?? []);
        }

        case "routes.delete": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const pageQuery =
            strArg(args, "nameOrId", false) ||
            strArg(args, "pageId", false) ||
            strArg(args, "id", false) ||
            strArg(args, "fileKey", false);
          if (!pageQuery) {
            throw new Error("Missing page selector: nameOrId/pageId/id/fileKey");
          }
          const nodeId = strArg(args, "nodeId", false) || strArg(args, "widgetId", false);
          if (!nodeId) {
            throw new Error("Missing string arg: nodeId (alias: widgetId)");
          }
          const source = this.resolvePage(snapshotId, pageQuery);
          if (!source) {
            throw new Error(`Page not found: ${pageQuery}`);
          }
          const sourcePageId = pageIdFromFileKey(source.page.fileKey) ?? source.page.name;
          const nested = await this.run({
            cmd: "widget.bindAction",
            snapshot: snapshotId,
            args: {
              nameOrId: pageQuery,
              nodeId,
              trigger: strArg(args, "trigger", false) || "ON_TAP",
              mode: "delete",
              preview: boolArg(args, "preview", true),
              apply: boolArg(args, "apply", false),
              remoteValidate: boolArg(args, "remoteValidate", false),
              changesetId: strArg(args, "changesetId", false),
              title: strArg(args, "title", false) || `Remove route from ${nodeId}`,
              intent: strArg(args, "intent", false) || `Remove route binding on ${nodeId}`
            }
          });
          if (!nested.ok) {
            return nested;
          }
          const data = asObject(nested.data);
          return this.ok(parsed.cmd, {
            snapshotId,
            removed: Boolean(data.removed),
            routeContext: {
              fromPageId: sourcePageId,
              fromNodeId: nodeId,
              trigger: data.trigger
            },
            changesetId: data.changesetId,
            preview: data.preview,
            validation: data.validation,
            applyResult: data.applyResult
          }, nested.warnings ?? []);
        }

        case "settings.get": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const area = strArg(args, "area", false) || "project";
          const files = this.snapshotRepo.listFiles(snapshotId, undefined, 15_000);
          const tokens: Record<string, string[]> = {
            theme: ["theme", "style"],
            appState: ["app_state", "appstate", "state"],
            api: ["api", "backend", "endpoint"],
            dataModels: ["model", "schema", "data"],
            integrations: ["integrations", "plugin", "firebase"],
            iap: ["iap", "purchase", "billing"],
            general: ["settings", "config", "general"],
            authPushDeploy: ["auth", "push", "deploy", "notification"],
            platformSetup: ["android", "ios", "web", "macos", "windows", "linux"]
          };
          const areaTokens = tokens[area] ?? [area.toLowerCase()];

          const matched = files.filter((file) => areaTokens.some((token) => file.fileKey.toLowerCase().includes(token))).slice(0, 12);

          return this.ok(parsed.cmd, {
            area,
            files: matched.map((file) => ({
              fileKey: file.fileKey,
              excerpt: clip(file.yaml, 500)
            }))
          });
        }

        case "summarize.page": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const query = strArg(args, "nameOrId");
          const subtree = strArg(args, "subtreePathOrNodeId", false);
          const resolved = this.resolvePage(snapshotId, query);
          if (!resolved) {
            throw new Error(`Page not found: ${query}`);
          }
          const file = resolved.file;

          const parsedYaml = YAML.parse(file.yaml);
          const targetNode = subtree ? getAtPath(parsedYaml, selectorToPath(subtree)) : parsedYaml;
          const summary = summarizeNode(targetNode);

          return this.ok(parsed.cmd, {
            page: resolved.page.name,
            fileKey: file.fileKey,
            scope: subtree || "$",
            summary,
            excerpt: clip(YAML.stringify(targetNode, { lineWidth: 0 }), 900)
          });
        }

        case "summarize.component": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const query = strArg(args, "nameOrId");
          const symbol = this.indexRepo.findSymbols(snapshotId, "component", query)[0];
          if (!symbol) {
            throw new Error(`Component not found: ${query}`);
          }

          const file = this.snapshotRepo.getFile(snapshotId, symbol.fileKey);
          if (!file) {
            throw new Error(`File missing for component ${query}`);
          }

          const parsedYaml = YAML.parse(file.yaml);
          const summary = summarizeNode(parsedYaml);

          return this.ok(parsed.cmd, {
            component: symbol.name,
            fileKey: file.fileKey,
            summary,
            excerpt: clip(file.yaml, 900)
          });
        }

        case "summarize.project": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const files = this.snapshotRepo.listFiles(snapshotId, undefined, 15_000);
          const symbols = this.indexRepo.listSymbols(snapshotId);
          return this.ok(parsed.cmd, {
            snapshotId,
            counts: {
              files: files.length,
              pages: symbols.filter((s) => s.kind === "page").length,
              components: symbols.filter((s) => s.kind === "component").length,
              actions: symbols.filter((s) => s.kind === "action").length,
              widgets: symbols.filter((s) => s.kind === "widget").length
            },
            topFiles: files
              .map((file) => ({ fileKey: file.fileKey, size: file.yaml.length }))
              .sort((a, b) => b.size - a.size)
              .slice(0, 8)
          }, this.snapshotDataWarnings(snapshotId));
        }

        case "changeset.new": {
          const snapshotId = this.requireSnapshotId(parsed, args);
          const title = strArg(args, "title");
          const intent = strArg(args, "intent");
          const created = this.changesets.newChangeset(snapshotId, title, intent);
          return this.ok(parsed.cmd, { changeset: created });
        }

        case "changeset.add": {
          const changesetId = strArg(args, "changesetId");
          const fileKey = strArg(args, "fileKey");
          const patchSpec = normalizePatchSpec(args.patchSpec);
          const note = strArg(args, "note", false) || undefined;
          const entry = this.changesets.addEntry(changesetId, fileKey, patchSpec, note);
          return this.ok(parsed.cmd, { entry });
        }

        case "changeset.preview": {
          const changesetId = strArg(args, "changesetId");
          const preview = this.changesets.preview(changesetId);
          return this.ok(parsed.cmd, preview);
        }

        case "changeset.validate": {
          const changesetId = strArg(args, "changesetId");
          const validation = this.changesets.validate(changesetId);
          return this.ok(parsed.cmd, validation);
        }

        case "changeset.apply": {
          const changesetId = strArg(args, "changesetId");
          const confirm = boolArg(args, "confirm");
          const remoteValidate = boolArg(args, "remoteValidate", true);
          const result = await this.changesets.apply(changesetId, confirm, { remoteValidate });
          return this.ok(parsed.cmd, result);
        }

        case "changeset.applySafe": {
          const changesetId = strArg(args, "changesetId");
          const confirm = boolArg(args, "confirm");
          if (!confirm) {
            throw new Error("changeset.applySafe requires confirm=true");
          }
          const remoteValidate = boolArg(args, "remoteValidate", true);
          const retryWithoutRemoteValidate = boolArg(args, "retryWithoutRemoteValidate", true);
          const rateLimitRetries = clampInt(numArg(args, "rateLimitRetries", 3), 0, 6);
          const rateLimitBaseMs = clampInt(numArg(args, "rateLimitBaseMs", 1500), 250, 60_000);
          const rateLimitMaxWaitMs = clampInt(numArg(args, "rateLimitMaxWaitMs", 90_000), 1_000, 300_000);
          const exportOnFailure = boolArg(args, "exportOnFailure", true);

          const preview = this.changesets.preview(changesetId);
          const validation = this.changesets.validate(changesetId);
          if (!validation.valid) {
            const out: ApplySafeResult = {
              applied: false,
              phase: "validate",
              attempts: [],
              reason: "changeset.validate failed",
              preview,
              validation
            };
            return this.ok(parsed.cmd, out);
          }

          const attempts: ApplySafeResult["attempts"] = [];
          const firstAttempt = await this.changesets.apply(changesetId, confirm, { remoteValidate });
          attempts.push({
            phase: "initial",
            remoteValidate,
            applied: firstAttempt.applied,
            reason: firstAttempt.reason
          });
          if (firstAttempt.applied) {
            const out: ApplySafeResult = {
              applied: true,
              phase: "apply",
              attempts,
              rateLimited: false,
              preview,
              validation,
              applyResult: firstAttempt
            };
            return this.ok(parsed.cmd, out);
          }

          let latestAttempt = firstAttempt;
          if (retryWithoutRemoteValidate && remoteValidate && firstAttempt.reason?.toLowerCase().includes("remote validation failed")) {
            const secondAttempt = await this.changesets.apply(changesetId, confirm, { remoteValidate: false });
            attempts.push({
              phase: "remote-validate-retry",
              remoteValidate: false,
              applied: secondAttempt.applied,
              reason: secondAttempt.reason
            });
            if (secondAttempt.applied) {
              const out: ApplySafeResult = {
                applied: true,
                phase: "apply",
                attempts,
                rateLimited: false,
                preview,
                validation,
                applyResult: secondAttempt
              };
              return this.ok(parsed.cmd, out);
            }
            latestAttempt = secondAttempt;
          }

          let waitedTotalMs = 0;
          for (let retry = 1; latestAttempt.rateLimited && retry <= rateLimitRetries; retry += 1) {
            const retryAfterMs =
              typeof latestAttempt.retryAfterSeconds === "number" && latestAttempt.retryAfterSeconds > 0
                ? latestAttempt.retryAfterSeconds * 1000
                : 0;
            const exponentialMs = Math.min(rateLimitBaseMs * 2 ** (retry - 1), 60_000);
            const requestedWaitMs = Math.max(retryAfterMs, exponentialMs);
            const remainingBudgetMs = Math.max(0, rateLimitMaxWaitMs - waitedTotalMs);
            const waitForMs = Math.min(requestedWaitMs, remainingBudgetMs);
            if (waitForMs <= 0) {
              break;
            }

            await waitMs(waitForMs);
            waitedTotalMs += waitForMs;

            const retryAttempt = await this.changesets.apply(changesetId, confirm, { remoteValidate: false });
            attempts.push({
              phase: "rate-limit-retry",
              remoteValidate: false,
              applied: retryAttempt.applied,
              reason: retryAttempt.reason,
              waitMs: waitForMs
            });

            latestAttempt = retryAttempt;
            if (retryAttempt.applied) {
              const out: ApplySafeResult = {
                applied: true,
                phase: "apply",
                attempts,
                rateLimited: false,
                preview,
                validation,
                applyResult: retryAttempt
              };
              return this.ok(parsed.cmd, out);
            }
          }

          const retryAfterSeconds =
            typeof latestAttempt.retryAfterSeconds === "number" && latestAttempt.retryAfterSeconds > 0
              ? latestAttempt.retryAfterSeconds
              : Math.max(1, Math.round(rateLimitBaseMs / 1000));
          const nextRetryAt = latestAttempt.rateLimited
            ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
            : undefined;

          let manualPayload = latestAttempt.manualPayload;
          if (!manualPayload && exportOnFailure) {
            try {
              manualPayload = this.changesets.exportManualPayload(changesetId);
            } catch {
              // ignore
            }
          }
          const out: ApplySafeResult = {
            applied: false,
            phase: "apply",
            attempts,
            reason: latestAttempt.reason,
            rateLimited: latestAttempt.rateLimited === true,
            retryAfterSeconds: latestAttempt.rateLimited ? retryAfterSeconds : undefined,
            nextRetryAt,
            preview,
            validation,
            applyResult: latestAttempt,
            manualPayload,
            instructions: latestAttempt.instructions
          };
          return this.ok(parsed.cmd, out);
        }

        case "changeset.revert":
          return await this.run({
            cmd: "changeset.rollback",
            snapshot: parsed.snapshot,
            args
          });

        case "changeset.rollback": {
          const confirm = boolArg(args, "confirm");
          if (!confirm) {
            throw new Error("changeset.rollback requires confirm=true");
          }

          const explicitChangesetId = strArg(args, "changesetId", false);
          const latestApplied = boolArg(args, "latestApplied", false);
          const explicitSnapshotId = strArg(args, "snapshotId", false);
          const applyNow = boolArg(args, "apply", false);
          const remoteValidate = boolArg(args, "remoteValidate", true);

          let sourceChangesetId = explicitChangesetId;
          if (!sourceChangesetId) {
            if (!latestApplied) {
              throw new Error("Provide changesetId or set latestApplied=true with snapshotId/context.");
            }
            const latestSnapshotId = explicitSnapshotId || this.requireSnapshotId(parsed, args);
            const latest = this.changesets.getLatestApplied(latestSnapshotId);
            if (!latest) {
              throw new Error(`No applied changeset found for snapshot ${latestSnapshotId}`);
            }
            sourceChangesetId = latest.changesetId;
          }

          const source = this.changesets.getChangeset(sourceChangesetId);
          if (!source) {
            throw new Error(`Changeset not found: ${sourceChangesetId}`);
          }
          if (source.status !== "applied") {
            throw new Error(`changeset.rollback only supports applied changesets (current status: ${source.status}).`);
          }

          const sourcePreview = this.changesets.getStoredPreview(source.changesetId);
          if (!sourcePreview) {
            throw new Error(
              "changeset.rollback requires a stored source preview diff. " +
                "Run changeset.preview before applying future changesets."
            );
          }

          const sourceEntries = this.changesets.listEntries(source.changesetId);
          const inverseFiles = buildInverseReplacements(
            this.snapshotRepo,
            {
              changesetId: source.changesetId,
              snapshotId: source.snapshotId,
              title: source.title,
              intent: source.intent
            },
            sourceEntries,
            sourcePreview
          );
          if (inverseFiles.length === 0) {
            throw new Error(`No files to rollback for changeset ${source.changesetId}`);
          }

          const rollbackChangeset = this.changesets.newChangeset(
            source.snapshotId,
            strArg(args, "newTitle", false) || `Rollback ${source.changesetId}`,
            strArg(args, "newIntent", false) || `Rollback changes from ${source.title}`
          );
          for (const file of inverseFiles) {
            this.changesets.addEntry(
              rollbackChangeset.changesetId,
              file.fileKey,
              {
                type: "replace-range",
                start: 0,
                end: file.currentYaml.length,
                replacement: file.previousYaml
              },
              `Rollback ${source.changesetId}`
            );
          }

          const preview = boolArg(args, "preview", true)
            ? this.changesets.preview(rollbackChangeset.changesetId)
            : undefined;
          const validation = applyNow ? this.changesets.validate(rollbackChangeset.changesetId) : undefined;
          const applyResult = applyNow
            ? await this.changesets.apply(rollbackChangeset.changesetId, true, { remoteValidate })
            : undefined;

          const result: RollbackResult = {
            rollbackChangesetId: rollbackChangeset.changesetId,
            sourceChangesetId: source.changesetId,
            filesReverted: inverseFiles.map((row) => row.fileKey),
            preview,
            validation,
            applyResult
          };
          return this.ok(parsed.cmd, result);
        }

        case "changeset.drop": {
          const changesetId = strArg(args, "changesetId");
          this.changesets.dropChangeset(changesetId);
          return this.ok(parsed.cmd, { dropped: changesetId });
        }

        case "schema.search": {
          const query = strArg(args, "query", false);
          const tagsRaw = args.tags;
          const tags = Array.isArray(tagsRaw)
            ? tagsRaw.map((tag) => (typeof tag === "string" ? tag : "")).filter((tag) => tag.length > 0)
            : undefined;
          const result = searchSchema(query, tags);
          return this.ok(parsed.cmd, {
            query,
            tags,
            docs: result.docs.map(({ id, title, tags }) => ({ id, title, tags })),
            snippets: result.snippets.map(({ id, title, tags }) => ({ id, title, tags }))
          });
        }

        case "schema.read": {
          const id = strArg(args, "id");
          const doc = readSchemaDoc(id);
          if (!doc) {
            throw new Error(`Schema doc not found: ${id}`);
          }
          return this.ok(parsed.cmd, doc);
        }

        case "schema.snippet": {
          const id = strArg(args, "id");
          const snippet = readSchemaSnippet(id);
          if (!snippet) {
            throw new Error(`Schema snippet not found: ${id}`);
          }
          return this.ok(parsed.cmd, snippet);
        }

        default:
          throw new Error(`Unknown orbit cmd: ${parsed.cmd}. Run orbit({cmd:'help'}) for available commands.`);
      }
    } catch (error) {
      const message =
        error instanceof FlutterFlowApiError
          ? formatFlutterFlowApiErrorMessage(error)
          : error instanceof Error
          ? error.message
          : "Unknown error";
      return {
        ok: false,
        cmd: parsed.cmd,
        errors: [message]
      };
    }
  }

  getSchemaIndex(): ReturnType<typeof listSchemaIndex> {
    return listSchemaIndex();
  }

  getSchemaDoc(id: string) {
    return readSchemaDoc(id);
  }

  getSchemaSnippet(id: string) {
    return readSchemaSnippet(id);
  }

  exportChangesetPayload(changesetId: string) {
    return this.changesets.exportManualPayload(changesetId);
  }

  private resolveWriteSnapshotContext(
    input: OrbitCommandInput,
    args: Record<string, unknown>
  ): {
    snapshotId: string;
    snapshot: ReturnType<OrbitCommandPalette["requireSnapshot"]>;
    requestedSnapshotId?: string;
    warnings: string[];
  } {
    const requestedSnapshotId = this.requireSnapshotId(input, args);
    const strictSnapshot = boolArg(args, "strictSnapshot", false);
    const requestedSnapshot = this.requireSnapshot(requestedSnapshotId);
    const warnings: string[] = [];

    if (strictSnapshot) {
      return {
        snapshotId: requestedSnapshotId,
        snapshot: requestedSnapshot,
        warnings
      };
    }

    const requestedFileCount = this.snapshotRepo.countFiles(requestedSnapshotId);
    if (requestedFileCount > 0) {
      return {
        snapshotId: requestedSnapshotId,
        snapshot: requestedSnapshot,
        warnings
      };
    }

    const candidate = this.snapshotRepo
      .listSnapshots()
      .find(
        (entry) =>
          entry.projectId === requestedSnapshot.projectId &&
          entry.snapshotId !== requestedSnapshotId &&
          this.snapshotRepo.countFiles(entry.snapshotId) > 0
      );
    if (!candidate) {
      warnings.push(
        `Requested snapshot ${requestedSnapshotId} has 0 files; writes may fail. Run snapshots.ensureFresh first.`
      );
      return {
        snapshotId: requestedSnapshotId,
        snapshot: requestedSnapshot,
        warnings
      };
    }

    warnings.push(
      `Requested snapshot ${requestedSnapshotId} has 0 files; using fuller snapshot ${candidate.snapshotId} for write safety.`
    );
    return {
      snapshotId: candidate.snapshotId,
      requestedSnapshotId,
      snapshot: candidate,
      warnings
    };
  }

  private buildPageDeletePreflight(snapshotId: string, pageId: string): {
    canDelete: boolean;
    incomingRoutesCount: number;
    outgoingRoutesCount: number;
    actionReferenceCount: number;
    incomingRoutes: Array<{ fromPageId: string; toPageId: string; fileKey: string }>;
    actionReferences: Array<{ fromPageId: string; sourceNodeId?: string; trigger?: string; fileKey: string }>;
    blockingReasons: string[];
    recommendedActions: string[];
  } {
    const pageRows = collectPagesForSnapshot(this.snapshotRepo, this.indexRepo, snapshotId, true, true).pages;
    const symbolToPageId = new Map<string, string>();
    const normalizedToPageId = new Map<string, string>();
    for (const row of pageRows) {
      const symbolId = row.symbolId || synthesizePageSymbolId(row.pageId);
      symbolToPageId.set(symbolId, row.pageId);
      normalizedToPageId.set(symbolId.replace(/^page:/, ""), row.pageId);
    }
    const toPageIdFromSymbol = (symbolId: string): string => {
      const direct = symbolToPageId.get(symbolId);
      if (direct) {
        return direct;
      }
      const normalized = symbolId.startsWith("page:") ? symbolId.slice("page:".length) : symbolId;
      return normalizedToPageId.get(normalized) || symbolId;
    };

    const navRows = this.indexRepo.listEdges(snapshotId, "nav").map((edge) => ({
      fromPageId: toPageIdFromSymbol(edge.fromId),
      toPageId: toPageIdFromSymbol(edge.toId),
      fileKey: edge.fileKey
    }));
    const incomingRoutes = navRows.filter((row) => row.toPageId === pageId);
    const outgoingRoutes = navRows.filter((row) => row.fromPageId === pageId);

    const actionReferences: Array<{ fromPageId: string; sourceNodeId?: string; trigger?: string; fileKey: string }> = [];
    const triggerFiles = this.snapshotRepo
      .listFiles(snapshotId, "page/", 10_000)
      .filter((file) =>
        /^page\/id-[^/]+\/page-widget-tree-outline\/node\/id-[^/]+\/trigger_actions\/id-[^/]+(\.ya?ml)?$/i.test(
          file.fileKey
        )
      );
    for (const triggerFile of triggerFiles) {
      const parsedAction = parseTriggerAndActionFromYaml(triggerFile.yaml);
      if (parsedAction.navigateTargetPageId !== pageId) {
        continue;
      }
      const match = triggerFile.fileKey.match(
        /^page\/(id-[^/]+)\/page-widget-tree-outline\/node\/(id-[^/]+)\/trigger_actions\/(id-[^/.]+)(?:\.ya?ml)?$/i
      );
      actionReferences.push({
        fromPageId: match?.[1] || "unknown",
        sourceNodeId: match?.[2],
        trigger: parsedAction.triggerType || match?.[3]?.replace(/^id-/, ""),
        fileKey: triggerFile.fileKey
      });
    }

    const blockingReasons: string[] = [];
    if (incomingRoutes.length > 0) {
      blockingReasons.push(
        `Page has ${incomingRoutes.length} incoming route(s) and may still be reachable.`
      );
    }
    if (actionReferences.length > 0) {
      blockingReasons.push(
        `Found ${actionReferences.length} trigger action reference(s) navigating to this page.`
      );
    }
    const recommendedActions: string[] = [];
    if (incomingRoutes.length > 0 || actionReferences.length > 0) {
      recommendedActions.push("Remove incoming route bindings with routes.delete before delete, or pass force:true.");
      recommendedActions.push("Use routes.listByPage with direction='incoming' to inspect references.");
    }

    return {
      canDelete: blockingReasons.length === 0,
      incomingRoutesCount: incomingRoutes.length,
      outgoingRoutesCount: outgoingRoutes.length,
      actionReferenceCount: actionReferences.length,
      incomingRoutes: incomingRoutes.slice(0, 12),
      actionReferences: actionReferences.slice(0, 12),
      blockingReasons,
      recommendedActions
    };
  }

  private requireSnapshot(snapshotId: string) {
    const snapshot = this.snapshotRepo.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
    return snapshot;
  }

  private requireSnapshotId(input: OrbitCommandInput, args: Record<string, unknown>): string {
    if (input.snapshot && input.snapshot.trim().length > 0) {
      return input.snapshot.trim();
    }

    const fromArgs = strArg(args, "snapshotId", false);
    if (fromArgs) {
      return fromArgs;
    }

    const mostRecent = this.snapshotRepo.listSnapshots()[0];
    if (mostRecent) {
      return mostRecent.snapshotId;
    }

    throw new Error("Missing snapshotId. Create one first with snapshots.create (args: { projectId, name? }).");
  }

  private async listPartitionedFileNamesWithBackoff(
    projectId: string,
    retries: number,
    baseBackoffMs: number,
    warnings: string[]
  ) {
    let attempt = 0;
    while (true) {
      try {
        return await this.adapter.listPartitionedFileNames(projectId);
      } catch (error) {
        const isRetryable429 = error instanceof FlutterFlowApiError && error.status === 429 && attempt < retries;
        if (!isRetryable429) {
          throw error;
        }
        const retryAfterSeconds = Number.parseInt(error.request?.retryAfter ?? "", 10);
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
        const exponentialMs = Math.min(baseBackoffMs * 2 ** attempt, 60_000);
        const sleepMs = Math.max(retryAfterMs, exponentialMs);
        warnings.push(
          `Rate limited on listPartitionedFileNames (attempt ${attempt + 1}/${retries + 1}); backing off ${sleepMs}ms before retry.`
        );
        attempt += 1;
        await waitMs(sleepMs);
      }
    }
  }

  private canonicalFileKey(fileKey: string): string {
    return fileKey.replace(/\.ya?ml$/i, "").toLowerCase();
  }

  private async fetchFileWithBackoff(
    projectId: string,
    fileKey: string,
    retries: number,
    baseBackoffMs: number,
    warnings: string[]
  ): Promise<string> {
    let attempt = 0;
    while (true) {
      try {
        return await this.adapter.fetchFile(projectId, fileKey);
      } catch (error) {
        const isRetryable429 = error instanceof FlutterFlowApiError && error.status === 429 && attempt < retries;
        if (!isRetryable429) {
          throw error;
        }
        const retryAfterSeconds = Number.parseInt(error.request?.retryAfter ?? "", 10);
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
        const exponentialMs = Math.min(baseBackoffMs * 2 ** attempt, 60_000);
        const sleepMs = Math.max(retryAfterMs, exponentialMs);
        warnings.push(
          `Rate limited on fetchFile ${fileKey} (attempt ${attempt + 1}/${retries + 1}); backing off ${sleepMs}ms before retry.`
        );
        attempt += 1;
        await waitMs(sleepMs);
      }
    }
  }

  private findChunkSessionForSnapshot(snapshotId: string): FullRefreshChunkSession | undefined {
    for (const session of this.fullRefreshChunkSessions.values()) {
      if (session.snapshotId === snapshotId) {
        return session;
      }
    }
    return undefined;
  }

  private clearChunkSessionsForSnapshot(snapshotId: string): void {
    for (const [sessionId, session] of this.fullRefreshChunkSessions.entries()) {
      if (session.snapshotId === snapshotId) {
        this.fullRefreshChunkSessions.delete(sessionId);
      }
    }
  }

  private async refreshSnapshotFullChunked(
    snapshotId: string,
    options: {
      chunkSessionId?: string;
      resetChunkSession: boolean;
      maxFetch: number;
      concurrency: number;
      sleepMs: number;
      listRetries: number;
      listRetryBaseMs: number;
    }
  ): Promise<RefreshSnapshotResult> {
    const snapshot = this.requireSnapshot(snapshotId);
    const warnings: string[] = [];
    const notes: string[] = [];

    if (options.resetChunkSession) {
      if (options.chunkSessionId) {
        this.fullRefreshChunkSessions.delete(options.chunkSessionId);
      }
      this.clearChunkSessionsForSnapshot(snapshotId);
      notes.push("Reset existing chunked full refresh session state.");
    }

    let session: FullRefreshChunkSession | undefined;
    let reusedSession = false;

    if (options.chunkSessionId) {
      session = this.fullRefreshChunkSessions.get(options.chunkSessionId);
      if (!session && !options.resetChunkSession) {
        throw new Error(`Chunk session not found: ${options.chunkSessionId}. Start a new run with chunkedFull:true.`);
      }
      reusedSession = Boolean(session);
    } else {
      session = this.findChunkSessionForSnapshot(snapshotId);
      if (session) {
        reusedSession = true;
      }
    }

    if (session && (session.snapshotId !== snapshotId || session.projectId !== snapshot.projectId)) {
      throw new Error(
        `Chunk session ${session.sessionId} does not match snapshot ${snapshotId}. Start a new chunked session for this snapshot.`
      );
    }

    if (!session) {
      const listed = await this.listPartitionedFileNamesWithBackoff(
        snapshot.projectId,
        options.listRetries,
        options.listRetryBaseMs,
        warnings
      );
      const uniqueKeys: string[] = [];
      const seenCanonicalKeys = new Set<string>();
      for (const entry of listed.files) {
        const canonical = this.canonicalFileKey(entry.fileKey);
        if (seenCanonicalKeys.has(canonical)) {
          continue;
        }
        seenCanonicalKeys.add(canonical);
        uniqueKeys.push(entry.fileKey);
      }
      const now = new Date().toISOString();
      const sessionId = options.chunkSessionId || orbitId("frs");
      session = {
        sessionId,
        snapshotId,
        projectId: snapshot.projectId,
        remoteKeys: uniqueKeys,
        queue: [...uniqueKeys],
        fetchedCanonicalKeys: new Set<string>(),
        versionInfo: listed.versionInfo,
        createdAt: now,
        listedAt: now,
        updatedAt: now
      };
      this.fullRefreshChunkSessions.set(sessionId, session);
      notes.push(`Created chunked full refresh session ${sessionId} with ${uniqueKeys.length} files.`);
    } else {
      notes.push(`Reusing chunked full refresh session ${session.sessionId}.`);
    }

    const batchSize = clampInt(options.maxFetch, 1, 2000);
    const fetchKeys = session.queue.slice(0, batchSize);
    session.queue = session.queue.slice(fetchKeys.length);

    const attemptedFetchCount = fetchKeys.length;
    let failedFetchCount = 0;
    const failedKeys: string[] = [];
    const fetchedRows = await mapLimit(fetchKeys, options.concurrency, async (fileKey) => {
      if (options.sleepMs > 0) {
        await waitMs(options.sleepMs);
      }
      try {
        const yaml = await this.fetchFileWithBackoff(
          snapshot.projectId,
          fileKey,
          options.listRetries,
          options.listRetryBaseMs,
          warnings
        );
        return { fileKey, yaml, sha256: sha256(yaml) };
      } catch (error) {
        failedKeys.push(fileKey);
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Failed to refresh '${fileKey}' in chunk session ${session.sessionId}: ${message}`);
        return undefined;
      }
    });

    const fetched = fetchedRows.filter((row): row is { fileKey: string; yaml: string; sha256: string } => Boolean(row));
    failedFetchCount = attemptedFetchCount - fetched.length;
    if (failedKeys.length > 0) {
      session.queue.push(...failedKeys);
    }

    for (const row of fetched) {
      session.fetchedCanonicalKeys.add(this.canonicalFileKey(row.fileKey));
    }

    if (fetched.length > 0) {
      this.snapshotRepo.upsertFiles(snapshotId, fetched);
      if (session.versionInfo) {
        this.snapshotRepo.setVersionInfo(snapshotId, session.versionInfo);
      }
      this.snapshotRepo.touchSnapshot(snapshotId);
      // Skip intermediate reindex — only reindex when all chunks are done
    }

    const remoteCanonicalKeys = new Set(session.remoteKeys.map((key) => this.canonicalFileKey(key)));
    const completed = session.queue.length === 0;
    const hasAllRemoteKeys = [...remoteCanonicalKeys].every((key) => session.fetchedCanonicalKeys.has(key));
    const canPruneMissing = completed && hasAllRemoteKeys;
    let pruneApplied = false;
    if (canPruneMissing) {
      this.snapshotRepo.deleteMissingFiles(snapshotId, session.remoteKeys);
      this.snapshotRepo.touchSnapshot(snapshotId);
      await this.reindex(snapshotId);
      pruneApplied = true;
      this.fullRefreshChunkSessions.delete(session.sessionId);
      notes.push(`Chunked full refresh session ${session.sessionId} completed and pruning was applied.`);
    } else {
      warnings.push(
        `Chunked full refresh in progress: ${session.queue.length} file(s) remaining in session ${session.sessionId}.`
      );
    }

    session.updatedAt = new Date().toISOString();
    if (!pruneApplied) {
      this.fullRefreshChunkSessions.set(session.sessionId, session);
    }

    const authoritative = canPruneMissing;
    if (!authoritative) {
      warnings.push("Snapshot refresh is not authoritative yet due to in-progress chunked full refresh coverage.");
    }

    return {
      mode: "full",
      fetchedCount: fetched.length,
      attemptedFetchCount,
      totalRemoteFiles: session.remoteKeys.length,
      strategyUsed: "file",
      failedFetchCount,
      partial: !authoritative,
      pruneApplied,
      authoritative,
      versionInfo: session.versionInfo,
      notes,
      warnings,
      chunkSession: {
        sessionId: session.sessionId,
        remainingFetchCount: session.queue.length,
        totalRemoteFiles: session.remoteKeys.length,
        listedAt: session.listedAt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        completed: authoritative,
        reused: reusedSession
      }
    };
  }

  private async refreshSnapshotOnce(
    snapshotId: string,
    options: {
      mode: "incremental" | "full";
      fetchStrategy: FetchStrategy;
      maxFetch?: number;
      concurrency: number;
      sleepMs: number;
      listRetries: number;
      listRetryBaseMs: number;
    }
  ): Promise<RefreshSnapshotResult> {
    if (options.mode === "full") {
      this.clearChunkSessionsForSnapshot(snapshotId);
    }
    const snapshot = this.requireSnapshot(snapshotId);
    const warnings: string[] = [];
    const listed = await this.listPartitionedFileNamesWithBackoff(
      snapshot.projectId,
      options.listRetries,
      options.listRetryBaseMs,
      warnings
    );
    const remoteEntries = listed.files;
    const remoteKeys = remoteEntries.map((entry) => entry.fileKey);
    const remoteCanonicalKeys = new Set(remoteKeys.map((key) => this.canonicalFileKey(key)));
    const localMap = new Map(this.snapshotRepo.listFileHashes(snapshotId).map((row) => [row.fileKey, row.sha256]));
    const existingVersionInfo = this.snapshotRepo.getVersionInfo(snapshotId);

    const fingerprintUnchanged =
      options.mode === "incremental" &&
      existingVersionInfo?.projectSchemaFingerprint &&
      listed.versionInfo?.projectSchemaFingerprint &&
      existingVersionInfo.projectSchemaFingerprint === listed.versionInfo.projectSchemaFingerprint;

    const fetchedByKey = new Map<string, { fileKey: string; yaml: string; sha256: string }>();
    const notes: string[] = [];
    let attemptedFetchCount = 0;
    let failedFetchCount = 0;
    let strategyUsed: "bulk" | "file" = "file";
    let partial = false;
    let versionInfo: ProjectVersionInfo | undefined = listed.versionInfo;

    const fetchByFileKeys = async (candidateKeys: string[], preferBudget = true): Promise<void> => {
      let fetchKeys = candidateKeys;
      const requestedFetchCount = fetchKeys.length;
      if (preferBudget && options.maxFetch && options.maxFetch > 0 && fetchKeys.length > options.maxFetch) {
        fetchKeys = fetchKeys.slice(0, options.maxFetch);
        warnings.push(`Applied maxFetch budget: ${fetchKeys.length}/${requestedFetchCount} candidate files this run.`);
      }
      attemptedFetchCount += fetchKeys.length;

      const fetchedRows = await mapLimit(fetchKeys, options.concurrency, async (fileKey) => {
        if (options.sleepMs > 0) {
          await waitMs(options.sleepMs);
        }
        try {
          const yaml = await this.fetchFileWithBackoff(
            snapshot.projectId,
            fileKey,
            options.listRetries,
            options.listRetryBaseMs,
            warnings
          );
          return { fileKey, yaml, sha256: sha256(yaml) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Failed to refresh '${fileKey}': ${message}`);
          return undefined;
        }
      });

      const fetched = fetchedRows.filter((row): row is { fileKey: string; yaml: string; sha256: string } => Boolean(row));
      failedFetchCount += fetchKeys.length - fetched.length;
      if (fetched.length < fetchKeys.length) {
        partial = true;
      }
      for (const row of fetched) {
        fetchedByKey.set(row.fileKey, row);
      }
    };

    if (options.mode === "full" && (options.fetchStrategy === "auto" || options.fetchStrategy === "bulk")) {
      strategyUsed = "bulk";
      try {
        const bundled = await this.adapter.fetchProjectYamls(snapshot.projectId, undefined, { includeVersionInfo: true });
        if (bundled.versionInfo) {
          versionInfo = bundled.versionInfo;
        }
        for (const [fileKey, yaml] of Object.entries(bundled.files)) {
          fetchedByKey.set(fileKey, { fileKey, yaml, sha256: sha256(yaml) });
        }
        attemptedFetchCount += remoteKeys.length;

        const bundledCanonicalKeys = new Set(
          [...fetchedByKey.values()].map((row) => this.canonicalFileKey(row.fileKey))
        );
        const missingKeys = remoteKeys.filter((key) => !bundledCanonicalKeys.has(this.canonicalFileKey(key)));
        if (missingKeys.length > 0) {
          warnings.push(
            `Bulk projectYamls returned ${fetchedByKey.size} files but missed ${missingKeys.length}/${remoteKeys.length} listed files; fetching missing keys individually.`
          );
          strategyUsed = "file";
          await fetchByFileKeys(missingKeys, true);
        } else if (options.maxFetch && options.maxFetch > 0) {
          warnings.push("Ignored maxFetch budget because full refresh used bulk projectYamls fetch.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Bulk projectYamls fetch failed: ${message}. Falling back to per-file refresh.`);
        strategyUsed = "file";
        await fetchByFileKeys(remoteKeys, true);
      }
    } else {
      strategyUsed = "file";
      let fetchKeys: string[];
      if (options.mode === "full") {
        fetchKeys = remoteKeys;
      } else if (fingerprintUnchanged) {
        fetchKeys = remoteKeys.filter((key) => !localMap.has(key));
      } else if (remoteEntries.some((entry) => typeof entry.hash === "string" && entry.hash.length > 0)) {
        fetchKeys = remoteEntries
          .filter((entry) => {
            if (!entry.hash) {
              return !localMap.has(entry.fileKey);
            }
            return localMap.get(entry.fileKey) !== entry.hash;
          })
          .map((entry) => entry.fileKey);
      } else {
        const heuristic = remoteKeys.filter((key) => /(page|component|route|theme|app_state|settings)/i.test(key));
        const missing = remoteKeys.filter((key) => !localMap.has(key));
        fetchKeys = [...new Set([...missing, ...heuristic.slice(0, 120)])];
        if (fetchKeys.length === 0) {
          fetchKeys = remoteKeys.slice(0, Math.min(50, remoteKeys.length));
        }
      }
      await fetchByFileKeys(fetchKeys, true);
    }

    const fetched = [...fetchedByKey.values()];

    if (fetched.length === 0 && remoteKeys.length > 0 && attemptedFetchCount > 0) {
      throw new Error(
        "Refresh failed: none of the selected remote files could be fetched from projectYamls. Check throttling/API path config and retry."
      );
    }

    this.snapshotRepo.upsertFiles(snapshotId, fetched);
    if (versionInfo) {
      this.snapshotRepo.setVersionInfo(snapshotId, versionInfo);
    }
    const fetchedCanonicalKeys = new Set(fetched.map((row) => this.canonicalFileKey(row.fileKey)));
    const hasAllRemoteKeys = [...remoteCanonicalKeys].every((key) => fetchedCanonicalKeys.has(key));
    const canPruneMissing = options.mode === "full" && hasAllRemoteKeys && !partial;
    let pruneApplied = false;
    if (canPruneMissing) {
      this.snapshotRepo.deleteMissingFiles(snapshotId, remoteKeys);
      pruneApplied = true;
    } else if (options.mode === "full" || remoteKeys.length !== fetched.length || attemptedFetchCount !== remoteKeys.length) {
      warnings.push(
        "Skipped pruning missing files after refresh to avoid data loss from partial fetches; run snapshots.refresh with mode=full after rate limits clear."
      );
    }

    const authoritative = options.mode === "full" ? canPruneMissing : !partial;
    if (!authoritative) {
      warnings.push("Snapshot refresh is not authoritative yet due to partial or fallback fetch coverage.");
    }

    this.snapshotRepo.touchSnapshot(snapshotId);
    await this.reindex(snapshotId);

    return {
      mode: options.mode,
      fetchedCount: fetched.length,
      attemptedFetchCount,
      totalRemoteFiles: remoteKeys.length,
      strategyUsed,
      failedFetchCount,
      partial,
      pruneApplied,
      authoritative,
      versionInfo,
      warnings,
      notes: [
        ...notes,
        ...(fingerprintUnchanged ? ["Fingerprint unchanged. Refresh fetched only files missing from local snapshot."] : []),
        ...(options.mode === "incremental" && !remoteEntries.some((entry) => entry.hash)
          ? ["Incremental refresh used heuristic mode because remote hashes were unavailable."]
          : [])
      ]
    };
  }

  private async reindex(snapshotId: string): Promise<void> {
    const files = this.snapshotRepo
      .listFiles(snapshotId, undefined, 15_000)
      .map((file) => ({ fileKey: file.fileKey, yaml: file.yaml }));
    const indices = extractSnapshotIndex(snapshotId, files);
    this.indexRepo.replaceSnapshotIndices(snapshotId, indices.symbols, indices.edges);
  }

  private snapshotWarnings(snapshot: { refreshedAt: string; snapshotId: string }): string[] {
    const staleMinutes = Number.parseInt(process.env.ORBIT_SNAPSHOT_STALE_MINUTES ?? "30", 10) || 30;
    if (isSnapshotStale(snapshot.refreshedAt, staleMinutes)) {
      return [
        `Snapshot ${snapshot.snapshotId} is stale (> ${staleMinutes} minutes). Run snapshots.refresh before making decisions.`
      ];
    }
    return [];
  }

  private ok(cmd: string, data: unknown, warnings: string[] = []): OrbitCommandResult {
    this.rememberSelection(data);
    return {
      ok: true,
      cmd,
      data,
      warnings
    };
  }

  private rememberSelection(data: unknown): void {
    const root = asObject(data);
    if (Object.keys(root).length === 0) {
      return;
    }
    const selection = asObject(root.selection);
    const pageId = typeof selection.pageId === "string" ? selection.pageId : "";
    const nodeId = typeof selection.nodeId === "string" ? selection.nodeId : "";
    const fileKey = typeof selection.fileKey === "string" ? selection.fileKey : "";
    if (!pageId || !nodeId || !fileKey) {
      return;
    }
    const snapshotId = typeof root.snapshotId === "string"
      ? root.snapshotId
      : typeof selection.snapshotId === "string"
      ? selection.snapshotId
      : undefined;
    const remembered: RememberedSelection = {
      snapshotId,
      pageId,
      nodeId,
      fileKey,
      updatedAt: new Date().toISOString()
    };
    this.lastSelection = remembered;
    if (snapshotId) {
      this.selectionBySnapshot.set(snapshotId, remembered);
    }
  }

  private snapshotDataWarnings(snapshotId: string): string[] {
    const warnings: string[] = [];
    const fileCount = this.snapshotRepo.countFiles(snapshotId);
    if (fileCount === 0) {
      warnings.push(
        `Snapshot ${snapshotId} contains no files. Run snapshots.refresh or recreate with snapshots.create before querying routes/pages.`
      );
    }
    return warnings;
  }

  private resolvePage(
    snapshotId: string,
    query: string
  ): { page: { symbolId: string; name: string; fileKey: string; nodePath: string }; file: { fileKey: string; yaml: string } } | undefined {
    const found = this.indexRepo.findSymbols(snapshotId, "page", query)[0];
    if (found) {
      const file = this.snapshotRepo.getFile(snapshotId, found.fileKey);
      if (file) {
        return {
          page: {
            symbolId: found.symbolId,
            name: found.name,
            fileKey: found.fileKey,
            nodePath: found.nodePath
          },
          file: { fileKey: file.fileKey, yaml: file.yaml }
        };
      }
    }

    const normalizedQuery = query.trim();
    const pageRootFiles = this.snapshotRepo
      .listFiles(snapshotId, "page/", 10_000)
      .filter((file) => {
        const normalized = file.fileKey.replace(/\.ya?ml$/i, "");
        return /^page\/id-[^/]+$/i.test(normalized);
      });

    const byId = new Map<string, { fileKey: string; yaml: string }>();
    for (const file of pageRootFiles) {
      const pageId = pageIdFromFileKey(file.fileKey);
      if (!pageId) {
        continue;
      }
      const existing = byId.get(pageId);
      const isCanonical = file.fileKey === `page/${pageId}` || file.fileKey === `page/${pageId}.yaml`;
      if (!existing || isCanonical) {
        byId.set(pageId, { fileKey: file.fileKey, yaml: file.yaml });
      }
    }

    const normalizedFileKey = normalizedQuery.replace(/\.ya?ml$/i, "");
    const directFile = pageRootFiles.find((file) => file.fileKey.replace(/\.ya?ml$/i, "") === normalizedFileKey);
    if (directFile) {
      const pageId = pageIdFromFileKey(directFile.fileKey) ?? normalizedQuery;
      return {
        page: {
          symbolId: `page:${pageId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")}`,
          name: pickPageDisplayNameFromYaml(directFile.yaml) || pageId,
          fileKey: directFile.fileKey,
          nodePath: "$"
        },
        file: { fileKey: directFile.fileKey, yaml: directFile.yaml }
      };
    }

    if (byId.has(normalizedQuery)) {
      const file = byId.get(normalizedQuery)!;
      return {
        page: {
          symbolId: `page:${normalizedQuery.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")}`,
          name: pickPageDisplayNameFromYaml(file.yaml) || normalizedQuery,
          fileKey: file.fileKey,
          nodePath: "$"
        },
        file
      };
    }

    const byName = [...byId.entries()].find(([, file]) => {
      const name = pickPageDisplayNameFromYaml(file.yaml);
      return name ? name.toLowerCase() === normalizedQuery.toLowerCase() : false;
    });
    if (byName) {
      const [pageId, file] = byName;
      return {
        page: {
          symbolId: `page:${pageId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")}`,
          name: pickPageDisplayNameFromYaml(file.yaml) || pageId,
          fileKey: file.fileKey,
          nodePath: "$"
        },
        file
      };
    }

    return undefined;
  }

  private resolveComponent(
    snapshotId: string,
    query: string
  ): { componentId: string; name: string; fileKey: string } | undefined {
    const found = this.indexRepo.findSymbols(snapshotId, "component", query)[0];
    if (found) {
      const componentId = found.fileKey.match(/^component\/(id-[^/.]+)(?:\.ya?ml)?$/i)?.[1] || found.name;
      return {
        componentId,
        name: found.name,
        fileKey: found.fileKey
      };
    }

    const normalizedQuery = query.trim().toLowerCase();
    const files = this.snapshotRepo
      .listFiles(snapshotId, "component/", 10_000)
      .filter((file) => /^component\/id-[^/]+(\.ya?ml)?$/i.test(file.fileKey));
    for (const file of files) {
      const componentId = file.fileKey.match(/^component\/(id-[^/.]+)(?:\.ya?ml)?$/i)?.[1];
      if (!componentId) {
        continue;
      }
      let name = componentId;
      try {
        const parsed = YAML.parse(file.yaml);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const maybeName = (parsed as Record<string, unknown>).name;
          if (typeof maybeName === "string" && maybeName.trim().length > 0) {
            name = maybeName.trim();
          }
        }
      } catch {
        // ignore parse error
      }
      if (
        componentId.toLowerCase() === normalizedQuery ||
        file.fileKey.toLowerCase() === normalizedQuery ||
        name.toLowerCase() === normalizedQuery
      ) {
        return {
          componentId,
          name,
          fileKey: file.fileKey
        };
      }
    }
    return undefined;
  }
}
