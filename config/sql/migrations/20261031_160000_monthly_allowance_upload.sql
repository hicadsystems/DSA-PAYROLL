-- Migration: monthly_allowance_upload
-- Created: 2026-10-31
-- Tables for Data Input > Monthly Allowance Upload.
-- Run against the master DB (MYSQL_DB_OFFICERS / dsa_hicaddata). Safe to re-run.
-- (The app also creates these on first use if they are missing.)

-- =========================
-- UP
-- =========================

-- Which payment type each DSA sheet loads into, per payroll class.
-- skip_sheet = 1 means the sheet is ignored by the menu (e.g. NRA).
CREATE TABLE IF NOT EXISTS py_allowance_sheetmap (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sheet_key VARCHAR(100) NOT NULL,
  sheet_name VARCHAR(100) NOT NULL,
  payrollclass VARCHAR(5) NOT NULL,
  paytype VARCHAR(6) NULL,
  skip_sheet TINYINT(1) NOT NULL DEFAULT 0,
  createdby VARCHAR(100) NULL,
  datecreated DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_allowance_sheet_class (sheet_key, payrollclass)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per upload (batch name = py_payded.batchName).
CREATE TABLE IF NOT EXISTS py_allowance_upload (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_name VARCHAR(50) NOT NULL,
  file_name VARCHAR(255) NULL,
  period_label VARCHAR(30) NULL,
  uploaded_by VARCHAR(100) NULL,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(12) NOT NULL DEFAULT 'committed',
  summary_json LONGTEXT NULL,
  undone_by VARCHAR(100) NULL,
  undone_at DATETIME NULL,
  UNIQUE KEY uq_allowance_batch (batch_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rows replaced/removed/created by an upload, used by Undo.
CREATE TABLE IF NOT EXISTS py_allowance_upload_bak (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  batch_name VARCHAR(50) NOT NULL,
  db_name VARCHAR(64) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  row_key VARCHAR(100) NULL,
  row_json LONGTEXT NOT NULL,
  KEY idx_allowance_bak_batch (batch_name, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Current sheet -> payment type mapping (class 1 = MILITARY, 2 = CIVILIAN)
-- createdby is left empty: it becomes the user who first uploads a file with that sheet.
INSERT IGNORE INTO py_allowance_sheetmap (sheet_key, sheet_name, payrollclass, paytype, skip_sheet, createdby) VALUES
  ('NRA', 'NRA', '1', NULL, 1, NULL),
  ('NRA', 'NRA', '2', NULL, 1, NULL),
  ('RUNNING COST', 'Running Cost', '1', 'PT312', 0, NULL),
  ('RUNNING COST', 'Running Cost', '2', 'PT312', 0, NULL),
  ('RESPONSIBILITY ALLCE', 'Responsibility Allce', '1', 'PT317', 0, NULL),
  ('RCA OROGUN ARMED GUARDS', 'RCA Orogun Armed Guards', '1', 'PT319', 0, NULL),
  ('RCA OROGUN ARMED GUARDS', 'RCA Orogun Armed Guards', '2', 'PT319', 0, NULL),
  ('FORMER CDSA', 'Former CDSA', '1', 'PT320', 0, NULL),
  ('MEOO', 'MEOO', '1', 'PT314', 0, NULL),
  ('MEOO', 'MEOO', '2', 'PT314', 0, NULL),
  ('RESEARCH & ADMIN', 'RESEARCH & ADMIN', '2', 'PT302', 0, NULL),
  ('CONTRACT', 'CONTRACT', '2', 'PT322', 0, NULL),
  ('NYSC ALLOWANCE', 'NYSC ALLOWANCE', '2', 'PT321', 0, NULL),
  ('CORPERS & IT', 'Corpers & IT', '2', 'PT302', 0, NULL),
  ('DSS OROGUN SAL', 'DSS OROGUN SAL', '2', 'PT323', 0, NULL),
  ('DSS ANNEX SALARIES', 'DSS Annex Salaries', '2', 'PT324', 0, NULL);

-- =========================
-- DOWN (Rollback)
-- =========================
DROP TABLE IF EXISTS py_allowance_upload_bak;
DROP TABLE IF EXISTS py_allowance_upload;
DROP TABLE IF EXISTS py_allowance_sheetmap;
