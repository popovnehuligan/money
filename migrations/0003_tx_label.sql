-- Your own name for a payment ("Gift for Kate" instead of "Platba 7500/000000-…"), shown instead of the bank's.
ALTER TABLE tx ADD COLUMN label TEXT;
