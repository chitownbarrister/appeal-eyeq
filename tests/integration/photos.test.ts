// Delivery 10f: property photos (the sample's stock photos, upload, sizes, sideways phone photos,
// the formats refused, remove, caching, the avatar data on lists and search), the sample backfill,
// and the firm logo in /auth/me. With cross-firm attacks and support access.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { ADMIN, call, login, startTestEnv, stopTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;
let dillon = "";
let olivia = "";
let admin = "";
let tower = 0;
let sheridan = 0;

const get = (cookie: string, url: string) => call(env.base, cookie, "GET", url);
async function raw(cookie: string, url: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${env.base}${url}`, { headers: { Cookie: cookie, ...headers } });
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
}
async function upload(cookie: string, id: number, body: Buffer, name = "photo.jpg", type = "application/octet-stream") {
  const res = await fetch(`${env.base}/api/firm/properties/${id}/photo?name=${encodeURIComponent(name)}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": type }, body });
  return { status: res.status, body: await res.json() };
}
async function picture(w: number, h: number, kind: "png" | "jpeg" = "jpeg"): Promise<Buffer> {
  const cv = createCanvas(w, h);
  const g = cv.getContext("2d");
  g.fillStyle = "#0A1F44"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#B8733E"; g.fillRect(0, 0, w / 2, h / 4); // a mark in the top left, to check which way is up
  return kind === "png" ? cv.encode("png") : cv.encode("jpeg", 90);
}
/** A JPEG with an EXIF block saying "rotate 90° clockwise to view" (orientation 6), as phones write. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1"); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}
async function dims(buf: Buffer) { const im = await loadImage(buf); return { w: im.width, h: im.height }; }

beforeAll(async () => {
  env = await startTestEnv();
  dillon = await login(env.base, "dillon@nicholslaw.example");
  olivia = await login(env.base, "olivia@otherfirm.example");
  admin = await login(env.base, ADMIN.email, ADMIN.password);
  const props = (await get(dillon, "/api/firm/properties")).body.properties as { id: number; address1: string }[];
  tower = props.find((p) => p.address1 === "1044 Tower Road")!.id;
  sheridan = props.find((p) => p.address1 === "1300 Sheridan Rd.")!.id;
}, 120000);

afterAll(async () => { await stopTestEnv(env); });

describe("the sample firm's photos", () => {
  it("every sample property has its stock photo, in two sizes", async () => {
    const props = (await get(dillon, "/api/firm/properties")).body.properties as { id: number; photo_at: string | null }[];
    expect(props).toHaveLength(15);
    expect(props.every((p) => p.photo_at)).toBe(true);
    const d = (await get(dillon, `/api/firm/properties/${sheridan}`)).body.property.photo;
    expect(d).toMatchObject({ width: 1600, height: 999, source: "sample", sourceName: "Sample photo" });
    const thumb = await raw(dillon, `/api/firm/properties/${sheridan}/photo?size=thumb&v=${encodeURIComponent(d.updatedAt)}`);
    expect(thumb.res.headers.get("content-type")).toBe("image/jpeg");
    expect(thumb.res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await dims(thumb.buf)).toEqual({ w: 320, h: 320 });
    const large = await raw(dillon, `/api/firm/properties/${sheridan}/photo?size=large`);
    expect(large.res.headers.get("cache-control")).toBe("private, no-cache");
    expect(await dims(large.buf)).toEqual({ w: 1600, h: 999 });
    const again = await raw(dillon, `/api/firm/properties/${sheridan}/photo?size=large`, { "If-None-Match": large.res.headers.get("etag")! });
    expect(again.res.status).toBe(304);
  });

  it("an older sample firm without photos gets them once on start, and never again after that", async () => {
    const { withContext } = await import("../../server/db");
    const { addSamplePhotosIfNone } = await import("../../server/seed/sample");
    const sys = { actorKind: "system" as const, userId: null, firmId: env.nicholsId };
    await withContext(sys, (c) => c.query(`DELETE FROM property_photos WHERE firm_id = $1`, [env.nicholsId]));
    const log: string[] = [];
    await addSamplePhotosIfNone((m) => log.push(m));
    expect(log).toEqual(["Sample data: 15 property photos added"]);
    await withContext(sys, (c) => c.query(`DELETE FROM property_photos WHERE firm_id = $1 AND property_id = $2`, [env.nicholsId, tower]));
    await addSamplePhotosIfNone((m) => log.push(m));
    expect(log).toHaveLength(1); // one removed on purpose stays removed
    const n = await withContext(sys, async (c) => (await c.query(`SELECT count(*)::int AS n FROM property_photos WHERE firm_id = $1`, [env.nicholsId])).rows[0].n);
    expect(n).toBe(14);
  });
});

describe("uploading a photo", () => {
  it("a PNG becomes the photo: large keeps its shape up to 1600 wide, the thumbnail is the middle square", async () => {
    const r = await upload(dillon, tower, await picture(2400, 1200, "png"), "front.png");
    expect(r.status).toBe(201);
    expect(r.body.photo).toMatchObject({ width: 1600, height: 800, source: "upload", sourceName: "front.png" });
    const p = (await get(dillon, "/api/firm/properties")).body.properties.find((x: { id: number }) => x.id === tower);
    expect(p.photo_at).toBe(r.body.photo.updatedAt);
    expect(await dims((await raw(dillon, `/api/firm/properties/${tower}/photo?size=large`)).buf)).toEqual({ w: 1600, h: 800 });
  });

  it("a phone photo taken sideways comes out upright", async () => {
    const r = await upload(dillon, tower, withOrientation(await picture(1200, 800), 6), "IMG_0042.jpg");
    expect(r.status).toBe(201);
    expect(r.body.photo).toMatchObject({ width: 800, height: 1200 });
    // Orientation 6: the original's top-left mark ends up at the top right.
    const im = await loadImage((await raw(dillon, `/api/firm/properties/${tower}/photo?size=large`)).buf);
    const cv = createCanvas(im.width, im.height);
    const g = cv.getContext("2d");
    g.drawImage(im, 0, 0);
    const px = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    expect(px(760, 40)[0]).toBeGreaterThan(150); // copper
    expect(px(40, 40)[0]).toBeLessThan(60); // navy
  });

  it("refuses what isn't a photo, an iPhone HEIC, a tiny image, an empty file and a form post", async () => {
    expect((await upload(dillon, tower, Buffer.from("not an image at all"), "a.jpg")).body.error).toBe("Use a JPEG, PNG or WebP photo.");
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(40)]);
    const h = await upload(dillon, tower, heic, "IMG_1.HEIC");
    expect(h.status).toBe(415);
    expect(h.body.error).toMatch(/^iPhone HEIC photos can't be read here yet/);
    const tiny = await upload(dillon, tower, await picture(120, 90));
    expect(tiny).toMatchObject({ status: 400, body: { error: "That photo is too small. Use one at least 800 pixels wide." } });
    expect((await upload(dillon, tower, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(dillon, tower, await picture(900, 600), "x.jpg", "text/plain")).status).toBe(415);
  });

  it("is in the audit log, without the image", async () => {
    const log = (await get(dillon, "/api/firm/audit-log?table=property_photos")).body;
    const rows = (log.rows ?? log.entries ?? log.log ?? []) as { table_name: string; after: Record<string, unknown> | null }[];
    const mine = rows.filter((r) => r.table_name === "property_photos");
    expect(mine.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine)).not.toMatch(/"large":|"thumb":/);
  });

  it("removing it leaves the outline; a second remove is not found", async () => {
    expect((await call(env.base, dillon, "DELETE", `/api/firm/properties/${tower}/photo`)).status).toBe(200);
    expect((await raw(dillon, `/api/firm/properties/${tower}/photo`)).res.status).toBe(404);
    expect((await get(dillon, `/api/firm/properties/${tower}`)).body.property.photo).toBeNull();
    expect((await call(env.base, dillon, "DELETE", `/api/firm/properties/${tower}/photo`)).status).toBe(404);
  });
});

describe("where the avatar data goes", () => {
  it("client pages and search carry each property's photo version and type", async () => {
    const acct = (await get(dillon, "/api/firm/accounts")).body.accounts.find((a: { name: string }) => a.name === "Sheridan Shore Apartments LP");
    const page = (await get(dillon, `/api/firm/accounts/${acct.id}`)).body;
    expect(page.properties[0].photo_at).toBeTruthy();
    const s = (await get(dillon, "/api/firm/search?q=Sheridan")).body.properties[0];
    expect(s).toMatchObject({ id: sheridan, assetType: "multifamily" });
    expect(s.photoAt).toBeTruthy();
  });
});

describe("another firm, and support access", () => {
  it("another firm's property photo can't be read, replaced or removed", async () => {
    expect((await raw(olivia, `/api/firm/properties/${sheridan}/photo`)).res.status).toBe(404);
    expect((await upload(olivia, sheridan, await picture(900, 600))).status).toBe(404);
    expect((await call(env.base, olivia, "DELETE", `/api/firm/properties/${sheridan}/photo`)).status).toBe(404);
    expect((await raw(dillon, `/api/firm/properties/${sheridan}/photo`)).res.status).toBe(200); // still there
    expect((await raw(dillon, `/api/firm/properties/${env.otherPropertyId}/photo`)).res.status).toBe(404);
  });

  it("the super admin without a grant gets nothing", async () => {
    expect((await raw(admin, `/api/firm/properties/${sheridan}/photo`)).res.status).toBe(403);
  });
});

describe("the firm logo", () => {
  it("shows in /auth/me once uploaded, and goes when removed", async () => {
    expect((await get(dillon, "/api/auth/me")).body.firm.logoAt).toBeNull();
    const png = await picture(600, 200, "png");
    expect((await call(env.base, dillon, "PUT", "/api/firm/billing/logo", { contentType: "image/png", data: png.toString("base64") })).status).toBe(200);
    const at = (await get(dillon, "/api/auth/me")).body.firm.logoAt;
    expect(at).toBeTruthy();
    expect((await get(olivia, "/api/auth/me")).body.firm.logoAt).toBeNull();
    expect((await raw(olivia, "/api/firm/billing/logo")).res.status).toBe(404);
    expect((await call(env.base, dillon, "DELETE", "/api/firm/billing/logo")).status).toBe(200);
    expect((await get(dillon, "/api/auth/me")).body.firm.logoAt).toBeNull();
  });
});
