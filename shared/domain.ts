// Domain vocabulary shared by the API and the web app.

export const LEVELS = ["assessor", "bor", "ptab", "circuit"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<Level, string> = {
  assessor: "Assessor",
  bor: "Board of Review",
  ptab: "PTAB",
  circuit: "Circuit Court",
};

export const SUBSTAGES = [
  "under_review",
  "fairly_assessed",
  "appeal_filed",
  "hearing_scheduled",
  "decision_analysis",
  "invoice_sent",
  "pushed_next_level",
  "closed",
] as const;
export type Substage = (typeof SUBSTAGES)[number];

export const SUBSTAGE_LABELS: Record<Substage, string> = {
  under_review: "Under review",
  fairly_assessed: "Fairly assessed",
  appeal_filed: "Appeal filed",
  hearing_scheduled: "Hearing scheduled",
  decision_analysis: "Decision analysis",
  invoice_sent: "Invoice sent",
  pushed_next_level: "Pushed to next level",
  closed: "Closed",
};

/** Which substages each level uses, in order. */
export const LEVEL_SUBSTAGES: Record<Level, Substage[]> = {
  assessor: ["under_review", "fairly_assessed", "appeal_filed", "decision_analysis", "invoice_sent", "pushed_next_level"],
  bor: ["under_review", "fairly_assessed", "appeal_filed", "hearing_scheduled", "decision_analysis", "invoice_sent", "pushed_next_level"],
  ptab: ["under_review", "fairly_assessed", "appeal_filed", "hearing_scheduled", "decision_analysis", "invoice_sent"],
  circuit: ["under_review", "fairly_assessed", "appeal_filed", "hearing_scheduled", "decision_analysis", "invoice_sent"],
};

export const APPEAL_STATUSES = [
  "open",
  "waiting_decision",
  "reduced",
  "no_change",
  "increased",
  "withdrawn",
  "dismissed",
] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

export const APPEAL_STATUS_LABELS: Record<AppealStatus, string> = {
  open: "Open",
  waiting_decision: "Waiting for decision",
  reduced: "Reduced",
  no_change: "No change",
  increased: "Increased",
  withdrawn: "Withdrawn",
  dismissed: "Dismissed",
};

export const ROLES = ["attorney", "analyst", "operations"] as const;
export type Role = (typeof ROLES)[number];

/** Operations: non-attorney staff and outside consultants who support a firm. */
export const ROLE_LABELS: Record<Role, string> = { attorney: "Attorney", analyst: "Analyst", operations: "Operations" };

/**
 * Permission keys. Attorney, Analyst and Operations start with every permission;
 * a firm admin can turn individual ones off per role (role_permissions table).
 */
export const PERMISSIONS = [
  "properties.edit",
  "properties.delete",
  "accounts.edit",
  "appeals.edit",
  "fees.edit",
  "invoices.send",
  "invoices.void",
  "decisions.apply",
] as const;
// Managing users, permissions, support access and integrations (Dropbox) belongs to
// firm admins, a switch on each user rather than a role permission.
export type Permission = (typeof PERMISSIONS)[number];

/** Default fee terms for a new firm. */
export const DEFAULT_FEES: { level: Level; percent: string; basis: "first_year_savings" | "refund" }[] = [
  { level: "assessor", percent: "40.00", basis: "first_year_savings" },
  { level: "bor", percent: "40.00", basis: "first_year_savings" },
  { level: "ptab", percent: "33.33", basis: "refund" },
  { level: "circuit", percent: "33.33", basis: "refund" },
];

/** "05-17-302-010-0000" -> "05-17-302-010" for matter titles (Cook 14-digit PINs). */
export function shortPin(pin: string): string {
  const m = pin.match(/^(\d{2}-\d{2}-\d{3}-\d{3})-0000$/);
  return m ? m[1] : pin;
}

/** Matter title: "PIN – Address, City (Township)". */
export function matterTitle(pin: string | null, address: string, city: string | null, township: string | null): string {
  const head = pin ? `${shortPin(pin)} – ` : "";
  const place = [address, city].filter(Boolean).join(", ");
  return `${head}${place}${township ? ` (${township})` : ""}`;
}

/**
 * The PIN reduced to its digits, with a Cook PIN's trailing "0000" dropped, so
 * "05-17-302-010" and "05-17-302-010-0000" are the same parcel. A PIN is the
 * firm's unique key for a matter (the database enforces it too: parcels.pin_key).
 */
export function pinKey(pin: string): string {
  const digits = pin.replace(/\D/g, "");
  return digits.length === 14 && digits.endsWith("0000") ? digits.slice(0, 10) : digits;
}
