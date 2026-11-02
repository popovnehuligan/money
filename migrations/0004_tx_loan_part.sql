-- Part of a spending payment that paid back a loan (the loan named in tx.debt), in cents with the
-- payment's sign: half a bar bill that paid a friend back is -600 of a -1200 payment.
ALTER TABLE tx ADD COLUMN loan_part INTEGER;
