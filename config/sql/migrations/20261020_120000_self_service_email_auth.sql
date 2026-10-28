-- Migration: self_service_email_auth
-- Created: 2026-10-20
-- Personnel self-service port from NAVY-PAYROLL (payslip, email, password reset).
-- Run against the officers / master DB (MYSQL_DB_OFFICERS). Safe to re-run.

-- =========================
-- UP
-- =========================

-- 1. hr_employees: auth + reset + mail storage columns (added only if missing)
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'password');
SET @sql = IF(@c = 0, 'ALTER TABLE hr_employees ADD COLUMN password VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'token');
SET @sql = IF(@c = 0, 'ALTER TABLE hr_employees ADD COLUMN token TEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'force_change');
SET @sql = IF(@c = 0, 'ALTER TABLE hr_employees ADD COLUMN force_change TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'password_changed_at');
SET @sql = IF(@c = 0, 'ALTER TABLE hr_employees ADD COLUMN password_changed_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'reset_hash');
SET @sql = IF(@c = 0, 'ALTER TABLE hr_employees ADD COLUMN reset_hash CHAR(64) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'reset_expires_at');
SET @sql = IF(@c = 0, 'ALTER TABLE hr_employees ADD COLUMN reset_expires_at DATETIME NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'storage_used_bytes');
SET @sql = IF(@c = 0, 'ALTER TABLE hr_employees ADD COLUMN storage_used_bytes BIGINT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'storage_quota_bytes');
SET @sql = IF(@c = 0, 'ALTER TABLE hr_employees ADD COLUMN storage_quota_bytes BIGINT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Widen hr_employees.password so argon2 hashes (about 97 chars) are not truncated
SET @len = (SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'password');
SET @sql = IF(@len IS NOT NULL AND @len < 255, 'ALTER TABLE hr_employees MODIFY COLUMN password VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Index for reset-token lookups
SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND INDEX_NAME = 'idx_hr_employees_reset_hash');
SET @sql = IF(@i = 0, 'CREATE INDEX idx_hr_employees_reset_hash ON hr_employees (reset_hash)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Internal mail
CREATE TABLE IF NOT EXISTS user_mails (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id VARCHAR(64) NULL,
  from_user_id VARCHAR(50) NOT NULL,
  from_name VARCHAR(255) NULL,
  from_email VARCHAR(255) NULL,
  to_user_id VARCHAR(50) NOT NULL,
  to_name VARCHAR(255) NULL,
  to_email VARCHAR(255) NULL,
  subject VARCHAR(500) NULL,
  body LONGTEXT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  is_notification TINYINT(1) NOT NULL DEFAULT 0,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME NULL,
  read_at DATETIME NULL,
  deleted_by_sender TINYINT(1) NOT NULL DEFAULT 0,
  deleted_by_receiver TINYINT(1) NOT NULL DEFAULT 0,
  INDEX idx_user_mails_inbox (to_user_id, deleted_by_receiver, sent_at),
  INDEX idx_user_mails_unread (to_user_id, is_read),
  INDEX idx_user_mails_sent (from_user_id, deleted_by_sender, sent_at),
  INDEX idx_user_mails_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mail_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  mail_id INT NULL,
  temp_token VARCHAR(64) NULL,
  filename VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(150) NULL,
  file_size BIGINT NOT NULL DEFAULT 0,
  uploaded_by VARCHAR(50) NOT NULL,
  content_hash CHAR(64) NULL,
  is_duplicate TINYINT(1) NOT NULL DEFAULT 0,
  original_attachment_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mail_attachments_mail (mail_id),
  INDEX idx_mail_attachments_token (temp_token, uploaded_by),
  INDEX idx_mail_attachments_hash (content_hash),
  INDEX idx_mail_attachments_original (original_attachment_id),
  INDEX idx_mail_attachments_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mail_attachment_downloads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attachment_id INT NOT NULL,
  user_id VARCHAR(50) NOT NULL,
  downloaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mail_attachment_download (attachment_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =========================
-- DOWN (Rollback)
-- =========================
-- Drops the mail tables and the reset/storage columns.
-- Leaves password, token, force_change and password_changed_at alone: DSA used them before this port.
DROP TABLE IF EXISTS mail_attachment_downloads;
DROP TABLE IF EXISTS mail_attachments;
DROP TABLE IF EXISTS user_mails;

SET @i = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND INDEX_NAME = 'idx_hr_employees_reset_hash');
SET @sql = IF(@i > 0, 'DROP INDEX idx_hr_employees_reset_hash ON hr_employees', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'reset_hash');
SET @sql = IF(@c > 0, 'ALTER TABLE hr_employees DROP COLUMN reset_hash', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'reset_expires_at');
SET @sql = IF(@c > 0, 'ALTER TABLE hr_employees DROP COLUMN reset_expires_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'storage_used_bytes');
SET @sql = IF(@c > 0, 'ALTER TABLE hr_employees DROP COLUMN storage_used_bytes', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hr_employees' AND COLUMN_NAME = 'storage_quota_bytes');
SET @sql = IF(@c > 0, 'ALTER TABLE hr_employees DROP COLUMN storage_quota_bytes', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
