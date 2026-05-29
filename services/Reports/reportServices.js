const pool = require('../../config/db');

class ReportService {

  async _getPeriod(year, month) {
    // If explicit year+month supplied, use them directly — no DB round-trip needed
    if (year && month) {
      return { year: String(year), month: String(month) };
    }
 
    const [rows] = await pool.query(
      `SELECT ord AS year, mth AS month FROM py_stdrate WHERE type = 'BT05' LIMIT 1`
    );
    if (!rows || rows.length === 0) {
      throw new Error("Current period (BT05) not found in py_stdrate");
    }
    return { year: String(rows[0].year), month: String(rows[0].month) };
  }
  
  // REPORT 1: PAY SLIPS (USES payslipGenerationService)

  // ========================================================================
  // REPORT 2: PAYMENTS BY BANK (BRANCH)
  // ========================================================================
  async getPaymentsByBank(filters = {}) {
    const { year, month, bankName, summaryOnly, allClasses, specificClass } = filters;
    
    // Determine which databases to query
    let databasesToQuery = [];
    const currentDb = pool.getCurrentDatabase();
    const masterDb = pool.getMasterDb();
    
    if (allClasses === 'true' || allClasses === true) {
      // Only allow all classes if current database is the master/officers database
      if (currentDb !== masterDb) {
        throw new Error('All classes report can only be generated from the Officers database');
      }
      
      // If specific class is selected, use only that class
      if (specificClass) {
        const targetDb = pool.getDatabaseFromPayrollClass(specificClass);
        if (!targetDb) {
          throw new Error(`Invalid payroll class: ${specificClass}`);
        }
        databasesToQuery = [{ name: specificClass, db: targetDb }];
      } else {
        // Database to class name mapping
        const dbToClassMap = await this.getDbToClassMap();

        // Get all available databases including the current one
        const dbConfig = require('../../config/db-config').getConfigSync();
        databasesToQuery = Object.entries(dbConfig.databases)
          .map(([className, dbName]) => ({ 
            name: dbToClassMap[dbName] || className, // Use mapped name or fallback to original
            db: dbName 
          }));
      }
    } else {
      // Single database query - current session database
      databasesToQuery = [{ name: 'current', db: currentDb }];
    }
    
    const allResults = [];
    const failedClasses = [];
    
    for (const { name, db } of databasesToQuery) {
      // Temporarily switch to the target database
      const originalDb = pool.getCurrentDatabase();
      
      try {
        pool.useDatabase(db);
      } catch (dbError) {
        console.warn(`⚠️ Skipping ${name} (${db}): ${dbError.message}`);
        failedClasses.push({ class: name, database: db, error: dbError.message });
        continue;
      }
      
      try {
        if (summaryOnly === 'true' || summaryOnly === true) {
          // Summary query - aggregated data
          const query = `
            SELECT 
              sr.ord as year,
              sr.mth as month,
              we.Bankcode,
              we.bankbranch,
              bnk.branchname as bank_branch_name,
              COUNT(DISTINCT we.empl_id) as employee_count,
              ROUND(SUM(mc.his_netmth), 2) as total_net
            FROM py_wkemployees we
            CROSS JOIN (SELECT ord, mth FROM py_stdrate WHERE type = 'BT05') sr
            INNER JOIN py_mastercum mc ON mc.his_empno = we.empl_id AND mc.his_type = sr.mth
            LEFT JOIN py_bank bnk ON bnk.bankcode = we.Bankcode AND bnk.branchcode = LPAD(we.bankbranch, 3, '0')
            WHERE 1=1
              ${year ? 'AND sr.ord = ?' : ''}
              ${month ? 'AND sr.mth = ?' : ''}
              ${bankName ? 'AND we.Bankcode = ?' : ''}
            GROUP BY sr.ord, sr.mth, we.Bankcode, we.bankbranch, bnk.branchname
            ORDER BY we.Bankcode, we.bankbranch
          `;
          
          const params = [];
          if (year) params.push(year);
          if (month) params.push(month);
          if (bankName) params.push(bankName);
          
          const [rows] = await pool.query(query, params);
          
          // Add class identifier to each row
          allResults.push({
            payrollClass: name,
            database: db,
            data: rows
          });
          
        } else {
          // Detailed query - individual employee records
          const query = `
            SELECT 
                sr.ord as year,
                sr.mth as month,
                we.Bankcode,
                we.bankbranch,
                we.empl_id,
                we.Title as Title,
                CONCAT(we.Surname, ' ', we.OtherName) as fullname,
                tt.Description as title,
                we.BankACNumber,
                bnk.branchname as bank_branch_name,
                ROUND(mc.his_netmth, 2) as total_net
            FROM py_wkemployees we
            CROSS JOIN (SELECT ord, mth FROM py_stdrate WHERE type = 'BT05') sr
            INNER JOIN py_mastercum mc ON mc.his_empno = we.empl_id AND mc.his_type = sr.mth
            LEFT JOIN py_bank bnk ON bnk.bankcode = we.Bankcode AND bnk.branchcode = LPAD(we.bankbranch, 3, '0')
            LEFT JOIN py_Title tt ON tt.Titlecode = we.Title
            WHERE 1=1
              ${year ? 'AND sr.ord = ?' : ''}
              ${month ? 'AND sr.mth = ?' : ''}
              ${bankName ? 'AND we.Bankcode = ?' : ''}
            ORDER BY we.Bankcode, we.bankbranch, we.empl_id
          `;
          
          const params = [];
          if (year) params.push(year);
          if (month) params.push(month);
          if (bankName) params.push(bankName);
          
          const [rows] = await pool.query(query, params);
          
          // Add class identifier to each row
          allResults.push({
            payrollClass: name,
            database: db,
            data: rows
          });
        }
      } catch (queryError) {
        console.error(`❌ Query error for ${name} (${db}):`, queryError.message);
        failedClasses.push({ class: name, database: db, error: queryError.message });
      } finally {
        // Restore original database context
        try {
          pool.useDatabase(originalDb);
        } catch (restoreError) {
          console.warn(`⚠️ Could not restore database context: ${restoreError.message}`);
        }
      }
    }
    
    // Return results based on whether it's a multi-class query
    if (allClasses === 'true' || allClasses === true) {
      const result = { 
        data: allResults,
        summary: {
          total: databasesToQuery.length,
          successful: allResults.length,
          failed: failedClasses.length
        }
      };
      
      if (failedClasses.length > 0) {
        result.failedClasses = failedClasses;
        console.warn(`⚠️ ${failedClasses.length} class(es) failed:`, failedClasses);
      }
      
      return result;
    } else {
      return allResults[0]?.data || [];
    }
  }

