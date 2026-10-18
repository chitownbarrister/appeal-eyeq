// Side-panel forms: property (new and edit), client (new and edit), fee
// terms, and new appeal. Each posts to the API and calls onSaved.

import { useMemo, useState } from "react";
import { api, errorText } from "../api";
import { useCounties, useFirmUsers } from "../data";
import { cleanNumber, nn } from "../format";
import { LEVELS, LEVEL_LABELS, type Level } from "../../../shared/domain";
import { Sheet } from "./Sheet";

export interface PropertyRecord {
  id: number; account_id: number; account_name?: string; name: string; address1: string | null; address2: string | null; city: string | null;
  state: string; zip: string | null; county_id: number; township_id: number | null; tax_code: string | null; tax_code_confirmed: boolean;
  asset_type: "residential" | "commercial" | "industrial"; use_type: string | null; level_of_assessment: string | null; attorney_user_id: number | null;
  analyst_user_id: number | null; status: string; purchase_date: string | null; purchase_price: string | null; year_built: number | null;
  building_sqft: number | null; units: number | null; acreage: string | null; notes: string | null; no_fee: boolean;
  fee_percent_first_year: string | null; fee_percent_refund: string | null;
}

export interface AccountRecord {
  id: number; name: string; account_type: "individual" | "entity"; account_number: string | null; address1: string | null; address2: string | null;
  city: string | null; state: string | null; zip: string | null; phone: string | null; email: string | null; account_rep_user_id: number | null;
  source: string | null; status: "active" | "inactive"; fee_type: "contingency" | "flat"; fee_percent_first_year: string | null;
  fee_percent_refund: string | null; fee_cap: string | null; flat_fee: string | null; fee_memo: string | null; no_fee: boolean;
  co_counsel: string | null; co_counsel_fee: string | null; owners_of_record: string | null; notes: string | null;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const intOrNull = (v: string) => (v.trim() === "" ? null : Number(cleanNumber(v)));

function SaveFooter({ busy, label, onClose, error }: { busy: boolean; label: string; onClose: () => void; error: string }) {
  return (
    <>
      {error && <span className="error" role="alert" style={{ margin: 0, flexBasis: "100%" }}>{error}</span>}
      <span className="sp" />
      <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn" disabled={busy}>{busy ? "Saving" : label}</button>
    </>
  );
}

// ---------------------------------------------------------------- property
export function PropertySheet({
  existing, presetAccount, accounts, onClose, onSaved,
}: {
  existing?: PropertyRecord;
  presetAccount?: { id: number; name: string };
  accounts: { id: number; name: string }[];
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const users = useFirmUsers();
  const { counties, townships } = useCounties();
  const thisYear = new Date().getFullYear();
  const [f, setF] = useState({
    accountId: str(existing?.account_id ?? presetAccount?.id ?? ""),
    newAccountName: "", newAccountType: "individual",
    address1: str(existing?.address1), address2: str(existing?.address2), city: str(existing?.city), zip: str(existing?.zip),
    countyId: str(existing?.county_id), townshipId: str(existing?.township_id), pin: "", ownerName: "",
    taxCode: str(existing?.tax_code), taxCodeConfirmed: existing?.tax_code_confirmed ?? false,
    assetType: existing?.asset_type ?? "residential", useType: str(existing?.use_type), levelOfAssessment: str(existing?.level_of_assessment),
    attorneyUserId: str(existing?.attorney_user_id), analystUserId: str(existing?.analyst_user_id), status: existing?.status ?? "active",
    purchaseDate: str(existing?.purchase_date), purchasePrice: str(existing?.purchase_price), yearBuilt: str(existing?.year_built),
    buildingSqft: str(existing?.building_sqft), units: str(existing?.units), acreage: str(existing?.acreage), notes: str(existing?.notes),
    startAppeal: !existing, appealYear: String(thisYear), appealLevel: "assessor" as Level,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const countyTownships = useMemo(() => townships.filter((t) => String(t.county_id) === f.countyId).sort((a, b) => a.name.localeCompare(b.name)), [townships, f.countyId]);
  const countyName = counties.find((c) => String(c.id) === f.countyId)?.name;
  const ratioHint = countyName === "Cook" ? (f.assetType === "residential" ? "10" : "25") : countyName ? "33.33" : "";
  const newClient = f.accountId === "new";

  async function save() {
    setBusy(true);
    setError("");
    const common = {
      address1: f.address1.trim(), address2: nn(f.address2), city: f.city.trim(), zip: nn(f.zip), countyId: Number(f.countyId),
      townshipId: f.townshipId ? Number(f.townshipId) : null, taxCode: nn(f.taxCode), taxCodeConfirmed: f.taxCodeConfirmed,
      assetType: f.assetType, useType: nn(f.useType), levelOfAssessment: nn(cleanNumber(f.levelOfAssessment)),
      attorneyUserId: f.attorneyUserId ? Number(f.attorneyUserId) : null, analystUserId: f.analystUserId ? Number(f.analystUserId) : null,
      purchaseDate: nn(f.purchaseDate), purchasePrice: nn(cleanNumber(f.purchasePrice)), yearBuilt: intOrNull(f.yearBuilt),
      buildingSqft: intOrNull(f.buildingSqft), units: intOrNull(f.units), acreage: nn(cleanNumber(f.acreage)), notes: nn(f.notes),
    };
    try {
      if (existing) {
        await api(`/firm/properties/${existing.id}`, {
          method: "PATCH",
          body: { ...common, name: f.address1.trim(), status: f.status, accountId: Number(f.accountId) },
        });
        onSaved(existing.id);
      } else {
        const r = await api<{ id: number }>("/firm/properties", {
          method: "POST",
          body: {
            ...common,
            ...(newClient ? { newAccount: { name: f.newAccountName.trim(), accountType: f.newAccountType } } : { accountId: Number(f.accountId) }),
            pin: f.pin.trim(), ownerName: nn(f.ownerName),
            ...(f.startAppeal ? { firstAppeal: { assessmentYear: Number(f.appealYear), level: f.appealLevel } } : {}),
          },
        });
        onSaved(r.id);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      eyebrow={existing ? "Edit matter" : "New matter"}
      title={existing ? existing.name : "New property"}
      onClose={onClose}
      onSubmit={() => void save()}
      footer={<SaveFooter busy={busy} label={existing ? "Save changes" : "Create property"} onClose={onClose} error={error} />}
    >
      <div className="fld">
        <label htmlFor="pf-client">Client</label>
        <select id="pf-client" className="in" value={f.accountId} onChange={set("accountId")} required>
          <option value="" disabled>Choose a client</option>
          {!existing && <option value="new">+ New client</option>}
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      {newClient && (
        <div className="fgrid">
          <div className="fld"><label htmlFor="pf-nc">New client name</label><input id="pf-nc" className="in" value={f.newAccountName} onChange={set("newAccountName")} required placeholder="Last, First or entity name" /></div>
          <div className="fld">
            <label htmlFor="pf-nct">Type</label>
            <select id="pf-nct" className="in" value={f.newAccountType} onChange={set("newAccountType")}>
              <option value="individual">Individual</option><option value="entity">Entity</option>
            </select>
          </div>
        </div>
      )}
      <div className="fgrid">
        <div className="fld span2"><label htmlFor="pf-a1">Address</label><input id="pf-a1" className="in" value={f.address1} onChange={set("address1")} required /></div>
        <div className="fld"><label htmlFor="pf-city">City</label><input id="pf-city" className="in" value={f.city} onChange={set("city")} required /></div>
        <div className="fld"><label htmlFor="pf-zip">ZIP</label><input id="pf-zip" className="in" value={f.zip} onChange={set("zip")} inputMode="numeric" /></div>
        <div className="fld">
          <label htmlFor="pf-county">County</label>
          <select id="pf-county" className="in" value={f.countyId} onChange={(e) => setF({ ...f, countyId: e.target.value, townshipId: "" })} required>
            <option value="" disabled>Choose</option>
            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="pf-twp">Township</label>
          <select id="pf-twp" className="in" value={f.townshipId} onChange={set("townshipId")} disabled={!f.countyId}>
            <option value="">Not set</option>
            {countyTownships.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        {!existing && (
          <>
            <div className="fld"><label htmlFor="pf-pin">PIN</label><input id="pf-pin" className="in" value={f.pin} onChange={set("pin")} required placeholder="05-17-302-010-0000" /></div>
            <div className="fld"><label htmlFor="pf-owner">Owner of record</label><input id="pf-owner" className="in" value={f.ownerName} onChange={set("ownerName")} /></div>
          </>
        )}
        <div className="fld">
          <label htmlFor="pf-type">Asset type</label>
          <select id="pf-type" className="in" value={f.assetType} onChange={set("assetType")}>
            <option value="residential">Residential</option><option value="commercial">Commercial</option><option value="industrial">Industrial</option>
          </select>
        </div>
        <div className="fld"><label htmlFor="pf-use">Use</label><input id="pf-use" className="in" value={f.useType} onChange={set("useType")} placeholder="Single family, retail, warehouse" /></div>
        <div className="fld">
          <label htmlFor="pf-tax">Tax code</label>
          <input id="pf-tax" className="in" value={f.taxCode} onChange={set("taxCode")} placeholder="23008" />
          <label className="check"><input type="checkbox" checked={f.taxCodeConfirmed} onChange={(e) => setF({ ...f, taxCodeConfirmed: e.target.checked })} /> Confirmed against the tax bill</label>
        </div>
        <div className="fld">
          <label htmlFor="pf-loa">Level of assessment %</label>
          <input id="pf-loa" className="in num" value={f.levelOfAssessment} onChange={set("levelOfAssessment")} placeholder={ratioHint ? `${ratioHint} (default)` : ""} inputMode="decimal" />
        </div>
        <div className="fld">
          <label htmlFor="pf-atty">Attorney</label>
          <select id="pf-atty" className="in" value={f.attorneyUserId} onChange={set("attorneyUserId")}>
            <option value="">Not assigned</option>
            {users.filter((u) => u.active && u.role === "attorney").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="pf-analyst">Analyst</label>
          <select id="pf-analyst" className="in" value={f.analystUserId} onChange={set("analystUserId")}>
            <option value="">Not assigned</option>
            {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}{u.role === "attorney" ? " (attorney)" : ""}</option>)}
          </select>
        </div>
        {existing && (
          <div className="fld">
            <label htmlFor="pf-status">Status</label>
            <select id="pf-status" className="in" value={f.status} onChange={set("status")}>
              <option value="active">Active</option><option value="closed">Closed</option><option value="inactive">Inactive</option><option value="sold">Sold</option>
            </select>
          </div>
        )}
        <div className="fld"><label htmlFor="pf-pd">Purchase date</label><input id="pf-pd" type="date" className="in" value={f.purchaseDate} onChange={set("purchaseDate")} /></div>
        <div className="fld"><label htmlFor="pf-pp">Purchase price</label><input id="pf-pp" className="in num" value={f.purchasePrice} onChange={set("purchasePrice")} inputMode="decimal" /></div>
        <div className="fld"><label htmlFor="pf-yb">Year built</label><input id="pf-yb" className="in num" value={f.yearBuilt} onChange={set("yearBuilt")} inputMode="numeric" /></div>
        <div className="fld"><label htmlFor="pf-sf">Building sq ft</label><input id="pf-sf" className="in num" value={f.buildingSqft} onChange={set("buildingSqft")} inputMode="numeric" /></div>
        <div className="fld"><label htmlFor="pf-units">Units</label><input id="pf-units" className="in num" value={f.units} onChange={set("units")} inputMode="numeric" /></div>
        <div className="fld"><label htmlFor="pf-acres">Acreage</label><input id="pf-acres" className="in num" value={f.acreage} onChange={set("acreage")} inputMode="decimal" /></div>
        <div className="fld span2"><label htmlFor="pf-notes">Notes</label><textarea id="pf-notes" className="in" value={f.notes} onChange={set("notes")} /></div>
      </div>
      {!existing && (
        <div className="card pad" style={{ background: "var(--hover)" }}>
          <label className="check"><input type="checkbox" checked={f.startAppeal} onChange={(e) => setF({ ...f, startAppeal: e.target.checked })} /> Start an appeal now</label>
          {f.startAppeal && (
            <div className="fgrid" style={{ marginTop: 10 }}>
              <div className="fld" style={{ marginBottom: 0 }}><label htmlFor="pf-ay">Assessment year</label><input id="pf-ay" className="in num" value={f.appealYear} onChange={set("appealYear")} inputMode="numeric" /></div>
              <div className="fld" style={{ marginBottom: 0 }}>
                <label htmlFor="pf-al">Level</label>
                <select id="pf-al" className="in" value={f.appealLevel} onChange={(e) => setF({ ...f, appealLevel: e.target.value as Level })}>
                  {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- client
export function AccountSheet({ existing, onClose, onSaved, canEditFees }: { existing?: AccountRecord; onClose: () => void; onSaved: (id: number) => void; canEditFees: boolean }) {
  const users = useFirmUsers();
  const [f, setF] = useState({
    name: str(existing?.name), accountType: existing?.account_type ?? "individual", accountNumber: str(existing?.account_number),
    address1: str(existing?.address1), address2: str(existing?.address2), city: str(existing?.city), state: str(existing?.state || "IL"), zip: str(existing?.zip),
    phone: str(existing?.phone), email: str(existing?.email), accountRepUserId: str(existing?.account_rep_user_id), source: str(existing?.source),
    status: existing?.status ?? "active", feeType: existing?.fee_type ?? "contingency", feePercentFirstYear: str(existing?.fee_percent_first_year),
    feePercentRefund: str(existing?.fee_percent_refund), feeCap: str(existing?.fee_cap), flatFee: str(existing?.flat_fee), feeMemo: str(existing?.fee_memo),
    noFee: existing?.no_fee ?? false, coCounsel: str(existing?.co_counsel), coCounselFee: str(existing?.co_counsel_fee),
    ownersOfRecord: str(existing?.owners_of_record), notes: str(existing?.notes),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = {
      name: f.name.trim(), accountType: f.accountType, accountNumber: nn(f.accountNumber), address1: nn(f.address1), address2: nn(f.address2),
      city: nn(f.city), state: nn(f.state), zip: nn(f.zip), phone: nn(f.phone), email: nn(f.email),
      accountRepUserId: f.accountRepUserId ? Number(f.accountRepUserId) : null, source: nn(f.source), status: f.status,
      coCounsel: nn(f.coCounsel), coCounselFee: nn(f.coCounselFee), ownersOfRecord: nn(f.ownersOfRecord), notes: nn(f.notes),
    };
    if (canEditFees) {
      Object.assign(body, {
        feeType: f.feeType, feePercentFirstYear: nn(cleanNumber(f.feePercentFirstYear)), feePercentRefund: nn(cleanNumber(f.feePercentRefund)),
        feeCap: nn(cleanNumber(f.feeCap)), flatFee: nn(cleanNumber(f.flatFee)), feeMemo: nn(f.feeMemo), noFee: f.noFee,
      });
    }
    try {
      if (existing) {
        await api(`/firm/accounts/${existing.id}`, { method: "PATCH", body });
        onSaved(existing.id);
      } else {
        const r = await api<{ id: number }>("/firm/accounts", { method: "POST", body });
        onSaved(r.id);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      eyebrow={existing ? "Edit client" : "New client"}
      title={existing ? existing.name : "New client"}
      onClose={onClose}
      onSubmit={() => void save()}
      footer={<SaveFooter busy={busy} label={existing ? "Save changes" : "Create client"} onClose={onClose} error={error} />}
    >
      <div className="fgrid">
        <div className="fld span2"><label htmlFor="af-name">Name</label><input id="af-name" className="in" value={f.name} onChange={set("name")} required placeholder="Last, First or entity name" /></div>
        <div className="fld">
          <label htmlFor="af-type">Type</label>
          <select id="af-type" className="in" value={f.accountType} onChange={set("accountType")}>
            <option value="individual">Individual</option><option value="entity">Entity</option>
          </select>
        </div>
        <div className="fld"><label htmlFor="af-num">Account number</label><input id="af-num" className="in" value={f.accountNumber} onChange={set("accountNumber")} /></div>
        <div className="fld span2"><label htmlFor="af-a1">Mailing address</label><input id="af-a1" className="in" value={f.address1} onChange={set("address1")} /></div>
        <div className="fld"><label htmlFor="af-city">City</label><input id="af-city" className="in" value={f.city} onChange={set("city")} /></div>
        <div className="fgrid" style={{ gap: "0 10px" }}>
          <div className="fld"><label htmlFor="af-st">State</label><input id="af-st" className="in" value={f.state} onChange={set("state")} maxLength={2} /></div>
          <div className="fld"><label htmlFor="af-zip">ZIP</label><input id="af-zip" className="in" value={f.zip} onChange={set("zip")} /></div>
        </div>
        <div className="fld"><label htmlFor="af-phone">Phone</label><input id="af-phone" className="in" value={f.phone} onChange={set("phone")} /></div>
        <div className="fld"><label htmlFor="af-email">Email</label><input id="af-email" type="email" className="in" value={f.email} onChange={set("email")} /></div>
        <div className="fld">
          <label htmlFor="af-rep">Account representative</label>
          <select id="af-rep" className="in" value={f.accountRepUserId} onChange={set("accountRepUserId")}>
            <option value="">Not assigned</option>
            {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div className="fld"><label htmlFor="af-src">Source</label><input id="af-src" className="in" value={f.source} onChange={set("source")} placeholder="Referral, website, past client" /></div>
        {existing && (
          <div className="fld">
            <label htmlFor="af-status">Status</label>
            <select id="af-status" className="in" value={f.status} onChange={set("status")}><option value="active">Active</option><option value="inactive">Inactive</option></select>
          </div>
        )}
        <div className="fld span2"><label htmlFor="af-own">Owners of record</label><input id="af-own" className="in" value={f.ownersOfRecord} onChange={set("ownersOfRecord")} /></div>
      </div>
      <div className="blk" style={{ marginTop: 6 }}>
        <h5>Fee terms</h5>
        {!canEditFees && <p className="meta">Your role can't change fee terms.</p>}
        <fieldset disabled={!canEditFees} style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="check" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.noFee} onChange={(e) => setF({ ...f, noFee: e.target.checked })} /> No fee client (nothing is invoiced)</label>
          <div className="fgrid">
            <div className="fld">
              <label htmlFor="af-ft">Arrangement</label>
              <select id="af-ft" className="in" value={f.feeType} onChange={set("feeType")}><option value="contingency">Contingency</option><option value="flat">Flat fee</option></select>
            </div>
            {f.feeType === "flat" ? (
              <div className="fld"><label htmlFor="af-flat">Flat fee</label><input id="af-flat" className="in num" value={f.flatFee} onChange={set("flatFee")} inputMode="decimal" /></div>
            ) : (
              <div className="fld"><label htmlFor="af-cap">Cap</label><input id="af-cap" className="in num" value={f.feeCap} onChange={set("feeCap")} inputMode="decimal" placeholder="None" /></div>
            )}
            <div className="fld"><label htmlFor="af-fy">Assessor and BOR %</label><input id="af-fy" className="in num" value={f.feePercentFirstYear} onChange={set("feePercentFirstYear")} inputMode="decimal" placeholder="Firm default" /><span className="hint">Of first-year savings</span></div>
            <div className="fld"><label htmlFor="af-rf">PTAB and Circuit Court %</label><input id="af-rf" className="in num" value={f.feePercentRefund} onChange={set("feePercentRefund")} inputMode="decimal" placeholder="Firm default" /><span className="hint">Of the refund</span></div>
            <div className="fld"><label htmlFor="af-cc">Co-counsel</label><input id="af-cc" className="in" value={f.coCounsel} onChange={set("coCounsel")} /></div>
            <div className="fld"><label htmlFor="af-ccf">Co-counsel fee</label><input id="af-ccf" className="in" value={f.coCounselFee} onChange={set("coCounselFee")} /></div>
            <div className="fld span2"><label htmlFor="af-memo">Fee memo</label><textarea id="af-memo" className="in" value={f.feeMemo} onChange={set("feeMemo")} /></div>
          </div>
        </fieldset>
      </div>
      <div className="fld"><label htmlFor="af-notes">Notes</label><textarea id="af-notes" className="in" value={f.notes} onChange={set("notes")} /></div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- property fee terms
export function FeeSheet({
  property, inherited, onClose, onSaved,
}: {
  property: PropertyRecord;
  inherited: { firstYear: string; refund: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({ noFee: property.no_fee, firstYear: str(property.fee_percent_first_year), refund: str(property.fee_percent_refund) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`/firm/properties/${property.id}`, {
        method: "PATCH",
        body: { noFee: f.noFee, feePercentFirstYear: nn(cleanNumber(f.firstYear)), feePercentRefund: nn(cleanNumber(f.refund)) },
      });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet eyebrow="Fee terms" title={property.name} onClose={onClose} onSubmit={() => void save()} footer={<SaveFooter busy={busy} label="Save fee terms" onClose={onClose} error={error} />}>
      <p className="meta" style={{ marginTop: 0 }}>Leave a percent blank to use the client's terms, or the firm default if the client has none. A single appeal can still carry its own percent.</p>
      <label className="check" style={{ marginBottom: 14 }}><input type="checkbox" checked={f.noFee} onChange={(e) => setF({ ...f, noFee: e.target.checked })} /> No fee property (fees are shown as waived, never invoiced)</label>
      <div className="fld"><label htmlFor="fs-fy">Assessor and BOR %</label><input id="fs-fy" className="in num" value={f.firstYear} onChange={(e) => setF({ ...f, firstYear: e.target.value })} placeholder={`${inherited.firstYear} (inherited)`} inputMode="decimal" /><span className="hint">Of first-year projected tax savings, billed when the decision arrives</span></div>
      <div className="fld"><label htmlFor="fs-rf">PTAB and Circuit Court %</label><input id="fs-rf" className="in num" value={f.refund} onChange={(e) => setF({ ...f, refund: e.target.value })} placeholder={`${inherited.refund} (inherited)`} inputMode="decimal" /><span className="hint">Of the refund check</span></div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- new appeal
export function AppealSheet({
  propertyId, parcels, defaultYear, onClose, onSaved,
}: {
  propertyId: number;
  parcels: { id: number; pin: string }[];
  defaultYear: number;
  onClose: () => void;
  onSaved: (appealId: number) => void;
}) {
  const [year, setYear] = useState(String(defaultYear));
  const [level, setLevel] = useState<Level>("assessor");
  const [parcelId, setParcelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: number }>(`/firm/properties/${propertyId}/appeals`, {
        method: "POST",
        body: { assessmentYear: Number(year), level, parcelId: parcelId ? Number(parcelId) : null },
      });
      onSaved(r.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet eyebrow="New appeal" title="Create appeal" onClose={onClose} onSubmit={() => void save()} footer={<SaveFooter busy={busy} label="Create appeal" onClose={onClose} error={error} />}>
      <div className="fld"><label htmlFor="ap-year">Assessment year</label><input id="ap-year" className="in num" value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" required /></div>
      <div className="fld">
        <label htmlFor="ap-level">Level</label>
        <select id="ap-level" className="in" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
        </select>
      </div>
      {parcels.length > 1 && (
        <div className="fld">
          <label htmlFor="ap-parcel">Parcel</label>
          <select id="ap-parcel" className="in" value={parcelId} onChange={(e) => setParcelId(e.target.value)}>
            <option value="">Whole property</option>
            {parcels.map((p) => <option key={p.id} value={p.id}>{p.pin}</option>)}
          </select>
        </div>
      )}
      <p className="meta">The original assessed value starts from the previous level's result for that year, and the equalizer and tax rate come from the latest published figures for this property's tax code. You can change any of them on the Values tab.</p>
    </Sheet>
  );
}
