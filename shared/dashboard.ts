// The customizable Dashboard: which modules exist, the sizes a module can take, the shape of a
// saved layout, and the built-in default (today's Dashboard, before anyone customizes it).
// Shared by the server (to check a layout before saving it) and the page.

export const MODULE_TYPES = [
  // the original Dashboard
  "kpis", "windowWatch", "byAssetType", "byLevel", "pipeline", "forecast", "winRates", "workload", "reassessment", "retention",
  // added in 10e
  "deadlines", "tasks", "week", "decisions", "refunds", "readyToBill", "aging", "collected", "trust", "expenses",
  "topClients", "savingsByYear", "recentProperties", "coCounsel", "imports", "customKpi",
] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];

/** Widths on the 12-column grid: Small, Medium, Half, Wide, Full. */
export const WIDTHS = [3, 4, 6, 8, 12] as const;
export type Width = (typeof WIDTHS)[number];
export const WIDTH_LABELS: Record<Width, string> = { 3: "Small", 4: "Medium", 6: "Half", 8: "Wide", 12: "Full width" };

/** Heights: as tall as the content, or a fixed height with the rest scrolling inside. */
export const HEIGHTS = ["auto", "s", "m", "l"] as const;
export type Height = (typeof HEIGHTS)[number];
export const HEIGHT_LABELS: Record<Height, string> = { auto: "Fit content", s: "Short", m: "Medium", l: "Tall" };
export const HEIGHT_PX: Record<Exclude<Height, "auto">, number> = { s: 300, m: 460, l: 640 };

export type Settings = Record<string, string>;
export interface ModuleInstance { uid: string; type: ModuleType; w: Width; h: Height; settings?: Settings }
export interface Layout { version: 1; modules: ModuleInstance[] }

/** Settings a module offers, with their choices; the first choice is the default. */
export interface SettingDef { key: string; label: string; choices: [string, string][] }
export const SCOPE: SettingDef = { key: "scope", label: "Whose", choices: [["mine", "Mine"], ["all", "Everyone's"]] };

export const KPI_METRICS: [string, string][] = [
  ["properties", "Active properties"],
  ["appeals", "Appeals"],
  ["savingsAchieved", "Savings achieved"],
  ["savingsInPlay", "Estimated savings in play"],
  ["feesBilled", "Fees billed"],
  ["collected", "Collected"],
];
export const KPI_LEVELS: [string, string][] = [["", "Any level"], ["assessor", "Assessor"], ["bor", "Board of Review"], ["ptab", "PTAB"], ["circuit", "Circuit Court"]];
export const KPI_GROUPS: [string, string][] = [["", "Any type"], ["residential", "Residential"], ["commercial", "Commercial"], ["industrial", "Industrial"]];
export const KPI_YEARS: [string, string][] = [["", "All years"], ["current", "This year"], ["last", "Last year"]];

export interface ModuleDef {
  type: ModuleType; title: string; description: string; w: Width; h?: Height;
  settings?: SettingDef[];
  /** Can be added more than once (each with its own settings). */
  multi?: boolean;
  group: "Matters" | "Deadlines and work" | "Money" | "Results";
}

