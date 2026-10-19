// Which jurisdictions are reassessed in a given assessment year.
//
// Cook County reassesses one triad every year on a fixed three-year cycle:
// City (Chicago townships) in 2024, 2027, 2030; North in 2025, 2028; South
// in 2026, 2029. The other Illinois counties revalue in the statewide general
// (quadrennial) assessment years: 2023, 2027, 2031.
//
// These cycles are set by statute and county practice, so they live here as
// constants. If one ever changes, edit the base years below; nothing else
// in the app needs to change and no migration is involved.

export const COOK_TRIAD_BASE_YEARS: Record<string, number> = { City: 2024, North: 2025, South: 2026 };
export const COOK_CYCLE_YEARS = 3;
export const GENERAL_ASSESSMENT_BASE_YEAR = 2023;
export const GENERAL_ASSESSMENT_CYCLE_YEARS = 4;

export function isReassessed(county: string, cookTriad: string | null, year: number): boolean {
  if (county === "Cook") {
    const base = cookTriad ? COOK_TRIAD_BASE_YEARS[cookTriad] : undefined;
    return base !== undefined && (year - base) % COOK_CYCLE_YEARS === 0;
  }
  return (year - GENERAL_ASSESSMENT_BASE_YEAR) % GENERAL_ASSESSMENT_CYCLE_YEARS === 0;
}

/** A plain description of what's reassessed that year, for the dashboard. */
export function reassessmentLabel(year: number): string {
  const triad = Object.entries(COOK_TRIAD_BASE_YEARS).find(([, base]) => (year - base) % COOK_CYCLE_YEARS === 0)?.[0];
  const general = (year - GENERAL_ASSESSMENT_BASE_YEAR) % GENERAL_ASSESSMENT_CYCLE_YEARS === 0;
  const cook = triad === "City" ? "the City of Chicago townships" : triad ? `Cook's ${triad} suburbs` : "";
  return [cook, general ? "the collar counties' general reassessment" : ""].filter(Boolean).join(" and ");
}