  // ========================================================================
  // REPORT 3: ANALYSIS OF EARNINGS/DEDUCTIONS
  // ========================================================================
  async getEarningsDeductionsAnalysis(filters = {}) {
    const { year, month, paymentType, summaryOnly } = filters;
    const isSummary = summaryOnly === true || summaryOnly === "1" || summaryOnly === "true";
    const period    = await this._getPeriod(year, month);
 
    const params = [];
    if (paymentType) params.push(paymentType);
 
    let query;
 
    // Category expression uses range comparisons instead of LEFT() so MySQL
    // can use a range scan on the his_type index rather than a full scan.
    // e.g. his_type >= 'BP' AND his_type < 'BQ' covers all BP* codes without
    // calling LEFT() on every row.
    const categoryCaseExpr = `
          CASE
            WHEN mp.his_type >= 'BP' AND mp.his_type < 'BQ' THEN 'Earnings'
            WHEN mp.his_type >= 'BT' AND mp.his_type < 'BU' THEN 'Earnings'
            WHEN mp.his_type >= 'FP' AND mp.his_type < 'FQ' THEN 'Tax-Free Allowance'
            WHEN mp.his_type >= 'PT' AND mp.his_type < 'PU' THEN 'Non-Taxable Allowance'
            WHEN mp.his_type >= 'PR' AND mp.his_type < 'PS' THEN 'Deductions'
            WHEN mp.his_type >= 'PL' AND mp.his_type < 'PM' THEN 'Loan'
            ELSE 'Other'
          END`;
 
    if (isSummary) {
      query = `
        SELECT
          '${period.year}'  AS year,
          '${period.month}' AS month,
          mp.his_type        AS payment_code,
          et.elmDesc         AS payment_description,
          ${categoryCaseExpr} AS category,
          COUNT(DISTINCT mp.his_empno)   AS employee_count,
          ROUND(SUM(mp.amtthismth), 2)   AS total_amount
        FROM py_masterpayded mp
        LEFT JOIN py_elementType et ON et.PaymentType = mp.his_type
        WHERE mp.amtthismth != 0
          ${paymentType ? "AND mp.his_type = ?" : ""}
        GROUP BY mp.his_type, et.elmDesc
        ORDER BY category, mp.his_type`;
    } else {
      query = `
        SELECT
          '${period.year}'  AS year,
          '${period.month}' AS month,
          mp.his_type        AS payment_code,
          et.elmDesc         AS payment_description,
          ${categoryCaseExpr} AS category,
          mp.his_empno,
          CONCAT(TRIM(we.Surname), ' ', TRIM(we.OtherName))      AS fullname,
          we.Title,
          tt.Description                                          AS title,
          ROUND(SUM(mp.amtthismth), 2)                           AS total_amount
        FROM py_masterpayded mp
        LEFT JOIN py_wkemployees we ON we.empl_id = mp.his_empno
        LEFT JOIN py_elementType et ON et.PaymentType = mp.his_type
        LEFT JOIN py_Title tt       ON tt.Titlecode   = we.Title
        WHERE mp.amtthismth != 0
          ${paymentType ? "AND mp.his_type = ?" : ""}
        GROUP BY mp.his_type, et.elmDesc, mp.his_empno,
                 we.Surname, we.OtherName, we.Title, tt.Description
        ORDER BY category, mp.his_type, mp.his_empno`;
    }
 
    const [rows] = await pool.query(query, params);
    return rows;
  }

