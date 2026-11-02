-- The month a payment counts for, when it isn't the month it arrived in: a wage paid early on
-- 30 October for November says '2026-11'. NULL means the month of ts.
ALTER TABLE tx ADD COLUMN month TEXT;
