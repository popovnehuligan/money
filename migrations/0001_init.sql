-- All money is stored in euro cents; negative amount = money left the account.
-- Times are local Bratislava wall-clock strings: YYYY-MM-DDTHH:MM.
CREATE TABLE tx (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id TEXT NOT NULL UNIQUE,           -- Gmail message id, 'cash-…' or 'gap-…'
  ts TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  balance INTEGER,                       -- account balance after this tx, if the bank says
  merchant TEXT,
  iban TEXT,                             -- counterparty IBAN for transfers
  note TEXT,
  method TEXT NOT NULL,                  -- card | transfer | atm | cash | gap | other
  key TEXT,                              -- normalized merchant/IBAN used to learn your choices
  kind TEXT NOT NULL,                    -- spend | income | savings | podmoga | ignore
  category TEXT,
  worth INTEGER,                         -- 1 = worth it, 0 = regret
  confirmed INTEGER NOT NULL DEFAULT 0,  -- 1 once you picked kind/category yourself
  source TEXT NOT NULL,                  -- bmail | manual | gap
  raw TEXT,                              -- original e-mail text, kept so it can be re-parsed
  tg_msg INTEGER
);
CREATE INDEX tx_ts ON tx(ts);
CREATE INDEX tx_key ON tx(key, confirmed);

-- b-mails the parser could not read; kept so the parser can be improved and re-run.
CREATE TABLE unparsed (
  ext_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  subject TEXT,
  body TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