  // ========================================================================
  // REPORT 4: LOAN ANALYSIS
  // ========================================================================
  async getLoanAnalysis(filters = {}) {
    const { year, month} = filters;

    const query = `
      SELECT 
        mp.his_empno as employee_id,
        CONCAT(we.Surname, ' ', we.OtherName) as fullname,
        we.Location,
        we.Title as Title,
        tt.Description as title,
        mp.his_type as loan_type,
        et.elmDesc as loan_description,
        ROUND(mp.totamtpayable, 2) as original_loan,
        ROUND(mp.amtthismth, 2) as this_month_payment,
        mp.nmth as months_remaining
      FROM py_masterpayded mp
      CROSS JOIN (SELECT ord, mth FROM py_stdrate WHERE type = 'BT05') sr
      INNER JOIN py_wkemployees we ON we.empl_id = mp.his_empno
      LEFT JOIN py_elementType et ON et.PaymentType = mp.his_type
      LEFT JOIN py_Title tt ON tt.Titlecode = we.Title
      WHERE (
          LEFT(mp.his_type, 2) = 'PL'
          -- OR (LEFT(mp.his_type, 2) = 'PR' AND mp.payindic = 'T')
        )
        AND (mp.amtthismth > 0)
        ${year ? `AND sr.ord = ?` : ''}
        ${month ? `AND sr.mth = ?` : ''}
      ORDER BY mp.his_type, et.elmDesc, mp.his_empno
    `;

    const params = [];
    if (year) params.push(year);
    if (month) params.push(month);
    
    const [rows] = await pool.query(query, params);
    
    // Group by loan_type and loan_description
    const grouped = {};
    
    rows.forEach(row => {
      const key = `${row.loan_type}|${row.loan_description}`;
      if (!grouped[key]) {
        grouped[key] = {
          loan_type: row.loan_type,
          loan_description: row.loan_description,
          loans: [],
          totals: {
            original_loan: 0,
            this_month_payment: 0,
            count: 0
          }
        };
      }
      
      grouped[key].loans.push(row);
      grouped[key].totals.original_loan += parseFloat(row.original_loan) || 0;
      grouped[key].totals.this_month_payment += parseFloat(row.this_month_payment) || 0;
      grouped[key].totals.count += 1;
    });
    
    return Object.values(grouped);
  }

