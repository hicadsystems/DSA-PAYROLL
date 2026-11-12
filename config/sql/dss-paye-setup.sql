-- =====================================================================
-- DSS STAFF: CONSOLIDATED PAY, ALLOWANCES, PENSION, NHF AND PAYE
-- ---------------------------------------------------------------------
-- Payroll class : CIVILIAN (database dsa_hicaddata1)
-- Shared tables : dsa_hicaddata (hr_employees, py_paysystem,
--                 py_allowance_sheetmap)
-- Military      : not changed. Nobody in the military class is marked
--                 Taxed, so their PAYE stays at 0.
--
-- HOW TO RUN
--   1. Take a backup first.
--   2. Run this whole script once, top to bottom, as root, in MySQL
--      Workbench or the mysql command line.
--   3. In the app, CIVILIAN class: run Master File Update, then
--      Payroll Calculation.
--   4. Run the checks at the bottom (PART 10) and share the results.
--
-- WHAT IT DOES
--   PART 1  Records the DSS staff (everyone on PT323 DSS Orogun Salary
--           or PT324 DSS Annex Salary) in table py_dss_staff.
--   PART 2  Pay elements: BP303 consolidated pay (from the CONSSDSA
--           salary scale), BT301 DSS allowances (taxable, by grade),
--           PR306 NHF 2.5% and PR310 pension 8% of BP303.
--           PT323 and PT324 (the flat take-home amounts) are switched off.
--   PART 3  DSS allowance amount per grade level (from DSA's schedule).
--   PART 4  Gives DSS staff the new elements.
--   PART 5  Marks DSS staff Taxed = YES.
--   PART 6  Stops the DSS sheets of the monthly template being uploaded.
--   PART 7  2026 PAYE bands; removes the old 7% minimum tax.
--   PART 8  Turns on Company Profile > Independent Monthly Tax.
--   PART 9  New calculation procedure (only the tax section changes,
--           and a failed calculation now reports as failed).
--   PART 10 Checks to run after Master File Update + Calculation.
-- =====================================================================


USE dsa_hicaddata1;

-- =====================================================================
-- PART 1: DSS staff list
-- =====================================================================
CREATE TABLE IF NOT EXISTS dsa_hicaddata1.py_dss_staff (
  empl_id     VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  old_type    VARCHAR(6)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  old_amount  DECIMAL(19,4) DEFAULT NULL,
  datecreated DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (empl_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO dsa_hicaddata1.py_dss_staff (empl_id, old_type, old_amount)
SELECT his_Empno, MIN(his_type), MAX(amtthismth)
FROM dsa_hicaddata1.py_masterpayded
WHERE his_type IN ('PT323', 'PT324')
GROUP BY his_Empno;

INSERT IGNORE INTO dsa_hicaddata1.py_dss_staff (empl_id, old_type, old_amount)
SELECT Empl_ID, MIN(type), MAX(amtp)
FROM dsa_hicaddata1.py_payded
WHERE type IN ('PT323', 'PT324')
GROUP BY Empl_ID;

-- Expect 156 (142 DSS Orogun + 14 DSS Annex)
SELECT old_type, COUNT(*) AS dss_staff
FROM dsa_hicaddata1.py_dss_staff
GROUP BY old_type;


-- =====================================================================
-- PART 2: Pay elements (civilian)
-- =====================================================================
-- BP303 consolidated pay: active, and NOT given automatically to every
-- civilian (bpay = 'No'); only DSS staff get it (PART 4).
UPDATE dsa_hicaddata1.py_elementtype
   SET Status = 'Active',
       bpay   = 'No'
 WHERE PaymentType = 'BP303';

-- BT301 = DSS allowances (skill + radiation hazard + shift), taxable,
--         amount by grade level from py_payperrank (perc 'R').
-- PR306 = NHF, 2.5% of BP303 (PR306 is the code the NHF report reads).
-- PR310 = Pension (employee), 8% of BP303.
-- freetax = 1 marks a deduction as tax-deductible (reduces taxable pay).
INSERT INTO dsa_hicaddata1.py_elementtype
  (PaymentType, elmDesc, Ledger, perc, std, maxi, bpay, yearend, Status,
   dependence, payfreq, pmonth, freetax, createdby, datecreated, ipis)
VALUES
  ('BT301', 'DSS ALLOWANCES',               NULL, 'R', NULL, NULL, 'No', 'Yes', 'Active', NULL,    'M', NULL, 0, 'DSS SETUP', NOW(), NULL),
  ('PR306', 'NHF (2.5% OF CONSOLIDATED)',   NULL, 'P', 2.5,  NULL, 'No', 'Yes', 'Active', 'BP303', 'M', NULL, 1, 'DSS SETUP', NOW(), NULL),
  ('PR310', 'PENSION EMPLOYEE (8%)',        NULL, 'P', 8,    NULL, 'No', 'Yes', 'Active', 'BP303', 'M', NULL, 1, 'DSS SETUP', NOW(), NULL)
ON DUPLICATE KEY UPDATE
  elmDesc    = VALUES(elmDesc),
  perc       = VALUES(perc),
  std        = VALUES(std),
  bpay       = VALUES(bpay),
  Status     = VALUES(Status),
  dependence = VALUES(dependence),
  payfreq    = VALUES(payfreq),
  freetax    = VALUES(freetax);

-- Switch off the flat take-home amounts for DSS staff
UPDATE dsa_hicaddata1.py_elementtype
   SET Status = 'Inactive'
 WHERE PaymentType IN ('PT323', 'PT324');


-- =====================================================================
-- PART 3: DSS allowance per month, by grade level (DSA schedule, Oct 2026)
--   GL02 7,484.16   GL03 8,259.74   GL05 9,728.66   GL07 35,689.00
--   GL08 41,998.50  GL09 46,933.08  GL10 48,986.01  GL11 51,038.75
--   Grades not on DSA's schedule are 0. Edit here if DSA changes them.
-- =====================================================================
INSERT INTO dsa_hicaddata1.py_payperrank
  (one_type,
   one_amount01, one_amount02, one_amount03, one_amount04, one_amount05,
   one_amount06, one_amount07, one_amount08, one_amount09, one_amount10,
   one_amount11, one_amount12, one_amount13, one_amount14, one_amount15,
   one_amount16, one_amount17, one_amount18, one_amount19, one_amount20,
   one_amount21, one_amount22, createdby)
VALUES
  ('BT301',
   0, 7484.16, 8259.74, 0, 9728.66,
   0, 35689.00, 41998.50, 46933.08, 48986.01,
   51038.75, 0, 0, 0, 0,
   0, 0, 0, 0, 0,
   0, 0, 'DSS SETUP')
ON DUPLICATE KEY UPDATE
  one_amount01 = VALUES(one_amount01), one_amount02 = VALUES(one_amount02),
  one_amount03 = VALUES(one_amount03), one_amount04 = VALUES(one_amount04),
  one_amount05 = VALUES(one_amount05), one_amount06 = VALUES(one_amount06),
  one_amount07 = VALUES(one_amount07), one_amount08 = VALUES(one_amount08),
  one_amount09 = VALUES(one_amount09), one_amount10 = VALUES(one_amount10),
  one_amount11 = VALUES(one_amount11), one_amount12 = VALUES(one_amount12),
  one_amount13 = VALUES(one_amount13), one_amount14 = VALUES(one_amount14),
  one_amount15 = VALUES(one_amount15), one_amount16 = VALUES(one_amount16),
  one_amount17 = VALUES(one_amount17), one_amount18 = VALUES(one_amount18),
  one_amount19 = VALUES(one_amount19), one_amount20 = VALUES(one_amount20),
  one_amount21 = VALUES(one_amount21), one_amount22 = VALUES(one_amount22);


-- =====================================================================
-- PART 4: Give DSS staff BP303, BT301, PR306 and PR310
--   Permanent inputs (payind blank). Master File Update fills the
--   amounts: BP303 from the CONSSDSA scale (annual / 12), BT301 from
--   PART 3, PR306/PR310 as percentages of BP303.
-- =====================================================================
DELETE pd
FROM dsa_hicaddata1.py_payded pd
INNER JOIN dsa_hicaddata1.py_dss_staff d ON d.empl_id = pd.Empl_ID
WHERE pd.type IN ('BP303', 'BT301', 'PR306', 'PR310');

INSERT INTO dsa_hicaddata1.py_payded
  (Empl_ID, type, mak1, amtp, mak2, amt, amtad, amttd, payind, nomth,
   createdby, datecreated, batchName)
SELECT d.empl_id, e.type, 'No', 1, 'No', 0, NULL, 0, '', 0,
       'DSS SETUP', NOW(), 'DSS-SETUP'
FROM dsa_hicaddata1.py_dss_staff d
CROSS JOIN (
  SELECT 'BP303' AS type UNION ALL
  SELECT 'BT301'         UNION ALL
  SELECT 'PR306'         UNION ALL
  SELECT 'PR310'
) e;

-- Expect 624 (156 staff x 4)
SELECT COUNT(*) AS new_inputs
FROM dsa_hicaddata1.py_payded
WHERE batchName = 'DSS-SETUP';


-- =====================================================================
-- PART 5: Mark DSS staff as taxed
-- =====================================================================
UPDATE dsa_hicaddata.hr_employees h
INNER JOIN dsa_hicaddata1.py_dss_staff d ON d.empl_id = h.Empl_ID
SET h.taxed = 'YES';

UPDATE dsa_hicaddata1.py_wkemployees w
INNER JOIN dsa_hicaddata1.py_dss_staff d ON d.empl_id = w.Empl_ID
SET w.taxed = 'YES';

-- Expect 156
SELECT COUNT(*) AS taxed_staff
FROM dsa_hicaddata.hr_employees
WHERE taxed = 'YES';


-- =====================================================================
-- PART 6: Stop loading DSS pay from the monthly template
-- =====================================================================
UPDATE dsa_hicaddata.py_allowance_sheetmap
   SET skip_sheet = 1
 WHERE payrollclass = '2'
   AND sheet_key IN ('DSS OROGUN SAL', 'DSS ANNEX SALARIES');

-- keep a copy of the old PT323/PT324 inputs, then remove them
CREATE TABLE IF NOT EXISTS dsa_hicaddata1.py_payded_bak_dss LIKE dsa_hicaddata1.py_payded;

INSERT INTO dsa_hicaddata1.py_payded_bak_dss
SELECT * FROM dsa_hicaddata1.py_payded
WHERE type IN ('PT323', 'PT324');

DELETE FROM dsa_hicaddata1.py_payded
WHERE type IN ('PT323', 'PT324');


-- =====================================================================
-- PART 7: 2026 PAYE bands (civilian py_tax)
--   val = band width, perc = rate %, lowbound/cumval = band start/end.
--   Top band width is 2,000,000,000 because val is an INT column.
-- =====================================================================
DELETE FROM dsa_hicaddata1.py_tax WHERE INTER <> '999';

INSERT INTO dsa_hicaddata1.py_tax (INTER, val, perc, createdby, lowbound, cumval) VALUES
  ('1',     800000,  0, 'DSS SETUP',        0,     800000),
  ('2',    2200000, 15, 'DSS SETUP',   800000,    3000000),
  ('3',    9000000, 18, 'DSS SETUP',  3000000,   12000000),
  ('4',   13000000, 21, 'DSS SETUP', 12000000,   25000000),
  ('5',   25000000, 23, 'DSS SETUP', 25000000,   50000000),
  ('6', 2000000000, 25, 'DSS SETUP', 50000000, 2050000000);

-- old relief / 7% minimum tax row: all zero
UPDATE dsa_hicaddata1.py_tax
   SET val = 0, perc = 0, cumval = 0, lowbound = 0
 WHERE INTER = '999';

SELECT * FROM dsa_hicaddata1.py_tax ORDER BY INTER;


-- =====================================================================
-- PART 8: Company Profile > Independent Monthly Tax = Yes
--   Shared by both classes. Only staff marked Taxed = YES pay PAYE.
-- =====================================================================
UPDATE dsa_hicaddata.py_paysystem SET mthly_tax = 'Yes';


-- =====================================================================
-- PART 9: Calculation procedure (civilian)
--   Same as the current procedure except:
--   * the tax section (marked [DSS SETUP]) is replaced;
--   * the error handler ends with RESIGNAL, so a failed calculation
--     is reported as failed instead of looking successful.
-- =====================================================================
USE dsa_hicaddata1;

DROP PROCEDURE IF EXISTS sp_calculate_01_complete_optimized;

DELIMITER $$
CREATE PROCEDURE `sp_calculate_01_complete_optimized`(
IN p_user VARCHAR(50),
IN p_batch_size INT,
IN p_globalcoy VARCHAR(10),
IN p_gtaxed VARCHAR(3)
)
proc_end: BEGIN

DECLARE v_start DATETIME DEFAULT NOW();
DECLARE v_year INT;
DECLARE v_month TINYINT;
DECLARE v_prev_month TINYINT;
DECLARE v_total INT DEFAULT 0;
DECLARE v_offset INT DEFAULT 0;
DECLARE v_processed INT DEFAULT 0;
DECLARE v_batch_count INT DEFAULT 0;
DECLARE v_curdate DATE;
DECLARE v_perdiff INT DEFAULT 0;
DECLARE v_mincard DECIMAL(15,2) DEFAULT 0;
DECLARE v_freecard DECIMAL(15,2) DEFAULT 0;
DECLARE v_cumval DECIMAL(15,2) DEFAULT 0;
DECLARE v_exec_time BIGINT;

-- ==========================
-- EXIT HANDLER FOR FAILURE
-- ==========================
DECLARE EXIT HANDLER FOR SQLEXCEPTION
BEGIN
    GET DIAGNOSTICS CONDITION 1
    @sqlstate = RETURNED_SQLSTATE, 
    @errno = MYSQL_ERRNO, 
    @text = MESSAGE_TEXT;

    ROLLBACK;

    UPDATE py_process_control 
       SET status='FAILED', error_message=CONCAT('Error ', @errno, ': ', @text)
     WHERE process_year=COALESCE(v_year,0) AND process_month=COALESCE(v_month,0);
     
    INSERT INTO py_performance_log (procedure_name, process_year, process_month, status, started_at, completed_at, error_details)
    VALUES ('sp_calculate_01_complete_optimized', COALESCE(v_year,0), COALESCE(v_month,0), 'FAILED', v_start, NOW(), 
    CONCAT('Error ', @errno, ': ', @text, ' by ', COALESCE(p_user,'')));

    SELECT 'FAILED' AS status, CONCAT('Error ', @errno, ': ', @text) AS error_message;
    RESIGNAL;
END;

START TRANSACTION;

-- =====================================
-- 1) DETERMINE PERIOD & INITIALIZE
-- =====================================
SELECT COALESCE(ord, YEAR(CURDATE())), COALESCE(mth, MONTH(CURDATE())), COALESCE(pmth, MONTH(CURDATE())-1)
INTO v_year, v_month, v_prev_month
FROM py_stdrate WHERE type='BT05' LIMIT 1;

IF v_year IS NULL OR v_month IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BT05 not set in py_stdrate';
END IF;

-- Get period difference threshold
SELECT COALESCE(sat, 0) INTO v_perdiff FROM py_stdrate WHERE type='BT04' LIMIT 1;

-- Calculate current period end date
IF v_month < 12 THEN
    SET v_curdate = LAST_DAY(STR_TO_DATE(CONCAT(v_year, '-', v_month, '-01'), '%Y-%m-%d'));
ELSE
    SET v_curdate = LAST_DAY(CONCAT(v_year, '-', v_month, '-01'));
END IF;

-- Get tax parameters
SELECT COALESCE(val, 0), COALESCE(lowbound, 0), COALESCE(cumval, 0)
INTO v_mincard, v_freecard, v_cumval
FROM py_tax WHERE inter=999 LIMIT 1;

-- Ensure safe batch size
IF p_batch_size IS NULL OR p_batch_size <= 0 THEN
    SET p_batch_size = 500;
END IF;

-- Update status flag
UPDATE py_stdrate SET sun=999 WHERE type='BT05';

-- Clear temp tables
DELETE FROM py_tempnsitf WHERE work_station=p_user;

-- =====================================
-- 2) GET TOTAL EMPLOYEES
-- =====================================
SELECT COUNT(*) INTO v_total 
FROM py_wkemployees;

IF v_total = 0 THEN
    INSERT INTO py_process_control (process_year, process_month, status, phase, started_by, started_date)
    VALUES (v_year, v_month, 'NO_RECORDS', 'CALCULATION', p_user, NOW())
    ON DUPLICATE KEY UPDATE status='NO_RECORDS', phase='CALCULATION', started_by=p_user, started_date=NOW();

    INSERT INTO py_performance_log (procedure_name, process_year, process_month, records_processed, 
    execution_time_ms, started_at, completed_at, status)
    VALUES ('sp_calculate_01_complete_optimized', v_year, v_month, 0, 
    TIMESTAMPDIFF(MICROSECOND, v_start, NOW())/1000, v_start, NOW(), 'NO_RECORDS');

    COMMIT;
    SELECT 'NO_RECORDS' AS status;
    LEAVE proc_end;
END IF;

-- =====================================
-- 3) PROCESS EMPLOYEES IN BATCHES
-- =====================================
batch_loop: WHILE v_offset < v_total DO

    -- ====================================
    -- 3A) CREATE BATCH WORKING TABLES
    -- ====================================
    DROP TEMPORARY TABLE IF EXISTS tmp_batch_employees;
     
    CREATE TEMPORARY TABLE tmp_batch_employees (
        empl_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        payrollclass VARCHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        gradelevel VARCHAR(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        gradetype VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        dateleft VARCHAR(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        dateempl VARCHAR(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        taxed VARCHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        rent_subsidy VARCHAR(3) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        nomth INT,
        noofmth INT,
        taxbf VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        PRIMARY KEY (empl_id)
    ) ENGINE=INNODB;

    -- Get batch of employees
    INSERT INTO tmp_batch_employees (empl_id, payrollclass, gradelevel, gradetype, dateleft, dateempl, taxed, rent_subsidy, nomth, noofmth, taxbf)
    SELECT we.empl_id, we.payrollclass, we.gradelevel, we.gradetype, we.dateleft, we.dateempl, we.taxed, we.rent_subsidy, 1, 0, 'ARREARS'
    FROM py_wkemployees we
    ORDER BY we.empl_id
    LIMIT p_batch_size OFFSET v_offset;

    SET v_batch_count = ROW_COUNT();
    IF v_batch_count = 0 THEN
        LEAVE batch_loop;
    END IF;

    -- Calculate nomth and noofmth (same as Navy)
    UPDATE tmp_batch_employees tbe
    LEFT JOIN py_header ph ON ph.empl_id COLLATE utf8mb4_unicode_ci = tbe.empl_id
    SET 
        tbe.nomth = COALESCE(ph.nomth, 1),
        tbe.noofmth = 
            CASE
                WHEN ph.empl_id IS NULL THEN 0
                WHEN COALESCE(ph.nomth, 0) > 0 THEN LEAST(COALESCE(ph.nomth, 1), 12) * 22
                ELSE
                    GREATEST(0,
                        LEAST(264,
                            FLOOR((DATEDIFF(LAST_DAY(v_curdate), COALESCE(
                                STR_TO_DATE(TRIM(ph.effdate), '%Y%m%d'),
                                STR_TO_DATE(TRIM(ph.effdate), '%d%m%Y'),
                                LAST_DAY(v_curdate) 
                            )) + 1.0) / 7) * 5 +
                            CASE 
                                WHEN MOD((DATEDIFF(LAST_DAY(v_curdate), COALESCE(
                                    STR_TO_DATE(TRIM(ph.effdate), '%Y%m%d'),
                                    STR_TO_DATE(TRIM(ph.effdate), '%d%m%Y'),
                                    LAST_DAY(v_curdate)
                                )) + 1), 7) > 5 
                                THEN 5
                                ELSE MOD((DATEDIFF(LAST_DAY(v_curdate), COALESCE(
                                    STR_TO_DATE(TRIM(ph.effdate), '%Y%m%d'),
                                    STR_TO_DATE(TRIM(ph.effdate), '%d%m%Y'),
                                    LAST_DAY(v_curdate)
                                )) + 1), 7)
                            END
                        )
                    )
            END,
        tbe.taxbf = CASE 
            WHEN ph.empl_id IS NULL THEN 'ARREARS'
            WHEN COALESCE(ph.nomth, 0) = 0 THEN 'ARREARS' 
            ELSE 'ADVANCE' 
        END;

    -- ====================================
    -- 3B) LOAD PAYMENT DATA FOR BATCH
    -- ====================================
    DROP TEMPORARY TABLE IF EXISTS tmp_elements;
     
    CREATE TEMPORARY TABLE tmp_elements (
        empl_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        his_type VARCHAR(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        amtthismth DECIMAL(20,4),
        totamtpayable DECIMAL(20,4),
        totpaidtodate DECIMAL(20,4),
        nmth INT,
        payindic VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        initialloan DECIMAL(20,4),
        hisvar DECIMAL(20,4),
        PRIMARY KEY (empl_id, his_type),
        INDEX idx_type (his_type)
    ) ENGINE=INNODB;

    INSERT INTO tmp_elements
    SELECT mp.his_empno, mp.his_type, 
       COALESCE(mp.amtthismth,0), COALESCE(mp.totamtpayable,0), COALESCE(mp.totpaidtodate,0),
       COALESCE(mp.nmth,0), mp.payindic, COALESCE(mp.initialloan,0), COALESCE(mp.hisvar,0)
    FROM py_masterpayded mp
    WHERE mp.his_empno IN (SELECT empl_id FROM tmp_batch_employees);

    -- Get element metadata
    DROP TEMPORARY TABLE IF EXISTS tmp_element_meta;
     
    CREATE TEMPORARY TABLE tmp_element_meta (
        PaymentType VARCHAR(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        pmonth INT,
        payfreq VARCHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        perc VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        status VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        std DECIMAL(20,4),
        dependence VARCHAR(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        PRIMARY KEY (PaymentType)
    ) ENGINE=INNODB;

    -- DSA FIX: Ensure pmonth is stored as INT with proper CAST
    INSERT INTO tmp_element_meta
    SELECT 
        PaymentType, 
        CAST(CASE 
            WHEN pmonth IS NULL OR TRIM(pmonth) = '' THEN 0
            ELSE TRIM(pmonth)
        END AS UNSIGNED),  -- Force to INTEGER to prevent comparison issues
        payfreq, 
        perc, 
        status, 
        COALESCE(std,0),
        dependence
    FROM py_elementType;

    -- Get previous month cumulative
    DROP TEMPORARY TABLE IF EXISTS tmp_prev_cum;
     
    CREATE TEMPORARY TABLE tmp_prev_cum (
        empl_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        roundup DECIMAL(20,4),
        grosstodate DECIMAL(20,4),
        taxtodate DECIMAL(20,4),
        netmth DECIMAL(20,4),
        nettodate DECIMAL(20,4),
        grossmth DECIMAL(20,4),
        PRIMARY KEY (empl_id)
    ) ENGINE=INNODB;

    INSERT INTO tmp_prev_cum
    SELECT mc.his_empno, 
       COALESCE(mc.his_roundup,0), COALESCE(mc.his_grosstodate,0),
       COALESCE(mc.his_taxtodate,0), COALESCE(mc.his_netmth,0), 
       COALESCE(mc.his_nettodate,0), COALESCE(mc.his_grossmth,0)
    FROM py_mastercum mc
    WHERE mc.his_type = v_prev_month
      AND mc.his_empno IN (SELECT empl_id FROM tmp_batch_employees);

    -- ====================================
    -- 3C) CALCULATE AMOUNTS
    -- ====================================
    DROP TEMPORARY TABLE IF EXISTS tmp_calc;
     
    CREATE TEMPORARY TABLE tmp_calc (
        empl_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        his_type VARCHAR(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        calc_amt DECIMAL(20,4),
        new_totpaid DECIMAL(20,4),
        new_totpayable DECIMAL(20,4),
        new_nmth INT,
        new_loan DECIMAL(20,4),
        PRIMARY KEY (empl_id, his_type)
    ) ENGINE=INNODB;

    -- Base calculation (same as Navy)
    INSERT INTO tmp_calc
    SELECT 
        te.empl_id,
        te.his_type,
        CAST(
            CASE
                WHEN te.totamtpayable > 0 AND te.totamtpayable <= 0.1 AND te.amtthismth > 0 THEN
                    te.amtthismth + CAST(te.hisvar AS DECIMAL(20,4))
                
                WHEN LEFT(te.his_type, 2) = 'FP' THEN
                    CASE
                        WHEN v_prev_month > v_month OR COALESCE(be.dateempl,'0') = '0' THEN
                            (CAST(te.totamtpayable AS DECIMAL(20,4)) * v_month / 12)
                        ELSE
                            (CAST(te.totamtpayable AS DECIMAL(20,4)) * LEAST(
                                CASE 
                                    WHEN FLOOR(DATEDIFF(v_curdate, COALESCE(
                                        STR_TO_DATE(TRIM(be.dateempl), '%Y%m%d'),
                                        STR_TO_DATE(TRIM(be.dateempl), '%d%m%Y'),
                                        STR_TO_DATE('19900101', '%Y%m%d')
                                    )) / 30) < 0
                                    THEN v_month + FLOOR(DATEDIFF(v_curdate, COALESCE(
                                        STR_TO_DATE(TRIM(be.dateempl), '%Y%m%d'),
                                        STR_TO_DATE(TRIM(be.dateempl), '%d%m%Y'),
                                        STR_TO_DATE('19900101', '%Y%m%d')
                                    )) / 30)
                                    ELSE FLOOR(DATEDIFF(v_curdate, COALESCE(
                                        STR_TO_DATE(TRIM(be.dateempl), '%Y%m%d'),
                                        STR_TO_DATE(TRIM(be.dateempl), '%d%m%Y'),
                                        STR_TO_DATE('19900101', '%Y%m%d')
                                    )) / 30)
                                END,
                                v_month
                            ) / 12)
                    END

                WHEN LEFT(te.his_type, 2) = 'PL' OR te.payindic = 'L' THEN
                    CASE 
                        WHEN te.totamtpayable > 0 AND te.nmth > 0 THEN
                            (CAST(te.totamtpayable AS DECIMAL(20,4)) * 
                                LEAST(
                                    GREATEST(1, FLOOR(be.noofmth / 22) + 1),
                                    te.nmth
                                ) / te.nmth) +
                            CAST(te.hisvar AS DECIMAL(20,4)) +
                            (CAST(te.totamtpayable AS DECIMAL(20,4)) * COALESCE(em.std, 0) / 1200)
                        ELSE CAST(te.hisvar AS DECIMAL(20,4))
                    END

                WHEN te.payindic = 'T' THEN
                    CASE 
                        WHEN te.totamtpayable > 0 AND te.nmth > 0 THEN
                            (CAST(te.totamtpayable AS DECIMAL(20,4)) * 
                                LEAST(
                                    GREATEST(1, FLOOR(be.noofmth / 22) + 1),
                                    te.nmth
                                ) / te.nmth) + 
                            CAST(te.hisvar AS DECIMAL(20,4))
                        ELSE CAST(te.hisvar AS DECIMAL(20,4))
                    END

                WHEN te.payindic IN ('X', 'P', '') OR te.payindic IS NULL THEN
                    CASE 
                        WHEN te.totamtpayable > 0.1 THEN
                            CAST(te.amtthismth AS DECIMAL(20,4)) +
                            CASE
                                WHEN be.taxbf = 'ARREARS' THEN
                                    (CAST(te.totamtpayable AS DECIMAL(20,4)) / 12) + 
                                    (CAST(te.totamtpayable AS DECIMAL(20,4)) * be.noofmth / 264) + 
                                    CAST(te.hisvar AS DECIMAL(20,4))
                                ELSE
                                    (CAST(te.totamtpayable AS DECIMAL(20,4)) / 12) + 
                                    CAST(te.hisvar AS DECIMAL(20,4))
                            END
                        ELSE 
                            CAST(te.hisvar AS DECIMAL(20,4))
                    END

                ELSE CAST(te.amtthismth AS DECIMAL(20,4)) + CAST(te.hisvar AS DECIMAL(20,4))
            END
        AS DECIMAL(20,4)) as calc_amt,

        -- New totpaidtodate
        CAST(
            CASE
                WHEN te.totamtpayable > 0 AND te.totamtpayable <= 0.1 AND te.amtthismth > 0 THEN
                    te.totpaidtodate + te.amtthismth + CAST(te.hisvar AS DECIMAL(20,4))
                
                WHEN LEFT(te.his_type, 2) = 'FP' THEN
                    CAST(te.totpaidtodate AS DECIMAL(20,4)) +
                    CASE
                        WHEN v_prev_month > v_month OR COALESCE(be.dateempl,'0') = '0' THEN
                            (CAST(te.totamtpayable AS DECIMAL(20,4)) * v_month / 12)
                        ELSE
                            (CAST(te.totamtpayable AS DECIMAL(20,4)) * LEAST(
                                CASE 
                                    WHEN FLOOR(DATEDIFF(v_curdate, COALESCE(
                                        STR_TO_DATE(TRIM(be.dateempl), '%Y%m%d'),
                                        STR_TO_DATE(TRIM(be.dateempl), '%d%m%Y'),
                                        STR_TO_DATE('19900101', '%Y%m%d')
                                    )) / 30) < 0
                                    THEN v_month + FLOOR(DATEDIFF(v_curdate, COALESCE(
                                        STR_TO_DATE(TRIM(be.dateempl), '%Y%m%d'),
                                        STR_TO_DATE(TRIM(be.dateempl), '%d%m%Y'),
                                        STR_TO_DATE('19900101', '%Y%m%d')
                                    )) / 30)
                                    ELSE FLOOR(DATEDIFF(v_curdate, COALESCE(
                                        STR_TO_DATE(TRIM(be.dateempl), '%Y%m%d'),
                                        STR_TO_DATE(TRIM(be.dateempl), '%d%m%Y'),
                                        STR_TO_DATE('19900101', '%Y%m%d')
                                    )) / 30)
                                END,
                                v_month
                            ) / 12)
                    END
                
                WHEN LEFT(te.his_type, 2) = 'PL' OR te.payindic = 'L' THEN
                    CAST(te.totpaidtodate AS DECIMAL(20,4)) +
                    CASE WHEN te.totamtpayable > 0 AND te.nmth > 0 THEN
                        (CAST(te.totamtpayable AS DECIMAL(20,4)) * 
                            LEAST(
                                GREATEST(1, FLOOR(be.noofmth / 22) + 1),
                                te.nmth
                            ) / te.nmth) +
                        CAST(te.hisvar AS DECIMAL(20,4)) +
                        (CAST(te.totamtpayable AS DECIMAL(20,4)) * COALESCE(em.std, 0) / 1200)
                    ELSE CAST(te.hisvar AS DECIMAL(20,4)) END
                
                WHEN te.payindic = 'T' THEN
                    CAST(te.totpaidtodate AS DECIMAL(20,4)) +
                    CASE WHEN te.totamtpayable > 0 AND te.nmth > 0 THEN
                        (CAST(te.totamtpayable AS DECIMAL(20,4)) * 
                            LEAST(
                                GREATEST(1, FLOOR(be.noofmth / 22) + 1),
                                te.nmth
                            ) / te.nmth) + 
                        CAST(te.hisvar AS DECIMAL(20,4))
                    ELSE CAST(te.hisvar AS DECIMAL(20,4)) END
                
                WHEN te.payindic IN ('X', 'P', '') OR te.payindic IS NULL THEN
                    CAST(te.totpaidtodate AS DECIMAL(20,4)) +
                    CASE 
                        WHEN te.totamtpayable > 0.1 THEN
                            CAST(te.amtthismth AS DECIMAL(20,4)) +
                            CASE
                                WHEN be.taxbf = 'ARREARS' THEN
                                    (CAST(te.totamtpayable AS DECIMAL(20,4)) / 12) + 
                                    (CAST(te.totamtpayable AS DECIMAL(20,4)) * be.noofmth / 264) + 
                                    CAST(te.hisvar AS DECIMAL(20,4))
                                ELSE
                                    (CAST(te.totamtpayable AS DECIMAL(20,4)) / 12) + 
                                    CAST(te.hisvar AS DECIMAL(20,4))
                            END
                        ELSE 
                            CAST(te.hisvar AS DECIMAL(20,4))
                    END
                
                ELSE 
                    CAST(te.totpaidtodate AS DECIMAL(20,4)) + 
                    CASE
                        WHEN te.totamtpayable > 0.1 THEN
                            CAST(te.amtthismth AS DECIMAL(20,4)) +
                            CASE
                                WHEN be.taxbf = 'ARREARS' THEN
                                    (CAST(te.totamtpayable AS DECIMAL(20,4)) / 12) + 
                                    (CAST(te.totamtpayable AS DECIMAL(20,4)) * be.noofmth / 264) + 
                                    CAST(te.hisvar AS DECIMAL(20,4))
                                ELSE
                                    (CAST(te.totamtpayable AS DECIMAL(20,4)) / 12) + 
                                    CAST(te.hisvar AS DECIMAL(20,4))
                            END
                        ELSE 
                            CAST(te.hisvar AS DECIMAL(20,4))
                    END
            END
        AS DECIMAL(20,4)) as new_totpaid,

        -- New totamtpayable
        CAST(
            CASE
                WHEN te.totamtpayable > 0 AND te.totamtpayable <= 0.1 THEN
                    te.totamtpayable
                
                WHEN LEFT(te.his_type, 2) = 'PL' OR te.payindic IN ('L', 'T') THEN
                    CASE WHEN te.totamtpayable > 0 AND te.nmth > 0 THEN
                        CAST(te.totamtpayable AS DECIMAL(20,4)) - 
                        ((CAST(te.totamtpayable AS DECIMAL(20,4)) * 
                            LEAST(
                                CASE 
                                    WHEN FLOOR(be.noofmth / 22) >= 0 THEN FLOOR(be.noofmth / 22) + 1
                                    ELSE 1
                                END, 
                                te.nmth
                            ) / te.nmth) + CAST(te.hisvar AS DECIMAL(20,4)))
                    ELSE CAST(te.totamtpayable AS DECIMAL(20,4)) END
                
                ELSE 
                    CAST(te.totamtpayable AS DECIMAL(20,4))
            END
        AS DECIMAL(20,4)) as new_totpayable,

        -- New nmth
        CASE
            WHEN LEFT(te.his_type, 2) = 'PL' OR te.payindic IN ('L', 'T') THEN
                CASE WHEN te.nmth > 0 THEN
                    te.nmth - LEAST(
                        CASE 
                            WHEN FLOOR(be.noofmth / 22) >= 0 THEN FLOOR(be.noofmth / 22) + 1
                            ELSE 1
                        END, 
                        te.nmth
                    )
                ELSE te.nmth END
            ELSE te.nmth
        END as new_nmth,

        -- Loan balance
        CAST(
            CASE WHEN te.payindic = 'L' AND te.totpaidtodate = 0 
             THEN te.totamtpayable
             ELSE te.initialloan
            END
        AS DECIMAL(20,4)) as new_loan

    FROM tmp_elements te
    INNER JOIN tmp_batch_employees be 
        ON be.empl_id = te.empl_id
    LEFT JOIN tmp_element_meta em ON em.PaymentType = te.his_type;

    -- ========================================================================
    -- DSA FIX 2: Rank-Based Amounts (Grade cutoff 2200, not 2101)
    -- MUST happen BEFORE payment frequency check
    -- ========================================================================
    UPDATE tmp_calc tc
    INNER JOIN tmp_batch_employees be 
        ON be.empl_id COLLATE utf8mb4_unicode_ci = tc.empl_id COLLATE utf8mb4_unicode_ci
    INNER JOIN tmp_element_meta em 
        ON em.PaymentType COLLATE utf8mb4_unicode_ci = tc.his_type COLLATE utf8mb4_unicode_ci
    INNER JOIN py_payperrank pr ON pr.one_type = tc.his_type
    INNER JOIN tmp_elements te 
        ON te.empl_id COLLATE utf8mb4_unicode_ci = tc.empl_id COLLATE utf8mb4_unicode_ci
        AND te.his_type COLLATE utf8mb4_unicode_ci = tc.his_type COLLATE utf8mb4_unicode_ci
    SET tc.calc_amt = CASE 
        -- DSA: Check payindic='X' or totamtpayable=0, then zero
        WHEN te.payindic = 'X' THEN 0
        WHEN te.totamtpayable = 0 THEN 0
        -- Otherwise apply rank-based amount
        ELSE CASE LEFT(be.gradelevel, 2)
            WHEN '01' THEN COALESCE(pr.one_amount01, tc.calc_amt)
            WHEN '02' THEN COALESCE(pr.one_amount02, tc.calc_amt)
            WHEN '03' THEN COALESCE(pr.one_amount03, tc.calc_amt)
            WHEN '04' THEN COALESCE(pr.one_amount04, tc.calc_amt)
            WHEN '05' THEN COALESCE(pr.one_amount05, tc.calc_amt)
            WHEN '06' THEN COALESCE(pr.one_amount06, tc.calc_amt)
            WHEN '07' THEN COALESCE(pr.one_amount07, tc.calc_amt)
            WHEN '08' THEN COALESCE(pr.one_amount08, tc.calc_amt)
            WHEN '09' THEN COALESCE(pr.one_amount09, tc.calc_amt)
            WHEN '10' THEN COALESCE(pr.one_amount10, tc.calc_amt)
            WHEN '11' THEN COALESCE(pr.one_amount11, tc.calc_amt)
            WHEN '12' THEN COALESCE(pr.one_amount12, tc.calc_amt)
            WHEN '13' THEN COALESCE(pr.one_amount13, tc.calc_amt)
            WHEN '14' THEN COALESCE(pr.one_amount14, tc.calc_amt)
            WHEN '15' THEN COALESCE(pr.one_amount15, tc.calc_amt)
            WHEN '16' THEN COALESCE(pr.one_amount16, tc.calc_amt)
            WHEN '17' THEN COALESCE(pr.one_amount17, tc.calc_amt)
            WHEN '18' THEN COALESCE(pr.one_amount18, tc.calc_amt)
            WHEN '19' THEN COALESCE(pr.one_amount19, tc.calc_amt)
            WHEN '20' THEN COALESCE(pr.one_amount20, tc.calc_amt)
            WHEN '21' THEN COALESCE(pr.one_amount21, tc.calc_amt)
            WHEN '22' THEN COALESCE(pr.one_amount22, tc.calc_amt)
            ELSE tc.calc_amt
        END
    END
    WHERE em.perc = 'R' 
      AND be.gradelevel < '2200';  -- DSA: Changed from 2101 to 2200
      -- AND tc.his_type NOT IN ('PT306', 'PR302', 'PR307');  -- Exclude rent items

    -- ========================================================================
    -- DSA FIX 3: Percentage-Based Payments (perc='P')
    -- Calculate as percentage of dependent payment type
    -- ========================================================================
    
    -- Create a copy of tmp_calc for dependent lookups (to avoid "can't reopen table" error)
    DROP TEMPORARY TABLE IF EXISTS tmp_calc_depend;
    CREATE TEMPORARY TABLE tmp_calc_depend (
        empl_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        his_type VARCHAR(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        calc_amt DECIMAL(20,4),
        PRIMARY KEY (empl_id, his_type)
    ) ENGINE=INNODB;
    
    INSERT INTO tmp_calc_depend
    SELECT empl_id, his_type, calc_amt
    FROM tmp_calc;
    
    -- Now update using the copy
    UPDATE tmp_calc tc
    INNER JOIN tmp_batch_employees be 
        ON be.empl_id COLLATE utf8mb4_unicode_ci = tc.empl_id COLLATE utf8mb4_unicode_ci
    INNER JOIN tmp_element_meta em 
        ON em.PaymentType COLLATE utf8mb4_unicode_ci = tc.his_type COLLATE utf8mb4_unicode_ci
    INNER JOIN tmp_elements te 
        ON te.empl_id COLLATE utf8mb4_unicode_ci = tc.empl_id COLLATE utf8mb4_unicode_ci
        AND te.his_type COLLATE utf8mb4_unicode_ci = tc.his_type COLLATE utf8mb4_unicode_ci
    INNER JOIN tmp_calc_depend tcd
        ON tcd.empl_id COLLATE utf8mb4_unicode_ci = tc.empl_id COLLATE utf8mb4_unicode_ci
        AND tcd.his_type COLLATE utf8mb4_unicode_ci = em.dependence COLLATE utf8mb4_unicode_ci
    SET tc.calc_amt = CASE
        WHEN tcd.calc_amt != 0 THEN tcd.calc_amt * (em.std / 100)
        ELSE 0
    END
    WHERE em.perc = 'P'
      AND be.gradelevel < '2200'  -- DSA: Changed from 2101 to 2200
      AND te.totamtpayable > 0
      AND em.dependence IS NOT NULL
      AND em.dependence != '';
    
    -- Cleanup
    DROP TEMPORARY TABLE IF EXISTS tmp_calc_depend;


    -- Apply inactive status
    UPDATE tmp_calc tc
    INNER JOIN tmp_element_meta em ON em.PaymentType = tc.his_type
    SET tc.calc_amt = 0
    WHERE em.status = 'Inactive';

    -- ========================================================================
    -- DSA FIX: Payment Frequency (MUST BE LAST - After all other logic)
    -- ========================================================================
    -- This matches DSA legacy where frequency check happens at the END of each
    -- payment type's processing, after rank/percentage/rent/inactive logic
    
    -- Step 1: Zero out ALL non-monthly payments that are NOT in their payment month
    UPDATE tmp_calc tc
    INNER JOIN tmp_element_meta em 
        ON em.PaymentType COLLATE utf8mb4_unicode_ci = tc.his_type COLLATE utf8mb4_unicode_ci
    SET tc.calc_amt = 0
    WHERE em.payfreq IN ('H', 'Q', 'B', 'A')
      AND (em.pmonth IS NULL OR em.pmonth != v_month);

    -- Step 2: For payment months, apply multipliers (EXCEPT Q for DSA - factor is built in)
    UPDATE tmp_calc tc
    INNER JOIN tmp_element_meta em 
        ON em.PaymentType COLLATE utf8mb4_unicode_ci = tc.his_type COLLATE utf8mb4_unicode_ci
    SET tc.calc_amt = CASE 
        WHEN em.payfreq = 'H' THEN tc.calc_amt * 6   -- Half-yearly
        -- DSA: Q factor is built into base amount, so NO multiplication
        -- WHEN em.payfreq = 'Q' THEN tc.calc_amt * 3  -- COMMENTED OUT for DSA
        WHEN em.payfreq = 'B' THEN tc.calc_amt * 2   -- Bi-monthly
        WHEN em.payfreq = 'A' THEN tc.calc_amt * 12  -- Annual
        ELSE tc.calc_amt
    END
    WHERE em.payfreq IN ('H', 'B', 'A')  -- Note: Q excluded for DSA
      AND em.pmonth = v_month;

    -- ========================================================================
    -- DSA FIX 4: Exclusive Allowances (DSA has 3 sets, not 1)
    -- ========================================================================
    
    -- Create staging table
    DROP TEMPORARY TABLE IF EXISTS tmp_calc_L;
    CREATE TEMPORARY TABLE tmp_calc_L LIKE tmp_calc;
    INSERT INTO tmp_calc_L SELECT * FROM tmp_calc;

    DROP TEMPORARY TABLE IF EXISTS tmp_exclusive_check;
    CREATE TEMPORARY TABLE tmp_exclusive_check (
        empl_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        typeH VARCHAR(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        typeL VARCHAR(7) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        typeH_amt DECIMAL(20,4),
        typeL_amt DECIMAL(20,4),
        PRIMARY KEY (empl_id, typeH, typeL)
    ) ENGINE=INNODB;

    -- DSA Exclusive Set 1: PT365 vs PT366 (Departmental vs Incidental)
    INSERT INTO tmp_exclusive_check (empl_id, typeH, typeL, typeH_amt, typeL_amt)
    SELECT 
        tch.empl_id,
        tch.his_type AS typeH,
        tcl.his_type AS typeL,
        tch.calc_amt AS typeH_amt,
        tcl.calc_amt AS typeL_amt
    FROM tmp_calc tch
    INNER JOIN tmp_calc_L tcl 
        ON tcl.empl_id = tch.empl_id 
        AND tch.his_type IN ('PT365', 'PT366')
        AND tcl.his_type IN ('PT365', 'PT366')
        AND tch.his_type < tcl.his_type  -- Prefer lower type code
    WHERE tch.calc_amt > 0 AND tcl.calc_amt > 0;

    -- DSA Exclusive Set 2: PT349 vs PT350 vs PT359
    INSERT INTO tmp_exclusive_check (empl_id, typeH, typeL, typeH_amt, typeL_amt)
    SELECT 
        tch.empl_id,
        tch.his_type AS typeH,
        tcl.his_type AS typeL,
        tch.calc_amt AS typeH_amt,
        tcl.calc_amt AS typeL_amt
    FROM tmp_calc tch
    INNER JOIN tmp_calc_L tcl 
        ON tcl.empl_id = tch.empl_id 
        AND tch.his_type IN ('PT349', 'PT350', 'PT359')
        AND tcl.his_type IN ('PT349', 'PT350', 'PT359')
        AND tch.calc_amt >= tcl.calc_amt  -- Prefer higher amount
        AND tch.his_type != tcl.his_type
    WHERE tch.calc_amt > 0 AND tcl.calc_amt > 0;

    -- DSA Exclusive Set 3: PT327 vs PT369
    INSERT INTO tmp_exclusive_check (empl_id, typeH, typeL, typeH_amt, typeL_amt)
    SELECT 
        tch.empl_id,
        tch.his_type AS typeH,
        tcl.his_type AS typeL,
        tch.calc_amt AS typeH_amt,
        tcl.calc_amt AS typeL_amt
    FROM tmp_calc tch
    INNER JOIN tmp_calc_L tcl 
        ON tcl.empl_id = tch.empl_id 
        AND tch.his_type IN ('PT327', 'PT369')
        AND tcl.his_type IN ('PT327', 'PT369')
        AND tch.calc_amt >= tcl.calc_amt
        AND tch.his_type != tcl.his_type
    WHERE tch.calc_amt > 0 AND tcl.calc_amt > 0;

    -- Also check py_exclusiveType table (Navy approach)
    INSERT INTO tmp_exclusive_check (empl_id, typeH, typeL, typeH_amt, typeL_amt)
    SELECT 
        tch.empl_id,
        tch.his_type AS typeH,
        tcl.his_type AS typeL,
        tch.calc_amt AS typeH_amt,
        tcl.calc_amt AS typeL_amt
    FROM tmp_calc tch
    INNER JOIN py_exclusiveType ex ON ex.typeH = tch.his_type
    INNER JOIN tmp_calc_L tcl 
        ON tcl.empl_id = tch.empl_id 
        AND tcl.his_type = ex.typeL
    WHERE tch.calc_amt > 0 AND tcl.calc_amt > 0;

    -- Log conflicts
    INSERT INTO py_tempnsitf (empl_no, nsitf, emol, work_station)
    SELECT empl_id, typeH, typeL_amt, p_user
    FROM tmp_exclusive_check;

    -- Zero out lower priority items
    UPDATE tmp_calc tc
    INNER JOIN tmp_exclusive_check exc 
        ON exc.empl_id = tc.empl_id 
        AND exc.typeL = tc.his_type
    SET tc.calc_amt = 0;

    DROP TEMPORARY TABLE IF EXISTS tmp_exclusive_check;
    DROP TEMPORARY TABLE IF EXISTS tmp_calc_L;

    -- Add previous roundup (PU00)
    INSERT INTO tmp_calc (empl_id, his_type, calc_amt, new_totpaid, new_totpayable, new_nmth, new_loan)
    SELECT 
        pc.empl_id, 
        'PU00', 
        pc.roundup,
        0, 0, 0, 0
    FROM tmp_prev_cum pc
    WHERE pc.roundup <> 0
    ON DUPLICATE KEY UPDATE 
        calc_amt = VALUES(calc_amt);

    INSERT INTO py_masterpayded (
        his_empno, his_type,
        amtthismth, totamtpayable, totpaidtodate, his_balance,
        initialloan, hisvar, payindic, nmth,
        month1, month2, month3, month4, month5, month6,
        month7, month8, month9, month10, month11, month12,
        createdby, datecreated
    )
    SELECT 
        pc.empl_id,
        'PU00',
        0, 0, 0, 0,
        0, 0, '', 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        p_user, NOW()
    FROM tmp_prev_cum pc
    WHERE pc.roundup <> 0
      AND NOT EXISTS (
          SELECT 1 FROM py_masterpayded mp 
          WHERE mp.his_empno = pc.empl_id AND mp.his_type = 'PU00'
      );
      
    UPDATE tmp_calc tc
    INNER JOIN tmp_elements te 
        ON te.empl_id COLLATE utf8mb4_unicode_ci = tc.empl_id COLLATE utf8mb4_unicode_ci
        AND te.his_type COLLATE utf8mb4_unicode_ci = tc.his_type COLLATE utf8mb4_unicode_ci
    SET tc.new_totpaid = CAST(te.totpaidtodate AS DECIMAL(20,4)) + CAST(tc.calc_amt AS DECIMAL(20,4));

    -- Round amounts
    UPDATE tmp_calc
    SET calc_amt = ROUND(calc_amt, 2),
        new_totpaid = ROUND(new_totpaid, 2),
        new_totpayable = ROUND(new_totpayable, 2);

    -- ====================================
    -- 3D) UPDATE MASTER TABLES
    -- ====================================
    UPDATE py_masterpayded mp
    INNER JOIN tmp_calc tc ON tc.empl_id = mp.his_empno AND tc.his_type = mp.his_type
    SET mp.amtthismth = tc.calc_amt,
        mp.hisvar = 0,
        mp.totpaidtodate = tc.new_totpaid,
        mp.totamtpayable = CASE 
            WHEN mp.totamtpayable > 0 AND mp.totamtpayable <= 0.1 
            THEN mp.totamtpayable
            ELSE tc.new_totpayable
        END,
        mp.nmth = tc.new_nmth,
        mp.initialloan = tc.new_loan;

    -- ====================================
    -- 3E) CALCULATE TOTALS & TAX
    -- ====================================
    DROP TEMPORARY TABLE IF EXISTS tmp_totals;
     
    CREATE TEMPORARY TABLE tmp_totals (
        empl_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        paymth DECIMAL(20,4),
        frepay DECIMAL(20,4),
        dedble DECIMAL(20,4),
        notaxble DECIMAL(20,4),
        loanpaid DECIMAL(20,4),
        PRIMARY KEY (empl_id)
    ) ENGINE=INNODB;

    INSERT INTO tmp_totals
    SELECT 
        tc.empl_id,
        SUM(CASE WHEN LEFT(tc.his_type, 2) IN ('BP', 'BT') THEN tc.calc_amt ELSE 0 END),
        SUM(CASE WHEN LEFT(tc.his_type, 2) = 'FP' THEN tc.new_totpaid ELSE 0 END),
        SUM(CASE WHEN LEFT(tc.his_type, 2) = 'PR' THEN tc.calc_amt ELSE 0 END),
        SUM(CASE WHEN LEFT(tc.his_type, 2) = 'PT' THEN tc.calc_amt ELSE 0 END),
        SUM(CASE WHEN LEFT(tc.his_type, 2) = 'PL' THEN tc.calc_amt ELSE 0 END)
    FROM tmp_calc tc
    GROUP BY tc.empl_id;

    UPDATE tmp_totals tt
    INNER JOIN tmp_prev_cum pc ON pc.empl_id = tt.empl_id
    SET tt.notaxble = tt.notaxble + pc.roundup;

    -- Calculate tax
    DROP TEMPORARY TABLE IF EXISTS tmp_tax;
     
    CREATE TEMPORARY TABLE tmp_tax (
        empl_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        grosstodate DECIMAL(20,4),
        taxfreepay DECIMAL(20,4),
        taxable DECIMAL(20,4),
        taxtodate DECIMAL(20,4),
        taxmth DECIMAL(20,4),
        PRIMARY KEY (empl_id)
    ) ENGINE=INNODB;

    INSERT INTO tmp_tax
    SELECT 
        tt.empl_id,
        COALESCE(pc.grosstodate, 0) + tt.paymth,
        0, 0, 0, 0
    FROM tmp_totals tt
    LEFT JOIN tmp_prev_cum pc ON pc.empl_id = tt.empl_id;

    -- =================================================================
    -- PAYE - Nigeria Tax Act 2025 (2026 bands), monthly method  [DSS SETUP]
    -- * Only staff whose personnel record has Taxed = YES pay PAYE.
    -- * p_gtaxed = Company Profile > Independent Monthly Tax:
    --     'Yes' = calculate PAYE for taxed staff; anything else = no PAYE.
    -- * Monthly taxable pay = this month's BP + BT pay
    --     minus this month's tax-deductible deductions
    --     (PR elements with freetax > 0: PR310 pension, PR306 NHF).
    -- * PAYE = py_tax bands applied to (monthly taxable x 12), then / 12.
    -- =================================================================
    UPDATE tmp_tax tx
    LEFT JOIN tmp_prev_cum pc ON pc.empl_id = tx.empl_id
    SET tx.taxtodate  = COALESCE(pc.taxtodate, 0),
        tx.taxmth     = 0,
        tx.taxable    = 0,
        tx.taxfreepay = 0;

    IF p_gtaxed = 'Yes' THEN

        -- tax-deductible deductions this month (pension, NHF)
        UPDATE tmp_tax tx
        INNER JOIN tmp_batch_employees be ON be.empl_id = tx.empl_id
        SET tx.taxfreepay = COALESCE((
                SELECT SUM(tc.calc_amt)
                FROM tmp_calc tc
                INNER JOIN py_elementtype et
                        ON et.PaymentType COLLATE utf8mb4_unicode_ci = tc.his_type COLLATE utf8mb4_unicode_ci
                WHERE tc.empl_id = tx.empl_id
                  AND LEFT(tc.his_type, 2) = 'PR'
                  AND IFNULL(et.freetax, 0) > 0
            ), 0)
        WHERE UPPER(TRIM(IFNULL(be.taxed, ''))) IN ('YES', 'Y');

        -- taxable pay this month
        UPDATE tmp_tax tx
        INNER JOIN tmp_batch_employees be ON be.empl_id = tx.empl_id
        INNER JOIN tmp_totals tt ON tt.empl_id = tx.empl_id
        SET tx.taxable = GREATEST(0, tt.paymth - tx.taxfreepay)
        WHERE UPPER(TRIM(IFNULL(be.taxed, ''))) IN ('YES', 'Y');

        -- PAYE this month: annualise, apply bands, divide by 12
        UPDATE tmp_tax tx
        SET tx.taxmth = ROUND((
                SELECT COALESCE(SUM(
                    GREATEST(0, LEAST(tx.taxable * 12, t.cumval) - t.lowbound) * t.perc / 100
                ), 0)
                FROM py_tax t
                WHERE t.INTER <> '999'
            ) / 12, 2)
        WHERE tx.taxable > 0;

        -- tax to date = last month's tax to date + this month's PAYE
        UPDATE tmp_tax tx
        LEFT JOIN tmp_prev_cum pc ON pc.empl_id = tx.empl_id
        SET tx.taxtodate = COALESCE(pc.taxtodate, 0) + tx.taxmth;

        -- keep the "to date" taxable and tax-free columns cumulative
        UPDATE tmp_tax tx
        INNER JOIN tmp_batch_employees be ON be.empl_id = tx.empl_id
        LEFT JOIN py_mastercum mc
               ON mc.his_Empno COLLATE utf8mb4_unicode_ci = tx.empl_id COLLATE utf8mb4_unicode_ci
              AND mc.his_type = v_prev_month
        SET tx.taxable    = COALESCE(mc.his_taxabletodate, 0) + tx.taxable,
            tx.taxfreepay = COALESCE(mc.his_taxfreepaytodate, 0) + tx.taxfreepay
        WHERE UPPER(TRIM(IFNULL(be.taxed, ''))) IN ('YES', 'Y');
    END IF;

    -- Calculate net pay
    DROP TEMPORARY TABLE IF EXISTS tmp_net;
     
    CREATE TEMPORARY TABLE tmp_net (
        empl_id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        netpay DECIMAL(20,4),
        netdiff INT,
        roundup DECIMAL(20,4),
        PRIMARY KEY (empl_id)
    ) ENGINE=INNODB;

    INSERT INTO tmp_net
    SELECT 
        tt.empl_id,
        ROUND(tt.paymth - tx.taxmth - tt.dedble + tt.notaxble - tt.loanpaid, 2),
        0, 0
    FROM tmp_totals tt
    INNER JOIN tmp_tax tx ON tx.empl_id = tt.empl_id;

    UPDATE tmp_net tn
    INNER JOIN tmp_prev_cum pc ON pc.empl_id = tn.empl_id
    SET tn.netdiff = CASE 
        WHEN pc.netmth > 0 THEN 
            FLOOR(100 * (tn.netpay - pc.netmth) / pc.netmth)
        ELSE 0
    END
    WHERE pc.netmth > 0;

    UPDATE tmp_net
    SET roundup = CASE WHEN netdiff > v_perdiff THEN netdiff ELSE 0 END;

    -- ====================================
    -- 3F) UPDATE CUMULATIVE TABLE
    -- ====================================
    INSERT INTO py_mastercum (
        his_empno, his_type, 
        his_over, his_taxtodate, his_taxmth, his_taxabletodate, his_taxfreepaytodate,
        his_grosstodate, his_grossmth, his_nettodate, his_netmth, his_lastpay,
        createdby, datecreated
    )
    SELECT 
        tt.empl_id, v_month,
        tn.roundup, tx.taxtodate, tx.taxmth, tx.taxable, tx.taxfreepay,
        tx.grosstodate, tt.paymth,
        COALESCE(pc.nettodate, 0) + tn.netpay, tn.netpay, v_month,
        p_user, NOW()
    FROM tmp_totals tt
    INNER JOIN tmp_tax tx ON tx.empl_id = tt.empl_id
    INNER JOIN tmp_net tn ON tn.empl_id = tt.empl_id
    LEFT JOIN tmp_prev_cum pc ON pc.empl_id = tt.empl_id
    ON DUPLICATE KEY UPDATE
        his_over = VALUES(his_over),
        his_taxtodate = VALUES(his_taxtodate),
        his_taxmth = VALUES(his_taxmth),
        his_taxabletodate = VALUES(his_taxabletodate),
        his_taxfreepaytodate = VALUES(his_taxfreepaytodate),
        his_grosstodate = VALUES(his_grosstodate),
        his_grossmth = VALUES(his_grossmth),
        his_nettodate = VALUES(his_nettodate),
        his_netmth = VALUES(his_netmth),
        his_lastpay = VALUES(his_lastpay),
        datecreated = NOW();

    -- ====================================
    -- 3G) CLEANUP & CONTINUE
    -- ====================================
    SET v_processed = v_processed + v_batch_count;
    SET v_offset = v_offset + p_batch_size;

    DROP TEMPORARY TABLE IF EXISTS tmp_batch_employees;
    DROP TEMPORARY TABLE IF EXISTS tmp_elements;
    DROP TEMPORARY TABLE IF EXISTS tmp_element_meta;
    DROP TEMPORARY TABLE IF EXISTS tmp_prev_cum;
    DROP TEMPORARY TABLE IF EXISTS tmp_calc;
    DROP TEMPORARY TABLE IF EXISTS tmp_totals;
    DROP TEMPORARY TABLE IF EXISTS tmp_tax;
    DROP TEMPORARY TABLE IF EXISTS tmp_net;

    IF MOD(v_processed, (p_batch_size * 10)) = 0 THEN
        COMMIT;
        START TRANSACTION;
    END IF;

END WHILE batch_loop;

-- =====================================
-- 4) UPDATE PAYMENT FREQUENCY (Same as Navy and DSA)
-- =====================================
UPDATE py_elementType et
SET et.pmonth = CASE
    WHEN et.payfreq = 'H' AND et.pmonth = v_month THEN 
        CASE WHEN v_month + 6 > 12 THEN v_month + 6 - 12 ELSE v_month + 6 END
    WHEN et.payfreq = 'Q' AND et.pmonth = v_month THEN 
        CASE WHEN v_month + 3 > 12 THEN v_month + 3 - 12 ELSE v_month + 3 END
    WHEN et.payfreq = 'B' AND et.pmonth = v_month THEN 
        CASE WHEN v_month + 2 > 12 THEN v_month + 2 - 12 ELSE v_month + 2 END
    WHEN et.payfreq = 'A' AND et.pmonth = v_month THEN
        CASE WHEN v_month + 12 > 12 THEN v_month ELSE v_month END
    ELSE et.pmonth
END
WHERE et.payfreq IN ('H', 'Q', 'B', 'A') AND et.pmonth = v_month;

-- =====================================
-- 5) FINALIZE
-- =====================================
INSERT INTO py_process_control (process_year, process_month, status, phase, started_by, started_date)
VALUES (v_year, v_month, 'CALCULATED', 'CALCULATION', p_user, NOW())
ON DUPLICATE KEY UPDATE 
    status='CALCULATED', 
    phase='CALCULATION', 
    started_by=p_user, 
    started_date=NOW(),
    error_message=NULL;

SET v_exec_time = TIMESTAMPDIFF(MICROSECOND, v_start, NOW())/1000;

INSERT INTO py_performance_log (
    procedure_name, process_year, process_month, 
    records_processed, execution_time_ms, 
    started_at, completed_at, status
)
VALUES (
    'sp_calculate_01_complete_optimized', 
    v_year, v_month, v_processed,
    v_exec_time, v_start, NOW(), 'SUCCESS'
);

COMMIT;

-- =====================================
-- 6) RETURN SUMMARY
-- =====================================
SELECT 
    'SUCCESS' AS status,
    v_processed AS employees_processed,
    v_year AS process_year,
    v_month AS process_month,
    TIMESTAMPDIFF(SECOND, v_start, NOW()) AS time_seconds,
    ROUND(v_processed / GREATEST(TIMESTAMPDIFF(SECOND, v_start, NOW()), 1), 2) AS employees_per_second;

