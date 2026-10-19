import { describe, expect, it } from "vitest";
import { splitMatterTitle } from "../../web/src/format";

describe("splitting a matter title for display", () => {
  it("separates the PIN from an address that starts with a number", () => {
    expect(splitMatterTitle("04-24-100-027 – 1450 Waukegan Rd., Northfield (Northfield)")).toEqual({ pin: "04-24-100-027", place: "1450 Waukegan Rd., Northfield (Northfield)" });
    expect(splitMatterTitle("30-07-14-301-012-0000 – 2400 Channahon Rd., Joliet (Joliet)")).toEqual({ pin: "30-07-14-301-012-0000", place: "2400 Channahon Rd., Joliet (Joliet)" });
  });
  it("leaves a title without a PIN alone", () => {
    expect(splitMatterTitle("1 Other St, Chicago")).toEqual({ pin: null, place: "1 Other St, Chicago" });
    expect(splitMatterTitle("Main St – Annex, Geneva")).toEqual({ pin: null, place: "Main St – Annex, Geneva" });
  });
});
