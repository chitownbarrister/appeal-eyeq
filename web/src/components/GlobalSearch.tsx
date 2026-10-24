import { splitMatterTitle } from "../format";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { LEVEL_LABELS, type Level } from "../../../shared/domain";
import { PropertyAvatar } from "./PropertyPhoto";

interface Results {
  properties: { id: number; title: string; sub: string; photoAt?: string | null; assetType?: string | null }[];
  accounts: { id: number; name: string; city: string | null }[];
  appeals: { id: number; property_id: number; assessment_year: number; level: Level; external_id: string | null; petition_no: string | null; property_name: string }[];
  documents?: { id: number; propertyId: number; name: string; type: string | null; year: number | null; level: Level | null; relPath: string | null; property: string; city: string | null }[];
}

interface Item { key: string; to: string; label: string; sub: string; group: string; property?: { id: number; photoAt: string | null; assetType: string | null } }

export function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [searched, setSearched] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setItems([]);
      setSearched(false);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const r = await api<Results>(`/firm/search?q=${encodeURIComponent(term)}`);
        const next: Item[] = [
          ...r.properties.map((p) => { const t = splitMatterTitle(p.title); return { key: `p${p.id}`, to: `/properties/${p.id}`, label: t.place, sub: [t.pin ? `PIN ${t.pin}` : null, p.sub].filter(Boolean).join(" · "), group: "Properties", property: { id: p.id, photoAt: p.photoAt ?? null, assetType: p.assetType ?? null } }; }),
          ...r.accounts.map((a) => ({ key: `a${a.id}`, to: `/accounts/${a.id}`, label: a.name, sub: a.city ?? "", group: "Clients" })),
          ...r.appeals.map((a) => ({
            key: `ap${a.id}`, to: `/properties/${a.property_id}?appeal=${a.id}`,
            label: `${a.assessment_year} ${LEVEL_LABELS[a.level]}${a.petition_no ? ` · petition ${a.petition_no}` : ""}${a.external_id ? ` · ID ${a.external_id}` : ""}`,
            sub: a.property_name, group: "Appeals",
          })),
          ...(r.documents ?? []).map((d) => ({
            key: `d${d.id}`,
            to: `/properties/${d.propertyId}?${new URLSearchParams(d.relPath ? { tab: "files", file: d.relPath } : { tab: "files" })}`,
            label: d.name,
            sub: [d.type, d.year && d.level ? `${d.year} ${LEVEL_LABELS[d.level]}` : d.year, [d.property, d.city].filter(Boolean).join(", ")].filter(Boolean).join(" · "),
            group: "Documents",
          })),
        ];
        setItems(next);
        setActive(0);
        setSearched(true);
        setOpen(true);
      } catch {
        setItems([]);
      }
    }, 200);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function go(item: Item) {
    setOpen(false);
    setQ("");
    navigate(item.to);
  }

  const groups = ["Properties", "Clients", "Appeals", "Documents"].map((g) => ({ g, rows: items.filter((i) => i.group === g) })).filter((x) => x.rows.length);

  return (
    <div className="search" ref={box}>
      <label className="search-box">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.8-4.8" />
        </svg>
        <input
          value={q}
          placeholder="Search PIN, address, client, document"
          aria-label="Search properties, clients, appeals and documents"
          role="combobox"
          aria-expanded={open}
          aria-controls="search-results"
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => items.length && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && items[active]) { e.preventDefault(); go(items[active]); }
            else if (e.key === "Escape") setOpen(false);
          }}
        />
      </label>
      {open && searched && (
        <div className="search-results" id="search-results" role="listbox">
          {items.length === 0 && <div className="empty">Nothing matches "{q.trim()}".</div>}
          {groups.map(({ g, rows }) => (
            <div key={g}>
              <h6>{g}</h6>
              {rows.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={items[active]?.key === item.key}
                  className={items[active]?.key === item.key ? "on" : ""}
                  onMouseEnter={() => setActive(items.indexOf(item))}
                  onClick={() => go(item)}
                >
                  {item.property ? (
                    <span className="sr-prop">
                      <PropertyAvatar id={item.property.id} photoAt={item.property.photoAt} assetType={item.property.assetType} size={30} />
                      <span><b>{item.label}</b>{item.sub && <span>{item.sub}</span>}</span>
                    </span>
                  ) : (
                    <>
                      <b>{item.label}</b>
                      {item.sub && <span>{item.sub}</span>}
                    </>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
