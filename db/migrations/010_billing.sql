-- ============================================================
-- 010 Billing (Delivery 9a): invoices, statements, payments, the firm's
--     Stripe account, pay links and the email log.
--
-- 1. billing_settings: per firm, the invoice number prefix, payment terms and
--    the note printed at the foot of invoices. invoice_counters hands out the
--    next number per firm and year (NL-2026-0001).
-- 2. invoices and invoice_lines: one invoice per appeal (a fee line, plus any
--    other lines staff add). Draft, sent, paid or void.
-- 3. statements: several sent invoices of one client, payable only together.
--    While a statement is open, its invoices can't be paid on their own.
-- 4. payments and payment_allocations: what came in (Stripe card or ACH, a
--    check, other) and which invoices it paid. Never partial.
-- 5. stripe_accounts (the firm's own Stripe account, connected to Appeal
--    EyeQ's platform) and stripe_customers (each client's Stripe customer on
--    that account, with a saved payment method if the client chose to keep one).
-- 6. pay_links: the client's link to pay an invoice or statement. Looked up by
--    the hash of the token in the link before anyone is signed in, so this one
--    table sits outside the firm lock (like sessions). It holds only ids and
--    dates, never client data. stripe_events records each Stripe event once,
--    so a repeated webhook does nothing.
-- 7. email_log: every billing email sent (or refused), per firm.
--
-- Firm tables carry firm_id, forced row-level security, audit and composite
-- foreign keys. Safe to run twice.
-- ============================================================

-- ---------------------------------------------------------------- 1: settings and numbering
CREATE TABLE IF NOT EXISTS billing_settings (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL UNIQUE REFERENCES firms(id),
  invoice_prefix TEXT NOT NULL CHECK (invoice_prefix ~ '^[A-Z0-9]{1,6}$'),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 120),
  invoice_note TEXT CHECK (invoice_note IS NULL OR length(invoice_note) <= 600),
  reply_to_email TEXT CHECK (reply_to_email IS NULL OR length(reply_to_email) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id)
);
SELECT app_enable_firm_rls('billing_settings'::regclass);
SELECT app_attach_audit('billing_settings'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON billing_settings;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON billing_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS invoice_counters (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'statement')),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  last_number INTEGER NOT NULL DEFAULT 0,
  UNIQUE (firm_id, kind, year)
);
CREATE INDEX IF NOT EXISTS idx_invoice_counters_firm ON invoice_counters (firm_id);
SELECT app_enable_firm_rls('invoice_counters'::regclass);

-- ---------------------------------------------------------------- 3: statements (before invoices, which point at them)
CREATE TABLE IF NOT EXISTS statements (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  issued_on DATE NOT NULL,
  due_on DATE NOT NULL,
  total NUMERIC(14, 2) NOT NULL CHECK (total >= 0),
  sent_at TIMESTAMPTZ,
  sent_to TEXT[] NOT NULL DEFAULT '{}',
  paid_at TIMESTAMPTZ,
  void_reason TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 300),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, number),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_statements_firm ON statements (firm_id);
