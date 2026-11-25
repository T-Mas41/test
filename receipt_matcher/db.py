"""SQLite(PC内の1ファイル)。"""
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY,
  cust TEXT NOT NULL, cust_name TEXT, store TEXT NOT NULL,
  partner_code TEXT NOT NULL, own_code TEXT NOT NULL, own_name TEXT
);
CREATE INDEX IF NOT EXISTS ix_ledger_key ON ledger(cust, store, partner_code);
CREATE TABLE IF NOT EXISTS ledger_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  file_name TEXT, imported_at TEXT, total_rows INTEGER, loaded_rows INTEGER,
  deleted_rows INTEGER, skipped_rows INTEGER
);
CREATE TABLE IF NOT EXISTS layouts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  is_standard INTEGER NOT NULL DEFAULT 0,
  file_type TEXT NOT NULL DEFAULT 'excel',
  encoding TEXT NOT NULL DEFAULT 'cp932',
  delimiter TEXT NOT NULL DEFAULT ',',
  sheet_name TEXT NOT NULL DEFAULT '',
  header_row INTEGER NOT NULL DEFAULT 1,
  data_start_row INTEGER NOT NULL DEFAULT 2,
  sample_file TEXT, sample_rows TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS layout_columns (
  layout_id INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  col_no INTEGER NOT NULL, header TEXT, role TEXT NOT NULL DEFAULT '', date_format TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (layout_id, col_no)
);
CREATE TABLE IF NOT EXISTS customer_layouts (
  cust TEXT PRIMARY KEY, cust_name TEXT,
  layout_id INTEGER NOT NULL REFERENCES layouts(id)
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,            -- draft / done
  parent_id INTEGER,               -- 再取込の下書きが置き換える照合
  cust TEXT NOT NULL, cust_name TEXT,
  date_from TEXT NOT NULL, date_to TEXT NOT NULL,
  sales_file TEXT, receipt_file TEXT, layout_name TEXT,
  stats TEXT, errors TEXT,
  created_at TEXT, matched_at TEXT,
  total_judge TEXT, total_diff_amt INTEGER, slip_diff_rows INTEGER, unchecked_rows INTEGER
);
CREATE TABLE IF NOT EXISTS sales_lines (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  row_no INTEGER, store TEXT, store_name TEXT, tdate TEXT, order_no TEXT, slip_no TEXT,
  own_code TEXT, name TEXT, qty INTEGER, wt INTEGER, amt INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sales_match ON sales_lines(match_id);
CREATE TABLE IF NOT EXISTS receipt_lines (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  row_no INTEGER, store TEXT, store_name TEXT, tdate TEXT, order_no TEXT,
  partner_code TEXT, own_code TEXT, name TEXT, own_name TEXT,
  qty INTEGER, wt INTEGER, unit_price TEXT, amt INTEGER,
  conv_status TEXT, conv_note TEXT
);
CREATE INDEX IF NOT EXISTS ix_receipt_match ON receipt_lines(match_id);
CREATE TABLE IF NOT EXISTS confirmations (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  view TEXT NOT NULL, key TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0, comment TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  PRIMARY KEY (match_id, view, key)
);
"""


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()