END proc_end$$
DELIMITER ;


-- =====================================================================
-- PART 10: CHECKS - run AFTER Master File Update + Payroll Calculation
--          (civilian class) and share the results.
-- =====================================================================

-- 10a. DSS staff by grade/step: one line per grade (amounts per person)
SELECT LEFT(w.gradelevel, 2)          AS grade,
       RIGHT(w.gradelevel, 2)         AS step,
       COUNT(*)                       AS staff,
       ROUND(AVG(p.bp303), 2)         AS consolidated,
       ROUND(AVG(p.bt301), 2)         AS dss_allowance,
       ROUND(AVG(c.his_grossmth), 2)  AS taxable_gross,
       ROUND(AVG(p.pr306), 2)         AS nhf,
       ROUND(AVG(p.pr310), 2)         AS pension,
       ROUND(AVG(c.his_taxmth), 2)    AS paye,
       ROUND(AVG(p.pt302), 2)         AS research_admin_allce,
       ROUND(AVG(c.his_netmth), 2)    AS net_pay
FROM dsa_hicaddata1.py_dss_staff d
INNER JOIN dsa_hicaddata1.py_wkemployees w ON w.Empl_ID = d.empl_id
LEFT JOIN (
    SELECT his_Empno,
           SUM(CASE WHEN his_type = 'BP303' THEN amtthismth ELSE 0 END) AS bp303,
           SUM(CASE WHEN his_type = 'BT301' THEN amtthismth ELSE 0 END) AS bt301,
           SUM(CASE WHEN his_type = 'PR306' THEN amtthismth ELSE 0 END) AS pr306,
           SUM(CASE WHEN his_type = 'PR310' THEN amtthismth ELSE 0 END) AS pr310,
           SUM(CASE WHEN his_type = 'PT302' THEN amtthismth ELSE 0 END) AS pt302
    FROM dsa_hicaddata1.py_masterpayded
    GROUP BY his_Empno
) p ON p.his_Empno = d.empl_id
LEFT JOIN dsa_hicaddata1.py_mastercum c
       ON c.his_Empno = d.empl_id
      AND c.his_type = (SELECT mth FROM dsa_hicaddata1.py_stdrate WHERE type = 'BT05' LIMIT 1)