export const MODULES: Record<ModuleType, ModuleDef> = {
  kpis: { type: "kpis", title: "Headline numbers", description: "Unfiled with the window open, savings in play, fees ready to bill, the six-month fee forecast and savings achieved.", w: 12, group: "Matters" },
  windowWatch: { type: "windowWatch", title: "Window watch", description: "Open and upcoming filing windows where you have properties, with how many aren't filed.", w: 8, group: "Deadlines and work" },
  byAssetType: { type: "byAssetType", title: "Properties by asset type", description: "Active properties as Residential, Commercial and Industrial.", w: 4, group: "Matters" },
  byLevel: { type: "byLevel", title: "Properties at each level", description: "Where each property's current appeal sits: Assessor, BOR, PTAB, Circuit Court.", w: 4, group: "Matters" },
  pipeline: { type: "pipeline", title: "Pipeline by level and substage", description: "Every current appeal by level and substage, with average days in each, and what's stalled.", w: 12, group: "Matters" },
  forecast: { type: "forecast", title: "When fees land", description: "Assessor and BOR fees by the month their decisions are expected, with the money detail.", w: 6, group: "Money" },
  winRates: { type: "winRates", title: "Win rate and average reduction", description: "Decided appeals by level, asset type, township and analyst.", w: 6, group: "Results" },
  workload: { type: "workload", title: "Analyst workload", description: "Open matters, appeals filed this cycle and hearings in the next 30 days, per analyst.", w: 4, group: "Deadlines and work" },
  reassessment: { type: "reassessment", title: "Reassessment exposure", description: "Active properties in jurisdictions reassessed next year, by township.", w: 4, group: "Matters" },
  retention: { type: "retention", title: "Retention", description: "Properties carried over from earlier cycles, and the ones at risk.", w: 4, group: "Results" },

  deadlines: { type: "deadlines", title: "Deadlines and hearings, next 14 days", description: "Hearings, evidence dates and filing deadlines coming up, soonest first.", w: 4, settings: [SCOPE], group: "Deadlines and work" },
  tasks: { type: "tasks", title: "Tasks", description: "Open tasks and reminders, overdue first.", w: 4, settings: [SCOPE], group: "Deadlines and work" },
  week: { type: "week", title: "This week", description: "A small calendar of this week: deadlines, hearings, meetings and windows closing.", w: 8, settings: [SCOPE], group: "Deadlines and work" },
  decisions: { type: "decisions", title: "Decisions to review", description: "Decision letters that matched cleanly and those waiting for a look.", w: 4, group: "Deadlines and work" },
  refunds: { type: "refunds", title: "Awaiting refund", description: "PTAB and Circuit Court reductions whose refund check hasn't arrived, longest waiting first.", w: 4, group: "Money" },
  readyToBill: { type: "readyToBill", title: "Ready to bill", description: "Decided reductions to invoice, and the ones still missing tax figures.", w: 4, group: "Money" },
  aging: { type: "aging", title: "Aged receivables", description: "Unpaid invoices by how long they've been due: current, 1 to 30, 31 to 60, 61 to 90, over 90 days.", w: 6, group: "Money" },
  collected: { type: "collected", title: "Collected", description: "Payments received this month and this year, by month.", w: 6, group: "Money" },
  trust: { type: "trust", title: "Trust balances held", description: "Client money held in trust, by client.", w: 4, group: "Money" },
  expenses: { type: "expenses", title: "Expenses not yet recovered", description: "Costs the firm fronted that aren't on an invoice or settlement yet.", w: 4, group: "Money" },
  topClients: { type: "topClients", title: "Top clients by savings", description: "Clients ranked by savings achieved in an assessment year.", w: 4, settings: [{ key: "year", label: "Year", choices: [["current", "This year"], ["last", "Last year"], ["all", "All years"]] }], group: "Results" },
  savingsByYear: { type: "savingsByYear", title: "Savings achieved by year", description: "Savings from reduced appeals, by assessment year.", w: 6, group: "Results" },
  recentProperties: { type: "recentProperties", title: "Recently added properties", description: "The newest properties, with their photos.", w: 4, group: "Matters" },
  coCounsel: { type: "coCounsel", title: "Co-counseled matters", description: "Properties shared with another firm, by firm, with our role and their share.", w: 4, group: "Matters" },
  imports: { type: "imports", title: "Recent imports", description: "The latest bulk imports, what they brought in, and any still to commit.", w: 4, group: "Matters" },
  customKpi: {
    type: "customKpi", title: "Your number", description: "A single figure you build: pick what to count or total, and narrow it by level, type and year.", w: 3, multi: true, group: "Results",
    settings: [
      { key: "metric", label: "Figure", choices: KPI_METRICS },
      { key: "level", label: "Level", choices: KPI_LEVELS },
      { key: "group", label: "Type", choices: KPI_GROUPS },
      { key: "year", label: "Year", choices: KPI_YEARS },
    ],
  },
};

/** Today's Dashboard, the starting point before a firm or a person customizes it. */
export const BUILT_IN_LAYOUT: Layout = {
  version: 1,
  modules: ([
    ["kpis", 12], ["windowWatch", 8], ["byAssetType", 4], ["byLevel", 4], ["pipeline", 12],
    ["forecast", 6], ["winRates", 6], ["workload", 4], ["reassessment", 4], ["retention", 4],
  ] as [ModuleType, Width][]).map(([type, w]) => ({ uid: type, type, w, h: "auto" as Height })),
};

/** A layout as saved, cleaned: unknown modules dropped (a module retired later), settings kept to their choices. */
export function cleanLayout(raw: unknown): Layout | null {
  if (!raw || typeof raw !== "object") return null;
  const mods = (raw as { modules?: unknown }).modules;
  if (!Array.isArray(mods)) return null;
  const seen = new Set<string>();
  const modules: ModuleInstance[] = [];
  for (const m of mods.slice(0, 40)) {
    if (!m || typeof m !== "object") continue;
    const x = m as Record<string, unknown>;
    const type = x.type as ModuleType;
    if (!(MODULE_TYPES as readonly string[]).includes(type)) continue;
    const uid = typeof x.uid === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(x.uid) ? x.uid : null;
    if (!uid || seen.has(uid)) continue;
    const def = MODULES[type];
    if (!def.multi && modules.some((y) => y.type === type)) continue;
    seen.add(uid);
    const w = (WIDTHS as readonly number[]).includes(Number(x.w)) ? (Number(x.w) as Width) : def.w;
    const h = (HEIGHTS as readonly string[]).includes(String(x.h)) ? (x.h as Height) : "auto";
    const settings: Settings = {};
    const given = (x.settings && typeof x.settings === "object" ? x.settings : {}) as Record<string, unknown>;
    for (const s of def.settings ?? []) {
      const v = String(given[s.key] ?? "");
      settings[s.key] = s.choices.some(([c]) => c === v) ? v : s.choices[0][0];
    }
    modules.push({ uid, type, w, h, ...(def.settings ? { settings } : {}) });
  }
  return { version: 1, modules };
}
