import type { ChatAttachmentMeta } from "../attachments.js";
import type { ChatContentPart, ProviderPin } from "../openrouter/types.js";

export interface ThreadState {
  schemaVersion: 1;
  id: string;
  title: string;
  titleLocked: boolean;
  retitled: boolean;
  model: string;
  account: string;
  providerPin?: ProviderPin;
  createdAt: string;
  updatedAt: string;
  nextSeq: number;
  pending?: { throughSeq: number; claimedAt: string; jobId?: string };
  compacting?: { throughSeq: number; claimedAt: string; jobId?: string; instructions?: string };
  lastFailure?: { purpose: "turn" | "compact"; jobId?: string; message: string; at: string };
  summary?: { text: string; throughSeq: number; jobId: string };
}

export type TranscriptEntry = { seq: number; at: string } & (
  | { type: "user"; text: string; attachments?: ChatAttachmentMeta[]; inlinedText?: string; parts?: ChatContentPart[] }
  /** `throughSeq`: the last user seq the reply answers (messages typed while it was pending have lower seqs). */
  | { type: "assistant"; text: string; model: string; jobId: string; finishReason?: string; throughSeq?: number }
  | { type: "model"; from: string; to: string }
  | { type: "title"; title: string; source: "auto" | "manual" }
  | { type: "compaction"; summary: string; throughSeq: number; jobId: string; model: string; instructions?: string }
  | { type: "failure"; purpose: "turn" | "compact"; jobId?: string; message: string }
  | { type: "status"; text: string }
);

export type TranscriptEntryInput = TranscriptEntry extends infer E ? (E extends unknown ? Omit<E, "seq" | "at"> : never) : never;