CREATE INDEX IF NOT EXISTS idx_statements_account ON statements (firm_id, account_id);
SELECT app_enable_firm_rls('statements'::regclass);
SELECT app_attach_audit('statements'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON statements;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON statements FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- 2: invoices
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  appeal_id INTEGER,
  number TEXT,                                   -- given when it's first sent, so deleted drafts leave no gaps
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  issued_on DATE,
  due_on DATE,
  total NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  fee_basis JSONB,                               -- how the fee line was worked out: savings, percent, cap
  statement_id INTEGER,                          -- the open (or paid) statement it was billed on
  sent_at TIMESTAMPTZ,
  sent_to TEXT[] NOT NULL DEFAULT '{}',
  paid_at TIMESTAMPTZ,
  void_reason TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 300),
  note TEXT CHECK (note IS NULL OR length(note) <= 600),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, number),
  CHECK (status = 'draft' OR number IS NOT NULL),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id),
  FOREIGN KEY (firm_id, property_id) REFERENCES properties (firm_id, id),
  FOREIGN KEY (firm_id, appeal_id) REFERENCES appeals (firm_id, id),
  FOREIGN KEY (firm_id, statement_id) REFERENCES statements (firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_firm ON invoices (firm_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices (firm_id, account_id);
CREATE INDEX IF NOT EXISTS idx_invoices_property ON invoices (firm_id, property_id);
-- One live invoice per appeal (a voided one can be replaced).
CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_per_appeal ON invoices (firm_id, appeal_id) WHERE appeal_id IS NOT NULL AND status <> 'void';
SELECT app_enable_firm_rls('invoices'::regclass);
SELECT app_attach_audit('invoices'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON invoices;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS invoice_lines (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  invoice_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('fee', 'other')),
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, invoice_id) REFERENCES invoices (firm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (firm_id, invoice_id);
SELECT app_enable_firm_rls('invoice_lines'::regclass);
SELECT app_attach_audit('invoice_lines'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON invoice_lines;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- 4: payments
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER NOT NULL,
  invoice_id INTEGER,
  statement_id INTEGER,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('card', 'ach', 'check', 'other')),
  status TEXT NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed')),
  received_on DATE,
  check_number TEXT CHECK (check_number IS NULL OR length(check_number) <= 40),
  reference TEXT CHECK (reference IS NULL OR length(reference) <= 200),
  stripe_checkout_session TEXT,
  stripe_payment_intent TEXT,
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 300),
  recorded_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  CHECK ((invoice_id IS NULL) <> (statement_id IS NULL)),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id),
  FOREIGN KEY (firm_id, invoice_id) REFERENCES invoices (firm_id, id),
  FOREIGN KEY (firm_id, statement_id) REFERENCES statements (firm_id, id),
  FOREIGN KEY (firm_id, recorded_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_payments_firm ON payments (firm_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (firm_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_statement ON payments (firm_id, statement_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_session ON payments (firm_id, stripe_checkout_session) WHERE stripe_checkout_session IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_intent ON payments (firm_id, stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;
SELECT app_enable_firm_rls('payments'::regclass);
SELECT app_attach_audit('payments'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON payments;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS payment_allocations (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  payment_id INTEGER NOT NULL,
  invoice_id INTEGER NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, payment_id, invoice_id),
  FOREIGN KEY (firm_id, payment_id) REFERENCES payments (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, invoice_id) REFERENCES invoices (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_firm ON payment_allocations (firm_id);
SELECT app_enable_firm_rls('payment_allocations'::regclass);
SELECT app_attach_audit('payment_allocations'::regclass);

-- ---------------------------------------------------------------- 5: Stripe
CREATE TABLE IF NOT EXISTS stripe_accounts (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL UNIQUE REFERENCES firms(id),
  stripe_account_id TEXT NOT NULL,
  livemode BOOLEAN NOT NULL DEFAULT false,
  charges_enabled BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  details_submitted BOOLEAN NOT NULL DEFAULT false,
  business_name TEXT,
  connected_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, connected_by) REFERENCES users (firm_id, id)
);
SELECT app_enable_firm_rls('stripe_accounts'::regclass);
SELECT app_attach_audit('stripe_accounts'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON stripe_accounts;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON stripe_accounts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS stripe_customers (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  account_id INTEGER NOT NULL,
  stripe_account_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  saved_payment_method TEXT,
  saved_method_label TEXT,                       -- "Visa ending 4242", "Bank account ending 6789"
  saved_method_kind TEXT CHECK (saved_method_kind IS NULL OR saved_method_kind IN ('card', 'ach')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  UNIQUE (firm_id, account_id, stripe_account_id),
  FOREIGN KEY (firm_id, account_id) REFERENCES accounts (firm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stripe_customers_firm ON stripe_customers (firm_id);
SELECT app_enable_firm_rls('stripe_customers'::regclass);
SELECT app_attach_audit('stripe_customers'::regclass);
DROP TRIGGER IF EXISTS touch_updated_at_trg ON stripe_customers;
CREATE TRIGGER touch_updated_at_trg BEFORE UPDATE ON stripe_customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------- 6: pay links and Stripe events (outside the firm lock, ids only)
CREATE TABLE IF NOT EXISTS pay_links (
  token_hash TEXT PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  invoice_id INTEGER,
  statement_id INTEGER,
  token_enc TEXT,                                -- the token itself, encrypted, so staff can copy the same link again
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CHECK ((invoice_id IS NULL) <> (statement_id IS NULL)),
  FOREIGN KEY (firm_id, invoice_id) REFERENCES invoices (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, statement_id) REFERENCES statements (firm_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pay_links_invoice ON pay_links (firm_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_pay_links_statement ON pay_links (firm_id, statement_id);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  firm_id INTEGER REFERENCES firms(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- 7: email log
CREATE TABLE IF NOT EXISTS email_log (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'statement', 'receipt', 'test')),
  invoice_id INTEGER,
  statement_id INTEGER,
  to_addresses TEXT[] NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'not_configured')),
  provider_id TEXT,
  error TEXT CHECK (error IS NULL OR length(error) <= 500),
  sent_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, id),
  FOREIGN KEY (firm_id, invoice_id) REFERENCES invoices (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, statement_id) REFERENCES statements (firm_id, id) ON DELETE CASCADE,
  FOREIGN KEY (firm_id, sent_by) REFERENCES users (firm_id, id)
);
CREATE INDEX IF NOT EXISTS idx_email_log_firm ON email_log (firm_id, created_at DESC);
SELECT app_enable_firm_rls('email_log'::regclass);

-- ---------------------------------------------------------------- defaults for existing firms
-- Prefix: the firm's initials (Nichols Law -> NL), letters only, at most 4.
DO $$
DECLARE
  f RECORD;
  initials TEXT;
BEGIN
  FOR f IN SELECT id, name FROM firms LOOP
    PERFORM set_config('app.actor_kind', 'system', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.firm_id', f.id::text, true);
    initials := left(upper(regexp_replace(initcap(f.name), '[^A-Z]', '', 'g')), 4);
    IF initials = '' THEN initials := 'INV'; END IF;
    INSERT INTO billing_settings (firm_id, invoice_prefix) VALUES (f.id, initials)
    ON CONFLICT (firm_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.actor_kind', '', true);
  PERFORM set_config('app.firm_id', '', true);
END $$;
