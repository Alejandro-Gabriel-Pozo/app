-- migrations/009_customer_rates.sql
-- Agrega customer_rates (tarifas especiales por cliente) — feature de
-- cuentas corrientes / clientes especiales / tarifas especiales.
-- SAFE TO RE-RUN: usa IF NOT EXISTS.
--
-- Ejecutar contra CADA BD de tenant existente:
--   psql <tenant_db_url> -f migrations/009_customer_rates.sql

CREATE TABLE IF NOT EXISTS customer_rates (
  id           VARCHAR(255)   PRIMARY KEY,
  business_id  VARCHAR(255)   NOT NULL,
  customer_id  VARCHAR(255)   NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  resource_id  VARCHAR(255)   REFERENCES resources(id) ON DELETE CASCADE,
  service_id   VARCHAR(255)   REFERENCES bookable_services(id) ON DELETE CASCADE,
  price        DECIMAL(10,2)  NOT NULL CHECK (price >= 0),
  active       BOOLEAN        NOT NULL DEFAULT TRUE,
  notes        TEXT,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_customer_rate_target CHECK (
    (resource_id IS NOT NULL AND service_id IS NULL) OR
    (resource_id IS NULL AND service_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_resource
  ON customer_rates (customer_id, resource_id)
  WHERE active = TRUE AND resource_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_service
  ON customer_rates (customer_id, service_id)
  WHERE active = TRUE AND service_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_rates_customer
  ON customer_rates (customer_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'customer_rates_updated_at') THEN
    CREATE TRIGGER customer_rates_updated_at
      BEFORE UPDATE ON customer_rates
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- financial_transactions.notes (misma feature, faltaba en tenants existentes)
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS notes VARCHAR(500);
