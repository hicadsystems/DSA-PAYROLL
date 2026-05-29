const pool = require("../../config/db");

class ReconciliationService {
  getMonthName(monthNum) {
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    return months[parseInt(monthNum) - 1] || monthNum;
  }

  /**
   * Extracts the 2-digit month string from either "YYYYMM" or "MM" format.
   */
  _parseMonth(month) {
    if (month && String(month).length === 6) {
      return String(month).substring(4, 6);
    }
    return month;
  }

  /**
   * Get overall salary reconciliation summary.
   *
   * FIX: The py_masterpayded subquery is now scoped to the requested month/year
   * by joining through py_mastercum. Previously it aggregated all-time records,
   * causing earnings and deductions to cancel each other out and always produce
   * a false 0.00 variance.
   */
  async getSalaryReconciliationSummary(filters = {}) {
    const { year, month, database } = filters;
    const useDb = database || process.env.DB_OFFICERS;
    const monthOnly = this._parseMonth(month);

    console.log(
      `📊 Summary for year: ${year}, month: ${monthOnly} in database: ${useDb}`,
    );

    // Guard: confirm payroll calculation is complete for the period
    if (monthOnly) {
      const checkQuery = `
        SELECT ord as year, mth as month, sun
        FROM \`${useDb}\`.py_stdrate
        WHERE type = 'BT05'
          AND mth = ?
          ${year ? "AND ord = ?" : ""}
        ORDER BY ord DESC
        LIMIT 1
      `;
      const params = year ? [monthOnly, year] : [monthOnly];
      const [checkRows] = await pool.query(checkQuery, params);

      if (!checkRows || checkRows.length === 0) {
        const monthName = this.getMonthName(monthOnly);
        throw new Error(
          `No payroll data found for ${monthName}${year ? `, ${year}` : ""}.`,
        );
      }

      if (checkRows[0].sun != 999) {
        const monthName = this.getMonthName(monthOnly);
        throw new Error(
          `Calculation not completed for ${monthName}, ${checkRows[0].year}. ` +
            `Please complete payroll calculation before generating reports for ${monthName}, ${checkRows[0].year}.`,
        );
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // KEY FIX: py_masterpayded is joined through py_mastercum so it is
    // automatically scoped to employees who have a cumulative record for this
    // exact month.  The previous version had a free-standing GROUP BY that
    // accumulated every historical row, making detail_earnings and
    // detail_deductions artificially large — and their difference always ~0.
    // ─────────────────────────────────────────────────────────────────────────
    const query = `
      SELECT
        sr.ord  AS year,
        sr.mth  AS month,

        ROUND(COALESCE(SUM(mc.his_grossmth), 0), 2) AS total_gross,
        ROUND(COALESCE(SUM(mc.his_taxmth),   0), 2) AS total_tax,
        ROUND(COALESCE(SUM(mc.his_netmth),   0), 2) AS total_net,
        ROUND(COALESCE(SUM(mc.his_roundup),  0), 2) AS total_roundup,

        ROUND(COALESCE(SUM(mpd.detail_earnings),   0), 2) AS detail_earnings,
        ROUND(COALESCE(SUM(mpd.detail_deductions), 0), 2) AS detail_deductions,

        ROUND(
          COALESCE(SUM(mpd.detail_earnings),   0)
          - COALESCE(SUM(mpd.detail_deductions), 0)
          + COALESCE(SUM(mc.his_roundup),  0)
          - COALESCE(SUM(mc.his_netmth),   0)
          - COALESCE(SUM(mc.his_taxmth),   0)
        , 2) AS calculated_variance,

        COUNT(DISTINCT mc.his_empno) AS total_employees

      FROM \`${useDb}\`.py_stdrate sr

      INNER JOIN \`${useDb}\`.py_mastercum mc
        ON  mc.his_type = sr.mth

      /* ── FIXED subquery: scoped to employees in py_mastercum for this period ── */
      LEFT JOIN (
        SELECT
          mpd_inner.his_empno,
          SUM(CASE WHEN LEFT(mpd_inner.his_type, 2) IN ('BP','BT','PT','PU')
                   THEN mpd_inner.amtthismth ELSE 0 END) AS detail_earnings,
          SUM(CASE WHEN LEFT(mpd_inner.his_type, 2) IN ('PR','PL')
                   THEN mpd_inner.amtthismth ELSE 0 END) AS detail_deductions
        FROM \`${useDb}\`.py_masterpayded mpd_inner
        /* Join back to py_mastercum so we only include rows for this month/year */
        INNER JOIN \`${useDb}\`.py_mastercum mc_scope
          ON  mc_scope.his_empno = mpd_inner.his_empno
          AND mc_scope.his_type  = ?          -- monthOnly (param 1)
        GROUP BY mpd_inner.his_empno
      ) mpd ON mpd.his_empno = mc.his_empno

      WHERE sr.type = 'BT05'
        AND sr.ord  = ?                       -- year      (param 2)
        AND sr.mth  = ?                       -- monthOnly (param 3)

      GROUP BY sr.ord, sr.mth
    `;

    const [rows] = await pool.query(query, [monthOnly, year, monthOnly]);
    console.log(`📊 Summary result:`, rows);

    return rows.map((row) => ({
      ...row,
      status:
        Math.abs(row.calculated_variance || 0) < 0.01
          ? "BALANCED"
          : "VARIANCE DETECTED",
      variance_threshold: 0.01,
      has_variance: Math.abs(row.calculated_variance || 0) >= 0.01,
    }));
  }

  /**
   * Get detailed employee-level reconciliation.
   * Only called when a real variance is detected at the summary level.
   */
  async getEmployeeReconciliation(filters = {}) {
    const {
      year,
      month,
      database,
      showErrorsOnly = true,
      employeeId = null,
    } = filters;
    const useDb = database || process.env.DB_OFFICERS;
    const monthOnly = this._parseMonth(month);

    console.log(
      `🔍 Reconciliation for year: ${year}, month: ${monthOnly} in database: ${useDb}`,
    );

    let employeeFilter = "";
    const queryParams = [];
    if (employeeId) {
      employeeFilter = "AND e.Empl_ID = ?";
      queryParams.push(employeeId);
    }

    const employeesQuery = `
      SELECT DISTINCT
        e.Empl_ID,
        CONCAT(e.Surname, ' ', COALESCE(e.OtherName, '')) AS employee_name,
        e.Title,
        ttl.Description AS title_description
      FROM hr_employees e
      LEFT JOIN py_Title ttl ON ttl.TitleCode = e.Title
      WHERE (e.DateLeft IS NULL OR e.DateLeft = '')
        AND (e.exittype IS NULL OR e.exittype = '')
        ${employeeFilter}
      ORDER BY e.Empl_ID
    `;
    const [employees] = await pool.query(employeesQuery, queryParams);
    console.log(`📋 Found ${employees.length} active employees in ${useDb}`);

    const reconciliationResults = [];

    for (const emp of employees) {
      try {
        const [earningsResult] = await pool.query(
          `SELECT COUNT(*) AS count, COALESCE(SUM(amtthismth), 0) AS total
           FROM \`${useDb}\`.py_masterpayded
           WHERE his_empno = ? AND LEFT(his_type, 2) IN ('BP','BT','PT','PU')`,
          [emp.Empl_ID],
        );

        const [deductionsResult] = await pool.query(
          `SELECT COUNT(*) AS count, COALESCE(SUM(amtthismth), 0) AS total
           FROM \`${useDb}\`.py_masterpayded
           WHERE his_empno = ? AND LEFT(his_type, 2) IN ('PR','PL')`,
          [emp.Empl_ID],
        );

        const [allowanceResult] = await pool.query(
          `SELECT COUNT(*) AS count, COALESCE(SUM(amtthismth), 0) AS total
           FROM \`${useDb}\`.py_masterpayded
           WHERE his_empno = ? AND LEFT(his_type, 2) IN ('PT','PU')`,
          [emp.Empl_ID],
        );

        let wmth =
          parseFloat(earningsResult[0].total) -
          parseFloat(deductionsResult[0].total);

        const [cumResult] = await pool.query(
          `SELECT his_roundup, his_netmth, his_taxmth, his_grossmth, his_type
           FROM \`${useDb}\`.py_mastercum
           WHERE his_empno = ?
             AND (his_type = ? OR his_type = CAST(? AS CHAR))
           LIMIT 1`,
          [emp.Empl_ID, monthOnly, parseInt(monthOnly)],
        );

        let roundup = 0,
          netmth = 0,
          taxmth = 0,
          grossmth = 0;
        if (cumResult.length > 0) {
          const cum = cumResult[0];
          roundup = parseFloat(cum.his_roundup || 0);
          netmth = parseFloat(cum.his_netmth || 0);
          taxmth = parseFloat(cum.his_taxmth || 0);
          grossmth = parseFloat(cum.his_grossmth || 0);
          wmth = wmth + roundup - netmth - taxmth;
        }

        const [paymentBreakdown] = await pool.query(
          `SELECT
             his_type,
             et.elmDesc AS type_description,
             LEFT(his_type, 2) AS type_prefix,
             COALESCE(SUM(amtthismth), 0) AS amount
           FROM py_masterpayded
           LEFT JOIN py_elementType et ON et.PaymentType = his_type
           WHERE his_empno = ?
           GROUP BY his_type
           ORDER BY his_type`,
          [emp.Empl_ID],
        );

        const hasError = Math.abs(wmth) >= 0.01;
        const hasRecords =
          earningsResult[0].total > 0 ||
          deductionsResult[0].total > 0 ||
          cumResult.length > 0 ||
          allowanceResult[0].total > 0;

        if (hasRecords && (!showErrorsOnly || hasError)) {
          reconciliationResults.push({
            employee_number: emp.Empl_ID,
            employee_name: emp.employee_name,
            title: emp.Title,
            title_description: emp.title_description,
            year,
            period: monthOnly,
            total_earnings: parseFloat(earningsResult[0].total),
            total_allowances: parseFloat(allowanceResult[0].total),
            total_deductions: parseFloat(deductionsResult[0].total),
            gross_from_cum: grossmth,
            roundup,
            net_from_cum: netmth,
            tax_from_cum: taxmth,
            error_amount: Math.round(wmth * 100) / 100,
            status: hasError ? "ERROR" : "BALANCED",
            payment_breakdown: paymentBreakdown.map((pb) => ({
              type: pb.his_type,
              type_description: pb.type_description,
              category: this.categorizePaymentType(pb.type_prefix),
              amount: parseFloat(pb.amount),
            })),
          });
        }
      } catch (error) {
        console.error(`Error processing employee ${emp.Empl_ID}:`, error);
      }
    }

    console.log(
      `✅ Reconciliation complete: ${reconciliationResults.length} employees checked, ` +
        `${reconciliationResults.filter((r) => r.status === "ERROR").length} with errors`,
    );
    return reconciliationResults;
  }

  /**
   * Main entry point.
   * Step 1 — summary only (fast, single aggregate query).
   * Step 2 — employee loop ONLY when step 1 detects a real variance.
   */
  async getReconciliationReport(filters = {}) {
    console.log("🚀 Starting reconciliation report...");

    const summary = await this.getSalaryReconciliationSummary(filters);
    const summaryData = summary[0] || null;

    if (!summaryData) {
      return {
        summary: null,
        status: "NO_DATA",
        message: "No reconciliation data found for the specified period",
        total_employees_checked: 0,
        employees_with_errors: 0,
        total_error_amount: 0,
        details: [],
      };
    }

    // ── Early exit: no variance ──────────────────────────────────────────────
    if (!summaryData.has_variance) {
      const monthName = this.getMonthName(summaryData.month);
      console.log(
        `✅ BALANCED — skipping employee loop for ${monthName} ${summaryData.year}`,
      );
      return {
        summary: summaryData,
        status: "BALANCED",
        message: `No variance detected for ${monthName}, ${summaryData.year}. Payroll balanced.`,
        total_employees_checked: summaryData.total_employees,
        employees_with_errors: 0,
        total_error_amount: 0,
        details: [],
        skipped_detailed_check: true,
      };
    }

    // ── Variance detected: run full employee loop ────────────────────────────
    console.log(
      `⚠️  Variance of ${summaryData.calculated_variance} detected — running employee reconciliation...`,
    );
    const details = await this.getEmployeeReconciliation(filters);
    const errorsOnly = details.filter((d) => d.status === "ERROR");

    return {
      summary: summaryData,
      status: "VARIANCE_DETECTED",
      message: `Variance detected: ${errorsOnly.length} employee(s) with reconciliation errors`,
      total_employees_checked: details.length,
      employees_with_errors: errorsOnly.length,
      total_error_amount: errorsOnly.reduce(
        (sum, d) => sum + Math.abs(d.error_amount),
        0,
      ),
      details: errorsOnly,
      all_details: details,
    };
  }

  async quickReconciliationCheck(filters = {}) {
    const summary = await this.getSalaryReconciliationSummary(filters);
    const summaryData = summary[0] || null;

    if (!summaryData) {
      return {
        status: "NO_DATA",
        has_variance: false,
        message: "No data found for the specified period",
      };
    }

    const monthName = this.getMonthName(summaryData.month);
    return {
      status: summaryData.status,
      has_variance: summaryData.has_variance,
      variance_amount: summaryData.calculated_variance,
      total_employees: summaryData.total_employees,
      message: summaryData.has_variance
        ? `Variance of ${summaryData.calculated_variance} detected for ${monthName}, ${summaryData.year}`
        : `Balanced — no variance detected for ${monthName}, ${summaryData.year}`,
    };
  }

  async traceEmployeeReconciliation(employeeId, filters = {}) {
    console.log(`🔍 Tracing reconciliation for employee: ${employeeId}`);

    const result = await this.getEmployeeReconciliation({
      ...filters,
      employeeId,
      showErrorsOnly: false,
    });
    if (result.length === 0) {
      return {
        employee_number: employeeId,
        status: "NOT_FOUND",
        message: "No reconciliation data found for this employee",
      };
    }

    const d = result[0];
    return {
      employee: {
        number: d.employee_number,
        name: d.employee_name,
        title: d.title_description,
      },
      calculation_steps: [
        {
          step: 1,
          description: "Total earnings (BP, BT, PT, PU)",
          amount: d.total_earnings,
          running_total: d.total_earnings,
        },
        {
          step: 2,
          description: "Subtract deductions (PR, PL)",
          amount: -d.total_deductions,
          running_total: d.total_earnings - d.total_deductions,
        },
        {
          step: 3,
          description: "Add roundup",
          amount: d.roundup,
          running_total: d.total_earnings - d.total_deductions + d.roundup,
        },
        {
          step: 4,
          description: "Subtract net pay",
          amount: -d.net_from_cum,
          running_total:
            d.total_earnings - d.total_deductions + d.roundup - d.net_from_cum,
        },
        {
          step: 5,
          description: "Subtract tax",
          amount: -d.tax_from_cum,
          running_total: d.error_amount,
        },
      ],
      final_variance: d.error_amount,
      status: d.status,
      payment_breakdown: d.payment_breakdown,
    };
  }

  categorizePaymentType(prefix) {
    const categories = {
      BP: "Basic Pay",
      BT: "Basic Pay Component",
      PT: "Allowance",
      PU: "Round Up",
      PR: "Deduction",
      PL: "Loan",
    };
    return categories[prefix] || "Other";
  }

  async getPaymentTypeErrorAnalysis(filters = {}) {
    const reconciliation = await this.getEmployeeReconciliation({
      ...filters,
      showErrorsOnly: true,
    });
    const typeAnalysis = {};

    reconciliation.forEach((emp) => {
      emp.payment_breakdown.forEach((payment) => {
        if (!typeAnalysis[payment.type]) {
          typeAnalysis[payment.type] = {
            type: payment.type,
            category: payment.category,
            occurrences: 0,
            total_amount: 0,
            employees: [],
          };
        }
        typeAnalysis[payment.type].occurrences++;
        typeAnalysis[payment.type].total_amount += payment.amount;
        typeAnalysis[payment.type].employees.push({
          employee_number: emp.employee_number,
          employee_name: emp.employee_name,
          amount: payment.amount,
        });
      });
    });

    return Object.values(typeAnalysis).sort(
      (a, b) => b.occurrences - a.occurrences,
    );
  }
}

module.exports = new ReconciliationService();