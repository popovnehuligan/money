-- Which loan a 🤝 Loan payment belongs to (the debt's name), when there is more than one.
ALTER TABLE tx ADD COLUMN debt TEXT;
