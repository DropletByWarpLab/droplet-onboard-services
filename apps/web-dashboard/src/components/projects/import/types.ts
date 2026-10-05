// Wire types for project import (WARP-3527) — mirror what the orchestrator's
// routes/pm/import-export.ts returns (services/pm/import/analysis.ts and
// context.ts). Kept beside the wizard, not in ../types.ts, so this slice adds
// files instead of editing a shared one.

import type { Priority, StateGroup } from "../types";

export type ImportSource =
  | "CSV"
  | "JIRA_CSV"
  | "ASANA_CSV"
  | "TRELLO_JSON"
  | "LINEAR_CSV"
  | "GITHUB_CSV";

export type ImportStatus = "PENDING" | "PREVIEWED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type FieldKey =
  | "externalId"
  | "name"
  | "description"
  | "status"
  | "priority"
  | "assignee"
  | "assignees"
  | "reporter"
  | "labels"
  | "issueType"
  | "milestone"
  | "dueDate"
  | "startDate"
  | "createdAt"
  | "updatedAt"
  | "completedAt"
  | "parent";

export type DateOrder = "DMY" | "MDY" | "YMD";

export type StateDecision =
  | { kind: "state"; stateId: string }
  | { kind: "create"; name: string; group: StateGroup }
  | { kind: "default" };

export interface ImportMapping {
  columns: Partial<Record<FieldKey, string[]>>;
  dateOrder: DateOrder | "auto";
  listSeparator: string;
  createMissingStates: boolean;
  createMissingLabels: boolean;
  statuses: Record<string, StateDecision>;
  priorities: Record<string, Priority>;
  people: Record<string, string | null>;
}

export interface ImportIssue {
  row: number;
  key: string | null;
  code: string;
  message: string;
}

export interface ImportStats {
  begun: boolean;
  totalRows: number;
  toProcess: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  issues: ImportIssue[];
  issuesTruncated: boolean;
  unknownAssignees: Array<{ value: string; count: number; reason: string }>;
  createdStates: string[];
  createdLabels: string[];
}

export interface ImportJob {
  id: string;
  projectId: string;
  source: ImportSource;
  status: ImportStatus;
  fileName: string;
  fileBytes: number;
  mapping: Partial<ImportMapping>;
  stats: ImportStats;
  error: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PlannedStatus {
  key: string;
  value: string;
  count: number;
  decision: StateDecision;
  auto: "override" | "name" | "synonym" | "create" | "default";
  group: StateGroup;
  stateName?: string;
}

export interface PlannedPriority {
  key: string;
  value: string;
  count: number;
  priority: Priority;
  known: boolean;
}

export type PersonMatch = "email" | "name" | "username" | "override" | "none" | "ambiguous" | "ineligible";

export interface PlannedPerson {
  value: string;
  key: string;
  userId: string | null;
  displayName?: string;
  by: PersonMatch;
  detail?: string;
  count: number;
}

export interface PreviewRow {
  row: number;
  key: string;
  name: string;
  action: "create" | "update" | "skip";
  skipReason: string | null;
  status: { text: string; isNew: boolean } | null;
  priority: Priority | null;
  assignees: Array<{ value: string; name: string | null; problem: string | null }>;
  labels: string[];
  dueDate: string | null;
  parent: string | null;
  issues: string[];
}

export interface ImportAnalysis {
  source: ImportSource;
  detected: ImportSource;
  sources: Array<{ id: ImportSource; label: string; hint: string; compatible: boolean }>;
  columns: string[];
  mapping: ImportMapping;
  dateOrder: { order: DateOrder; ambiguous: boolean; inferred: boolean };
  totalRows: number;
  fileWarnings: string[];
  states: Array<{ id: string; name: string; group: StateGroup }>;
  members: Array<{ id: string; name: string }>;
  statuses: PlannedStatus[];
  priorities: PlannedPriority[];
  people: PlannedPerson[];
  newStates: Array<{ name: string; group: StateGroup }>;
  newLabels: string[];
  droppedLabels: string[];
  counts: { create: number; update: number; skip: number; parentsOutsideFile: number };
  notes: string[];
  preview: PreviewRow[];
}

export const ACTIVE_STATUSES: readonly ImportStatus[] = ["PENDING", "RUNNING"];
export const FINAL_STATUSES: readonly ImportStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED"];
