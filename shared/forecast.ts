// Planning assumptions for the fee forecast. Nothing here creates an
// invoice: invoices are drafted only when a decision is processed.
//
// Assessor and Board of Review fees are billed when the decision arrives,
// so an open appeal's expected fee lands in the month its decision is
// expected: this many days after its township's filing window closes.
export const DECISION_DAYS_AFTER_WINDOW: Record<"assessor" | "bor", number> = { assessor: 60, bor: 90 };

/** Months shown on the forecast, starting with the current one. */
export const FORECAST_MONTHS = 6;
