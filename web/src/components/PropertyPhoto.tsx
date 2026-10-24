import { useRef, useState } from "react";
import { ApiError, errorText } from "../api";

// A property's picture: the round avatar beside its address in lists, and the photo panel on the
// property page (upload, replace, remove). Without a photo, an outline of the kind of building.

const MAX_BYTES = 15 * 1024 * 1024;
export const photoUrl = (id: number, at: string, size: "thumb" | "large" = "thumb") => `/api/firm/properties/${id}/photo?size=${size}&v=${encodeURIComponent(at)}`;

type Shape = "house" | "apartments" | "store" | "office" | "warehouse" | "medical" | "datacenter";
function shapeFor(type: string | null | undefined): Shape {
  switch (type) {
    case "multifamily": return "apartments";
    case "retail": case "hospitality": return "store";
    case "commercial": return "office";
    case "industrial": case "flex": return "warehouse";
    case "medical": return "medical";
    case "data_center": return "datacenter";
    default: return "house";
  }
}

/** Simple line drawings, one per kind of building, in the brand's navy. */
export function BuildingIcon({ type, size = 18 }: { type?: string | null; size?: number }) {
  const s = shapeFor(type);
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {s === "house" && <><path {...p} d="M3.5 11 12 4l8.5 7" /><path {...p} d="M6 9.5V20h12V9.5" /><path {...p} d="M10 20v-5h4v5" /></>}
      {s === "apartments" && <><rect {...p} x="5" y="3.5" width="14" height="16.5" rx="1" /><path {...p} d="M8.5 7.5h1.5M14 7.5h1.5M8.5 11h1.5M14 11h1.5M8.5 14.5h1.5M14 14.5h1.5M10.5 20v-2.5h3V20" /></>}
      {s === "store" && <><path {...p} d="M4 9.5 5.5 4.5h13L20 9.5" /><path {...p} d="M4 9.5h16c0 1.4-1.2 2.4-2.7 2.4S14.7 10.9 14.7 9.5c0 1.4-1.2 2.4-2.7 2.4s-2.7-1-2.7-2.4c0 1.4-1.2 2.4-2.6 2.4S4 10.9 4 9.5Z" /><path {...p} d="M5.5 12v8h13v-8M10 20v-4.5h4V20" /></>}
      {s === "office" && <><path {...p} d="M4.5 20V6.5L13 3.5V20M13 9h6.5V20M3 20h18" /><path {...p} d="M7.5 9h2.5M7.5 12.5h2.5M7.5 16h2.5M15.5 12.5h1.5M15.5 16h1.5" /></>}
      {s === "warehouse" && <><path {...p} d="M3 20V9l9-5 9 5v11" /><path {...p} d="M7 20v-7h10v7M7 16.5h10" /></>}
      {s === "medical" && <><rect {...p} x="4" y="6" width="16" height="14" rx="1" /><path {...p} d="M9 6V3.5h6V6M12 10v5M9.5 12.5h5" /></>}
      {s === "datacenter" && <><rect {...p} x="4.5" y="4" width="15" height="5" rx="1" /><rect {...p} x="4.5" y="10.5" width="15" height="5" rx="1" /><path {...p} d="M7.5 6.5h.01M7.5 13h.01M9 20h6M12 15.5V20" /></>}
    </svg>
  );
}

/** The round avatar: the photo's thumbnail, or the building outline. */
export function PropertyAvatar({ id, photoAt, assetType, size = 36, label }: { id: number; photoAt?: string | null; assetType?: string | null; size?: number; label?: string }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (photoAt && !broken) {
    return <img className="pavatar" style={style} src={photoUrl(id, photoAt)} alt={label ? `Photo of ${label}` : ""} loading="lazy" decoding="async" onError={() => setBroken(true)} />;
  }
  return <span className="pavatar empty" style={style} aria-hidden="true"><BuildingIcon type={assetType} size={Math.round(size * 0.5)} /></span>;
}

export interface PhotoInfo { updatedAt: string; width: number; height: number; source: "upload" | "dropbox" | "sample"; sourceName: string | null }

/** The photo panel on the property page. */
export function PhotoPanel({ propertyId, photo, assetType, address, canEdit, onChanged }: {
  propertyId: number; photo: PhotoInfo | null; assetType: string; address: string; canEdit: boolean; onChanged: () => Promise<void> | void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  async function upload(f: File) {
    setError("");
    if (f.size > MAX_BYTES) { setError("A photo can be up to 15 MB."); return; }
    setBusy("Uploading");
    try {
      const res = await fetch(`/api/firm/properties/${propertyId}/photo?name=${encodeURIComponent(f.name)}`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: f,
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new ApiError(res.status, body.error || `Upload failed (${res.status})`);
      await onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  async function remove() {
    if (!window.confirm("Remove this property's photo? Its avatar goes back to the building outline.")) return;
    setBusy("Removing"); setError("");
    try {
      const res = await fetch(`/api/firm/properties/${propertyId}/photo`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error || "Couldn't remove the photo.");
      await onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }

  return (
    <div className="pphoto">
      {photo ? (
        <button type="button" className="pphoto-img" onClick={() => setOpen(true)} aria-label={`Open the photo of ${address}`}>
          <img src={photoUrl(propertyId, photo.updatedAt, "large")} alt={`Photo of ${address}`} />
        </button>
      ) : (
        <div className="pphoto-img empty">
          <BuildingIcon type={assetType} size={40} />
          <span className="meta">{canEdit ? "No photo yet" : "No photo"}</span>
        </div>
      )}
      {canEdit && (
        <div className="pphoto-acts">
          <button type="button" className="btn small secondary" disabled={Boolean(busy)} onClick={() => input.current?.click()}>{busy === "Uploading" ? "Uploading" : photo ? "Change photo" : "Add a photo"}</button>
          {photo && <button type="button" className="btn small ghost" disabled={Boolean(busy)} onClick={() => void remove()}>Remove</button>}
          <input ref={input} type="file" hidden accept="image/jpeg,image/png,image/webp" aria-label="Choose a photo of the property"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
        </div>
      )}
      {photo?.source === "dropbox" && photo.sourceName && <div className="mn">From Files: {photo.sourceName}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {open && photo && (
        <div className="pphoto-full" role="dialog" aria-modal="true" aria-label={`Photo of ${address}`} tabIndex={-1}
          onClick={() => setOpen(false)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} ref={(el) => el?.focus()}>
          <img src={photoUrl(propertyId, photo.updatedAt, "large")} alt={`Photo of ${address}`} />
          <button type="button" className="btn small secondary" onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
}