GROUP BY LEFT(w.gradelevel, 2), RIGHT(w.gradelevel, 2)
ORDER BY grade, step;

-- 10b. Civilian totals for the month: DSS vs everyone else
SELECT CASE WHEN d.empl_id IS NULL THEN 'OTHER CIVILIANS' ELSE 'DSS' END AS staff_group,
       COUNT(*)                     AS staff,
       ROUND(SUM(c.his_grossmth), 2) AS taxable_gross,
       ROUND(SUM(c.his_taxmth), 2)   AS paye,
       ROUND(SUM(c.his_netmth), 2)   AS net_pay
FROM dsa_hicaddata1.py_mastercum c
LEFT JOIN dsa_hicaddata1.py_dss_staff d ON d.empl_id = c.his_Empno
WHERE c.his_type = (SELECT mth FROM dsa_hicaddata1.py_stdrate WHERE type = 'BT05' LIMIT 1)
GROUP BY staff_group;

-- 10c. DSS staff with no consolidated pay or no PAYE (should be none)
SELECT d.empl_id, w.gradelevel, w.gradetype, w.taxed, p.bp303, c.his_taxmth
FROM dsa_hicaddata1.py_dss_staff d
LEFT JOIN dsa_hicaddata1.py_wkemployees w ON w.Empl_ID = d.empl_id
LEFT JOIN (
    SELECT his_Empno, SUM(CASE WHEN his_type = 'BP303' THEN amtthismth ELSE 0 END) AS bp303
    FROM dsa_hicaddata1.py_masterpayded GROUP BY his_Empno
) p ON p.his_Empno = d.empl_id
LEFT JOIN dsa_hicaddata1.py_mastercum c
       ON c.his_Empno = d.empl_id
      AND c.his_type = (SELECT mth FROM dsa_hicaddata1.py_stdrate WHERE type = 'BT05' LIMIT 1)
WHERE IFNULL(p.bp303, 0) = 0 OR IFNULL(c.his_taxmth, 0) = 0;

-- 10d. Errors logged by the last runs (should be none)
SELECT procedure_name, status, started_at, error_details
FROM dsa_hicaddata1.py_performance_log
WHERE status = 'FAILED'
  AND started_at >= CURDATE()
ORDER BY started_at DESC;