  // ========================================================================
  // REPORT 5: ANALYSIS OF PAYMENTS/DEDUCTIONS BY BANK
  // ========================================================================
  async getPaymentsDeductionsByBank(filters = {}) {
    const { year, month, bankName, paymentType, summaryOnly } = filters;
    
    // Convert summaryOnly to boolean if it's a string
    const isSummary = summaryOnly === true || summaryOnly === '1' || summaryOnly === 'true';
    
    const query = `
      SELECT 
        sr.ord as year,
        sr.mth as month,
        we.Bankcode,
        we.bankbranch,
        bnk.branchname as bank_branch_name,
        mp.his_type as payment_code,
        et.elmDesc as payment_description,
        CASE 
          WHEN LEFT(mp.his_type, 2) IN ('BP', 'BT') THEN 'Earnings'
          WHEN LEFT(mp.his_type, 2) = 'FP' THEN 'Tax-Free Allowance'
          WHEN LEFT(mp.his_type, 2) = 'PT' THEN 'Non-Taxable Allowance'
          WHEN LEFT(mp.his_type, 2) = 'PR' THEN 'Deductions'
          WHEN LEFT(mp.his_type, 2) = 'PL' THEN 'Loan'
          ELSE 'Other'
        END as category,
        ${!isSummary ? `mp.his_empno,
        we.Surname,
        we.Title as Title,
        CONCAT(we.Surname, ' ', we.OtherName) as fullname,
        tt.Description as title,` : ''}
        ${isSummary ? 'COUNT(DISTINCT mp.his_empno) as employee_count,' : ''}
        ROUND(SUM(mp.amtthismth), 2) as total_amount
      FROM py_masterpayded mp
      CROSS JOIN (SELECT ord, mth FROM py_stdrate WHERE type = 'BT05') sr
      INNER JOIN py_wkemployees we ON we.empl_id = mp.his_empno
      LEFT JOIN py_elementType et ON et.PaymentType = mp.his_type
      LEFT JOIN py_bank bnk ON bnk.bankcode = we.Bankcode AND bnk.branchcode = LPAD(we.bankbranch, 3, '0')
      LEFT JOIN py_Title tt ON tt.Titlecode = we.Title
      WHERE mp.amtthismth != 0
        ${year ? 'AND sr.ord = ?' : ''}
        ${month ? 'AND sr.mth = ?' : ''}
        ${bankName ? 'AND we.Bankcode = ?' : ''}
        ${paymentType ? 'AND mp.his_type = ?' : ''}
      GROUP BY sr.ord, sr.mth, we.Bankcode, we.bankbranch, bnk.branchname, mp.his_type, et.elmDesc, mp.his_empno, we.Surname, we.OtherName, we.Title, tt.Description
        ${!isSummary ? ', mp.his_empno, we.Surname, we.Title, tt.Description' : ''}
      ORDER BY we.Bankcode, we.bankbranch, category, mp.his_type${!isSummary ? ', mp.his_empno' : ''}
    `;
    
    const params = [];
    if (year) params.push(year);
    if (month) params.push(month);
    if (bankName) params.push(bankName);
    if (paymentType) params.push(paymentType);
    
    const [rows] = await pool.query(query, params);
    return rows;
  }

  // ========================================================================
  // HELPER: Get Current Period
  // ========================================================================
  async getCurrentPeriod() {
    const query = `
      SELECT ord as year, mth as month, pmth as prev_month
      FROM py_stdrate 
      WHERE type = 'BT05'
      LIMIT 1
    `;
    const [rows] = await pool.query(query);
    return rows[0];
  }

  // ========================================================================
  // HELPER: Get available Banks
  // ========================================================================
  async getAvailableBanks() {
    const query = `
      SELECT DISTINCT we.Bankcode, we.bankbranch, bnk.branchname
      FROM py_wkemployees we
      LEFT JOIN py_bank bnk ON bnk.bankcode = we.Bankcode 
                            AND bnk.branchcode = LPAD(we.bankbranch, 3, '0')
      ORDER BY we.Bankcode, we.bankbranch
    `;
    const [rows] = await pool.query(query);
    return rows;
  }

  async getDbToClassMap() {
    const masterDb = pool.getMasterDb();
    pool.useDatabase(masterDb);
    const [dbClasses] = await pool.query('SELECT db_name, classname FROM py_payrollclass');
    
    const dbToClassMap = {};
    dbClasses.forEach(row => {
      dbToClassMap[row.db_name] = row.classname;
    });
    
    return dbToClassMap;
  }
}

module.exports = new ReportService();