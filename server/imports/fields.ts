// What an import can bring in: six kinds of record, their fields, the column names each field is
// recognized by (other software's exports included: Dillon's prior system's Account Workbook and
// Property Detail reports), and how a sheet is recognized as one kind.

export const ENTITIES = ["client", "property", "parcel", "appeal", "contact", "activity"] as const;
export type Entity = (typeof ENTITIES)[number];
export const ENTITY_LABELS: Record<Entity, string> = {
  client: "Clients", property: "Properties", parcel: "PINs (parcels)", appeal: "Appeals and values", contact: "Contacts", activity: "Activities and notes",
};

export type FieldType = "text" | "int" | "money" | "decimal" | "date" | "year" | "level" | "status" | "pin" | "propstatus" | "asset" | "bool";
export interface Field { key: string; label: string; type: FieldType; aliases: string[]; required?: boolean; note?: string }

const CLIENT_NAME = ["client", "client name", "account", "account name", "customer", "customer name"];
const CLIENT_NO = ["account #", "account number", "account no", "client #", "client number", "client id"];
const PROPERTY_NAME = ["property", "property name"];
const PIN = ["pin", "parcel #", "parcel number", "parcel no", "parcel"];

export const FIELDS: Record<Entity, Field[]> = {
  client: [
    { key: "name", label: "Client name", type: "text", aliases: [...CLIENT_NAME, "name"], required: true },
    { key: "accountNumber", label: "Client number", type: "text", aliases: CLIENT_NO },
    { key: "accountType", label: "Individual or entity", type: "text", aliases: ["account type", "client type", "type"] },
    { key: "address1", label: "Address", type: "text", aliases: ["address", "address 1", "mailing address", "street"] },
    { key: "city", label: "City", type: "text", aliases: ["city"] },
    { key: "state", label: "State", type: "text", aliases: ["state"] },
    { key: "zip", label: "ZIP", type: "text", aliases: ["zip", "zip code", "postal code"] },
    { key: "phone", label: "Phone", type: "text", aliases: ["phone", "work phone", "telephone"] },
    { key: "email", label: "Email", type: "text", aliases: ["email", "email address", "e-mail"] },
    { key: "notes", label: "Notes", type: "text", aliases: ["notes"] },
  ],
  property: [
    { key: "client", label: "Client name", type: "text", aliases: CLIENT_NAME, note: "Which client it belongs to. A file from one client's report can leave this out." },
    { key: "clientNumber", label: "Client number", type: "text", aliases: CLIENT_NO },
    { key: "name", label: "Property name", type: "text", aliases: PROPERTY_NAME },
    { key: "propertyNumber", label: "Property number", type: "text", aliases: ["property #", "property number", "property no"] },
    { key: "pin", label: "PIN", type: "pin", aliases: PIN, note: "With a PIN here, the property's primary PIN is made from the same row." },
    { key: "address1", label: "Address", type: "text", aliases: ["address", "address 1", "property address", "street"], required: true },
    { key: "address2", label: "Address line 2", type: "text", aliases: ["address line 2", "address 2"] },
    { key: "city", label: "City", type: "text", aliases: ["city"], required: true },
    { key: "state", label: "State", type: "text", aliases: ["state"] },
    { key: "zip", label: "ZIP", type: "text", aliases: ["zip", "zip code"] },
    { key: "county", label: "County", type: "text", aliases: ["county"], required: true },
    { key: "township", label: "Township", type: "text", aliases: ["township"] },
    { key: "taxCode", label: "Tax code", type: "text", aliases: ["district", "tax district", "tax code"] },
    { key: "status", label: "Status", type: "propstatus", aliases: ["property status", "status"] },
    { key: "assetType", label: "Asset type", type: "asset", aliases: ["asset type", "property type"] },
    { key: "use", label: "Use", type: "text", aliases: ["usage type", "use", "use type", "usage"] },
    { key: "purchaseDate", label: "Purchase date", type: "date", aliases: ["purchase date", "sale date"] },
    { key: "purchasePrice", label: "Purchase price", type: "money", aliases: ["purchase price", "sale price"] },
    { key: "yearBuilt", label: "Year built", type: "year", aliases: ["year built"] },
    { key: "acreage", label: "Acreage", type: "decimal", aliases: ["acreage", "acres"] },
    { key: "units", label: "Units", type: "int", aliases: ["units", "unit count", "number of units"] },
    { key: "buildingSqft", label: "Building sq ft", type: "int", aliases: ["sq ft", "sq. ft.", "square feet", "building sq ft", "building sf", "bldg sf", "square footage"] },
    { key: "landSqft", label: "Land sq ft", type: "int", aliases: ["land sq ft", "land sf", "land square feet"] },
    { key: "noFee", label: "No fee", type: "bool", aliases: ["no fee property", "no fee"] },
    { key: "notes", label: "Notes", type: "text", aliases: ["notes", "property notes", "description"] },
  ],
  parcel: [
    { key: "property", label: "Property name", type: "text", aliases: PROPERTY_NAME },
    { key: "client", label: "Client name", type: "text", aliases: CLIENT_NAME },
    { key: "pin", label: "PIN", type: "pin", aliases: PIN, required: true },
    { key: "alternatePin", label: "Alternate PIN", type: "text", aliases: ["alternate parcel #", "alternate pin", "alt pin"] },
    { key: "owner", label: "Owner of record", type: "text", aliases: ["owner", "owner name", "owner of record"] },
    { key: "class", label: "Class", type: "text", aliases: ["classification", "class", "property class"] },
    { key: "parcelType", label: "Real or personal", type: "text", aliases: ["parcel type"] },
    { key: "address", label: "Address", type: "text", aliases: ["address", "parcel address"] },
    { key: "city", label: "City", type: "text", aliases: ["city", "parcel city"] },
    { key: "state", label: "State", type: "text", aliases: ["state", "parcel state"] },
    { key: "zip", label: "ZIP", type: "text", aliases: ["zip", "parcel zip"] },
    { key: "status", label: "Active or inactive", type: "text", aliases: ["status", "parcel status"] },
  ],
  appeal: [
    { key: "pin", label: "PIN", type: "pin", aliases: PIN, required: true },
    { key: "property", label: "Property name", type: "text", aliases: PROPERTY_NAME },
    { key: "assessmentYear", label: "Assessment year", type: "year", aliases: ["asmt year", "assessment year", "year"], required: true },
    { key: "taxYear", label: "Tax year", type: "year", aliases: ["tax year"] },
    { key: "level", label: "Level", type: "level", aliases: ["appeal type", "level", "appeal level", "tribunal"], required: true },
    { key: "status", label: "Result or status", type: "status", aliases: ["appeal status", "status", "result"] },
    { key: "externalId", label: "Appeal ID", type: "text", aliases: ["appeal id", "appeal number", "appeal #"] },
    { key: "petitionNo", label: "Docket or complaint number", type: "text", aliases: ["docket", "docket #", "petition", "petition #", "complaint #", "complaint number"] },
    { key: "representative", label: "Representative", type: "text", aliases: ["representative", "attorney"] },
    { key: "origAv", label: "Original AV", type: "money", aliases: ["orig av", "original av", "av"] },
    { key: "origLand", label: "Original land AV", type: "money", aliases: ["orig land av", "original land", "land av"] },
    { key: "origImpr", label: "Original building AV", type: "money", aliases: ["orig impr av", "orig building av", "original building", "building av", "improvement av"] },
    { key: "targetAv", label: "Target AV", type: "money", aliases: ["target av"] },
    { key: "resolvedAv", label: "Decided AV", type: "money", aliases: ["resolved av", "decided av", "final av"] },
    { key: "resolvedLand", label: "Decided land AV", type: "money", aliases: ["resolved land av", "decided land av"] },
    { key: "resolvedImpr", label: "Decided building AV", type: "money", aliases: ["resolved impr av", "decided building av"] },
    { key: "origTax", label: "Original net tax", type: "money", aliases: ["orig net tax", "original net tax", "original tax"] },
    { key: "targetTax", label: "Target net tax", type: "money", aliases: ["target net tax", "target tax"] },
    { key: "resolvedTax", label: "Decided net tax", type: "money", aliases: ["resolved net tax", "decided net tax", "resolved tax"] },
    { key: "estimatedSavings", label: "Estimated savings", type: "money", aliases: ["target savings", "estimated savings"] },
    { key: "savings", label: "Savings achieved", type: "money", aliases: ["resolved savings", "savings", "actual savings"] },
    { key: "filedOn", label: "Filed on", type: "date", aliases: ["filed on", "filing date", "date filed"] },
    { key: "decisionOn", label: "Decision date", type: "date", aliases: ["decision date", "decided on", "date decided"] },
  ],
  contact: [
    { key: "client", label: "Client name", type: "text", aliases: CLIENT_NAME },
    { key: "property", label: "Property name", type: "text", aliases: PROPERTY_NAME },
    { key: "name", label: "Name", type: "text", aliases: ["contact name", "name", "contact"], required: true },
    { key: "title", label: "Title", type: "text", aliases: ["title"] },
    { key: "role", label: "Role", type: "text", aliases: ["role", "contact type"] },
    { key: "email", label: "Email", type: "text", aliases: ["email address", "email", "e-mail"] },
    { key: "phone", label: "Phone", type: "text", aliases: ["work phone", "phone", "telephone"] },
    { key: "mobile", label: "Mobile", type: "text", aliases: ["cell phone", "mobile", "cell"] },
    { key: "address", label: "Address", type: "text", aliases: ["address"] },
    { key: "notes", label: "Notes", type: "text", aliases: ["notes"] },
  ],
  activity: [
    { key: "client", label: "Client name", type: "text", aliases: CLIENT_NAME },
    { key: "property", label: "Property name", type: "text", aliases: PROPERTY_NAME },
    { key: "pin", label: "PIN", type: "pin", aliases: PIN },
    { key: "scope", label: "Client or property", type: "text", aliases: ["type", "level", "scope"], note: "\"Account\" puts it on the client; anything else on the property." },
    { key: "subject", label: "Note or task", type: "text", aliases: ["note", "notes", "subject", "activity", "description"], required: true },
    { key: "dueOn", label: "Due or follow-up date", type: "date", aliases: ["date due", "due date", "follow-up date", "follow up date", "due"] },
    { key: "assignedTo", label: "Assigned to", type: "text", aliases: ["assigned to", "assignee", "owner"] },
    { key: "status", label: "Open or done", type: "text", aliases: ["status"] },
  ],
};

