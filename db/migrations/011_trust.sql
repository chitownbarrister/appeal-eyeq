-- Delivery 9b: refunds into trust, settlements and payouts to the client, expenses the
-- firm fronts, a per-client trust ledger, and appeals marked "not billing here".
-- Every table is firm-scoped with forced row-level security, audited, with composite
-- (firm_id, id) foreign keys. Safe to run twice.

-- ---------------------------------------------------------------- 1: expenses the firm fronts
-- Only costs the firm pays on the client's behalf. Recovered from a refund (through a
-- settlement) or on an invoice (as an expense line). Whether it's open, billed or
-- recovered is worked out from those links, never stored twice.
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  appeal_id INTEGER,
  incurred_on DATE NOT NULL,
  vendor TEXT NOT NULL CHECK (length(btrim(vendor)) BETWEEN 1 AND 120),
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  recovery TEXT NOT NULL CHECK (recovery IN ('refund', 'invoice')),
  receipt_document_id INTEGER,                   -- a file on the property's Files tab; checked against the firm when set
  written_off_at TIMESTAMPTZ,
  written_off_reason TEXT CHECK (written_off_reason IS NULL OR length(written_off_reason) <= 300),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id),
  FOREIGN KEY (firm_id, appeal_id) REFERENCES appeals (firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_expenses_firm ON expenses (firm_id);
CREATE INDEX IF NOT EXISTS idx_expenses_property ON expenses (firm_id, property_id);
SELECT app_enable_firm_rls('expenses'::regclass);
SELECT app_attach_audit('expenses'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON expenses;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Invoice lines can carry an expense.
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS expense_id INTEGER;
ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_kind_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_kind_check CHECK (kind IN ('fee', 'other', 'expense'));
ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_expense_fk;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_expense_fk FOREIGN KEY (firm_id, expense_id) REFERENCES expenses (firm_id, id);
ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_expense_kind;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_expense_kind CHECK ((kind = 'expense') = (expense_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_invoice_lines_expense ON invoice_lines (firm_id, expense_id) WHERE expense_id IS NOT NULL;

-- ---------------------------------------------------------------- 2: trust settlements
-- One per refund: refund received, less the fee, less fronted expenses, is what the client
-- is owed. Draft, then approved (needs trust.approve), then paid (check or ACH recorded).
CREATE TABLE IF NOT EXISTS trust_settlements (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  appeal_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid', 'void')),
  refund_amount NUMERIC(14, 2) NOT NULL CHECK (refund_amount > 0),
  refund_received_on DATE NOT NULL,
  fee_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  fee_basis JSONB,                               -- percent, source, cap, flat, overridden by
  expenses_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (expenses_amount >= 0),
  client_amount NUMERIC(14, 2) NOT NULL CHECK (client_amount >= 0),
  CHECK (fee_amount + expenses_amount + client_amount = refund_amount),
  note TEXT CHECK (note IS NULL OR length(note) <= 600),
  prepared_by INTEGER,
  approved_by INTEGER,
  approved_at TIMESTAMPTZ,
  paid_on DATE,
  payout_method TEXT CHECK (payout_method IN ('check', 'ach')),
  payout_reference TEXT CHECK (payout_reference IS NULL OR length(payout_reference) <= 120),
  paid_by INTEGER,
  CHECK (status <> 'paid' OR (paid_on IS NOT NULL AND payout_method IS NOT NULL)),
  CHECK (status NOT IN ('approved', 'paid') OR approved_at IS NOT NULL),
  void_reason TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id),
  FOREIGN KEY (firm_id, appeal_id) REFERENCES appeals (firm_id, id),
  FOREIGN KEY (firm_id, prepared_by) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, approved_by) REFERENCES users (firm_id, id),
  FOREIGN KEY (firm_id, paid_by) REFERENCES users (firm_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS trust_settlements_one_per_appeal ON trust_settlements (firm_id, appeal_id) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS idx_trust_settlements_firm ON trust_settlements (firm_id, status);
SELECT app_enable_firm_rls('trust_settlements'::regclass);
SELECT app_attach_audit('trust_settlements'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON trust_settlements;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON trust_settlements FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS settlement_expenses (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  settlement_id INTEGER NOT NULL,
  expense_id INTEGER NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, settlement_id, expense_id),
  FOREIGN KEY (firm_id, settlement_id) REFERENCES trust_settlements (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, expense_id) REFERENCES expenses (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_settlement_expenses_expense ON settlement_expenses (firm_id, expense_id);
SELECT app_enable_firm_rls('settlement_expenses'::regclass);
SELECT app_attach_audit('settlement_expenses'::regclass);

-- ---------------------------------------------------------------- 3: the trust ledger
-- Money in (the refund deposit) and out (fee to operating, expenses reimbursed, payout to
-- the client), per client. Positive in, negative out. A client's balance never goes below
-- zero (checked in code under a lock on the client's row).
CREATE TABLE IF NOT EXISTS trust_entries (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER NOT NULL,
  appeal_id INTEGER,
  settlement_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'fee', 'expenses', 'payout')),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount <> 0),
  CHECK ((kind = 'deposit') = (amount > 0)),
  entry_on DATE NOT NULL,
  memo TEXT CHECK (memo IS NULL OR length(memo) <= 300),
  reference TEXT CHECK (reference IS NULL OR length(reference) <= 120),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id),
  FOREIGN KEY (firm_id, appeal_id) REFERENCES appeals (firm_id, id),
  FOREIGN KEY (firm_id, settlement_id) REFERENCES trust_settlements (firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_trust_entries_account ON trust_entries (firm_id, account_id, entry_on);
CREATE UNIQUE INDEX IF NOT EXISTS trust_entries_one_deposit_per_appeal ON trust_entries (firm_id, appeal_id) WHERE kind = 'deposit';
SELECT app_enable_firm_rls('trust_entries'::regclass);
SELECT app_attach_audit('trust_entries'::regclass);

-- ---------------------------------------------------------------- 4: email log covers settlement letters
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS settlement_id INTEGER;
ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_kind_check;
ALTER TABLE email_log ADD CONSTRAINT email_log_kind_check CHECK (kind IN ('invoice', 'statement', 'receipt', 'test', 'settlement'));
ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_settlement_fk;
ALTER TABLE email_log ADD CONSTRAINT email_log_settlement_fk FOREIGN KEY (firm_id, settlement_id) REFERENCES trust_settlements (firm_id, id) ON DELETE CASCADE;

-- ---------------------------------------------------------------- 5: appeals not billed here
-- History brought over from earlier software, or a fee waived: take it off Ready to bill.
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS billing_skipped_at TIMESTAMPTZ;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS billing_skip_reason TEXT;
ALTER TABLE appeals DROP CONSTRAINT IF EXISTS appeals_billing_skip_reason_check;
ALTER TABLE appeals ADD CONSTRAINT appeals_billing_skip_reason_check CHECK (billing_skip_reason IS NULL OR length(billing_skip_reason) <= 200);

-- ---------------------------------------------------------------- 6: permission to approve payouts from trust
DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN SELECT id FROM firms LOOP
    PERFORM set_config('app.actor_kind', 'system', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.firm_id', f.id::text, true);
    INSERT INTO role_permissions (firm_id, role, permission, allowed)
    SELECT f.id, r, 'trust.approve', r = 'attorney' FROM unnest(ARRAY['attorney', 'analyst', 'operations']) AS r
    ON CONFLICT (firm_id, role, permission) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.actor_kind', '', true);
  PERFORM set_config('app.firm_id', '', true);
END $$;
