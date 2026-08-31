-- Sync service_catalog.base_client_price to the current retail_prices list.
--
-- Why: service_catalog is what the portal and the quoting flow bill from, while
-- retail_prices is the maintained internal price list. They had drifted apart on
-- 12 services. Four of those were being sold below the Παράρτημα Α wholesale cost
-- (Freelancer Setup 79 vs 100, Tax Authority Letters 20 vs 25, Tax Residency
-- Certificate 49 vs 50, AFM Registration 29 vs 30).
--
-- Scope: data only, no schema change. Idempotent: re-running is a no-op once the
-- two tables agree.
--
-- SRV-D03 (Monthly Bookkeeping Retainer) is deliberately EXCLUDED. retail_prices
-- holds 79 with price_unit = 'per_month'; service_catalog holds 600 on an implied
-- annual basis and has no price_unit column to carry the distinction. Writing 79
-- there would read as a 79 one-off and understate the service by an order of
-- magnitude. Decide the basis first, then handle that row on its own.
--
-- Rows changed by this migration (portal now -> retail target):
--   SRV-C05  Article 5C Foreign Employee Regime        499 -> 249
--   SRV-C01  Tax Residency - Moving to Greece          299 -> 150
--   SRV-C02  Tax Residency - Leaving Greece            199 -> 149
--   SRV-B08  Amended Return                             40 ->  50
--   SRV-B02  E2 Rental Income Declaration               25 ->  49
--   SRV-E01  Tax Authority Letters                      20 ->  49
--   SRV-B04  E9 Property Declaration                    39 ->  69
--   SRV-B07  Back-Year Declarations                     50 ->  89
--   SRV-A01  AFM Registration                           29 ->  69
--   SRV-C06  Tax Residency Certificate                  49 -> 120
--   SRV-D01  Freelancer Setup and EFKA Registration     79 -> 199

update service_catalog sc
set base_client_price = rp.retail_price,
    updated_at        = now()
from retail_prices rp
where rp.service_id       = sc.id
  and rp.effective_to     is null
  and rp.retail_price     is not null
  and sc.base_client_price is distinct from rp.retail_price
  and sc.service_code     <> 'SRV-D03';