/** "Orig  AV", "orig_av", "ORIG AV" all become "origav". */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]/g, "");

/** Sheet names that say what they hold (the prior software's report tabs among them). */
const SHEET_HINTS: [RegExp, Entity | "skip"][] = [
  [/^(account summary|overview|values by year|appeals by parcel|summary)$/i, "skip"],
  [/^active appeals$/i, "skip"], // the same appeals as All Appeals
  [/client|account/i, "client"],
  [/parcel/i, "parcel"],
  [/propert/i, "property"],
  [/appeal|value/i, "appeal"],
  [/contact/i, "contact"],
  [/activit|note|task/i, "activity"],
];

/** Which kind of record a sheet holds: by its name first, else by how many of its headers a kind recognizes. */
export function detectEntity(sheetName: string, headers: string[], siblings: string[]): Entity | "skip" {
  if (/^active appeals$/i.test(sheetName) && !siblings.some((s) => /^all appeals$/i.test(s))) return "appeal";
  for (const [re, e] of SHEET_HINTS) if (re.test(sheetName.trim())) return e;
  const hs = headers.map(norm);
  let best: Entity | "skip" = "skip";
  let score = 0;
  for (const e of ENTITIES) {
    // Each recognized column counts, a required one a little more (so a lone "PIN" column reads as PINs, not properties).
    const hit = FIELDS[e].filter((f) => [f.label, ...f.aliases].some((a) => hs.includes(norm(a))));
    const s = hit.length + hit.filter((f) => f.required).length / 2;
    if (s > score) { best = e; score = s; }
  }
  return best;
}

/** The CSV template for a kind of record: one column per field, headed by its label. */
export function templateCsv(entity: Entity): string {
  return FIELDS[entity].map((f) => (/[",]/.test(f.label) ? `"${f.label.replace(/"/g, '""')}"` : f.label)).join(",") + "\r\n";
}

/** The first header that matches each field (exact alias, after norm), never the same header twice. */
export function autoMap(entity: Entity, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of FIELDS[entity]) {
    for (const a of [f.label, ...f.aliases]) {
      const h = headers.find((x) => !used.has(x) && norm(x) === norm(a));
      if (h) { out[f.key] = h; used.add(h); break; }
    }
  }
  return out;
}
