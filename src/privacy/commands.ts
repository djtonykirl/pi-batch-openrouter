import * as fs from "node:fs";
import { GLOBAL_CONFIG_FILE, projectConfigPath, saveConfigUpdate } from "../config.js";
import type { CatalogSnapshot } from "../models/catalog.js";
import type { BatchRuntime } from "../runtime.js";
import { formatIsoShort } from "../time.js";
import { isPrivacyLevel, normaliseModelSlug, PRIVACY_LEVELS, routeForModel, type PrivacyLevel, type Route } from "./policy.js";

export const PRIVACY_SETTINGS_URL = "https://openrouter.ai/settings/privacy";

/** Shown once per project, the first time the level is raised above `standard`. */
export const PRIVACY_NOTICE =
  `Privacy levels only tighten what this extension sends. OpenRouter's own logging and "use of inputs/outputs" account settings, ` +
  `and the training settings for free and paid models, are controlled at ${PRIVACY_SETTINGS_URL}; the extension cannot check them.`;

export interface PickerEntry {
  id: string;
  route: Route;
  /** Display labels without brackets: batch, free, ZDR. */
  labels: string[];
  /** Why the current level rules this model out; absent when it is allowed. */
  blocked?: string;
}

/**
 * The chat model picker's list: the batch models Pi knows plus the catalog's free models, labelled and checked against
 * the level. Blocked entries are returned (with the reason) so a caller can hide or show them.
 */
export function pickerEntries(catalog: CatalogSnapshot | undefined, batchModels: string[], level: PrivacyLevel, accountNoTraining: boolean): PickerEntry[] {
  const candidates = new Map<string, Route>();
  for (const id of batchModels) candidates.set(id, routeForModel(id));
  for (const m of catalog?.models ?? []) {
    if (m.free && !candidates.has(m.id)) candidates.set(m.id, "immediate");
  }
  const out: PickerEntry[] = [];
  for (const [id, route] of candidates) {
    const base = normaliseModelSlug(id);
    const hasZdr = !!catalog?.zdr.some((e) => e.model === base);
    const labels = [route === "batch" ? "batch" : "free", ...(hasZdr ? ["ZDR"] : [])];
    const entry: PickerEntry = { id, route, labels };
    if (level === "zdr") {
      if (!catalog?.fresh) entry.blocked = "Privacy level zdr: model catalog not loaded this session, so ZDR providers can't be verified (run /batch privacy refresh)";
      else if (!hasZdr) entry.blocked = `Privacy level zdr: no ZDR provider for ${base}`;
    } else if (level === "no-training" && route === "batch" && !accountNoTraining) {
      entry.blocked = "Privacy level no-training: batch models need your account's no-training attestation (/batch privacy attest)";
    }
    out.push(entry);
  }
  return out;
}

export function catalogStateLine(snapshot: CatalogSnapshot | undefined): string {
  if (!snapshot) return "loading";
  const at = formatIsoShort(snapshot.loadedAt);
  return snapshot.fresh ? `fresh at ${at}` : `from ${at}, refresh failed${snapshot.error ? ` (${snapshot.error})` : ""}`;
}

/** Recorded with the attestation: the extension only stores what the user says. */
export const ATTEST_NOTE = "The extension cannot verify this; check your OpenRouter account privacy settings.";

/** The privacy config fields to write when the attestation changes (attestedAt is removed on unattest). */
export function attestationUpdate(attested: boolean, now = new Date()): { accountNoTraining: boolean; attestedAt: string | undefined } {
  return { accountNoTraining: attested, attestedAt: attested ? now.toISOString() : undefined };
}

/** The privacy config fields to write for a level change, and whether the one-time notice is due. */
export function levelUpdate(current: { noticeShown: boolean }, level: PrivacyLevel): { update: { level: PrivacyLevel; noticeShown?: boolean }; showNotice: boolean } {
  const showNotice = level !== "standard" && !current.noticeShown;
  return { update: showNotice ? { level, noticeShown: true } : { level }, showNotice };
}

export function formatPrivacyStatus(input: { level: PrivacyLevel; source: string; accountNoTraining: boolean; attestedAt?: string; snapshot: CatalogSnapshot | undefined }): string {
  return [
    `Privacy level: ${input.level} (${input.source})`,
    `No-training attestation: ${input.accountNoTraining ? `attested${input.attestedAt ? ` ${formatIsoShort(input.attestedAt)}` : ""} (you confirmed your OpenRouter account disables training; the extension cannot verify this)` : "not attested"}`,
    `Model catalog: ${catalogStateLine(input.snapshot)}`,
    `Account privacy settings (not checked by this extension): ${PRIVACY_SETTINGS_URL}`,
    `Usage: /batch [--global] privacy ${PRIVACY_LEVELS.join("|")}|attest|unattest|refresh`,
  ].join("\n");
}

function readLevel(file: string): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { privacy?: { level?: unknown } };
    return isPrivacyLevel(j.privacy?.level);
  } catch {
    return false;
  }
}

/** Where the effective level was set: the project file wins over the global one. */
export function levelSource(cwd: string | undefined, globalFile = GLOBAL_CONFIG_FILE): string {
  if (cwd && readLevel(projectConfigPath(cwd))) return "project";
  if (readLevel(globalFile)) return "global";
  return "default";
}

const USAGE = `Usage: /batch [--global] privacy [${PRIVACY_LEVELS.join("|")}|attest|unattest|refresh]`;

export async function cmdPrivacy(rt: BatchRuntime, rest: string[], isGlobal: boolean): Promise<void> {
  const arg = rest.join(" ").trim().toLowerCase();
  const config = () => rt.loaded.config.privacy;
  const save = (privacy: Partial<ReturnType<typeof config>>): string => {
    const file = saveConfigUpdate({ privacy }, { cwd: rt.cwd, global: isGlobal });
    rt.reloadConfig();
    return `${isGlobal ? "saved globally" : "saved for this project"}: ${file}`;
  };

  if (!arg) {
    rt.notify(formatPrivacyStatus({ level: config().level, source: levelSource(rt.cwd), accountNoTraining: config().accountNoTraining, attestedAt: config().attestedAt, snapshot: rt.catalog?.snapshot() }), "info");
    return;
  }
  if (arg === "refresh") {
    if (!rt.catalog) throw new Error("No model catalog: there is no active Pi session/workspace.");
    const snap = await rt.catalog.load();
    rt.notify(`Model catalog: ${catalogStateLine(snap)}`, snap.fresh ? "info" : "warning");
    return;
  }
  if (arg === "attest") {
    const where = save(attestationUpdate(true));
    rt.notify(
      `Recorded: you attest your OpenRouter account disables training for the models you use (${where}). The extension cannot verify this; check ${PRIVACY_SETTINGS_URL}.`,
      "info",
    );
    return;
  }
  if (arg === "unattest") {
    rt.notify(`Attestation removed (${save(attestationUpdate(false))}). Batch models are refused at no-training until you attest again.`, "info");
    return;
  }
  if (!isPrivacyLevel(arg)) throw new Error(USAGE);

  const { update, showNotice } = levelUpdate(config(), arg);
  const where = save(update);
  rt.notify(`Privacy level set to ${arg} (${where})`, "info");
  if (showNotice) rt.notify(PRIVACY_NOTICE, "info");
}
