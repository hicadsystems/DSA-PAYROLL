// ============================================================================
// FILE: services/payslipGenerationService.js
// Payslip Generation matching legacy py_py24slip logic
// ============================================================================

const pool = require("../../config/db");

// How many rows to INSERT per batch. Tune based on max_allowed_packet.
// 100 rows × ~40 columns is well within MySQL defaults.
const INSERT_BATCH_SIZE = 100;

// Max concurrent employees when processing within a concurrency pool.
// Kept low because we batch-insert, so this only affects the assembly phase.
const CONCURRENCY = 50;

class PayslipGenerationService {
  // ==========================================================================
  // MAIN: Generate Payslips
  // ==========================================================================
  async generatePayslips(params) {
    const {
      empno1, // Start employee ID or single ID
      empno2, // End employee ID
      branch, // Payroll class (Officers/Ratings)
      optall, // Option: All employees
      optrange, // Option: Range of employees
      optbank, // Option: By bank
      optloc, // Option: By location
      optindividual, // Option: Individual employee
      wxdate, // Processing date
      station, // Workstation/user ID (from req.user_fullname)
      year,
      month,
    } = params;

    if (!station) {
      throw new Error("User fullname is required for station identification");
    }

    try {
      // Step 1: Clear previous temp data for this user
      await this.clearTempData(station);

      // Step 2: Get current period
      const period = await this.getCurrentPeriod(year, month);
      if (!period) {
        throw new Error(
          "Current period not set (BT05) or invalid year/month provided",
        );
      }

      // ── 3. Calculation check ──────────────────────────────────────────────
      const stdRate = await this.getStdRatePeriod();
      const isCurrentPeriod =
        parseInt(period.ord) === parseInt(stdRate.year) &&
        parseInt(period.mth) === parseInt(stdRate.month);

      if (isCurrentPeriod && stdRate.sun != 999) {
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
        const monthName = months[parseInt(period.mth) - 1] || period.mth;
        return {
          success: false,
          message: `Calculation not completed for ${monthName}, ${period.ord}. Please complete payroll calculation before generating payslips.`,
          count: 0,
        };
      }

      // ── 4. Get employees ──────────────────────────────────────────────────
      const employees = await this.getEmployees({
        empno1,
        empno2,
        branch,
        optall,
        optrange,
        optbank,
        optloc,
        optindividual,
      });

      if (employees.length === 0) {
        return { success: false, message: "No employees found", count: 0 };
      }

      // Filter terminated employees upfront — no need to hit DB per employee
      const activeEmployees = wxdate
        ? employees.filter(
            (e) => !e.dateleft || e.dateleft === "" || e.dateleft > wxdate,
          )
        : employees;

      if (activeEmployees.length === 0) {
        return {
          success: false,
          message: "No active employees found",
          count: 0,
        };
      }

      const empIds = activeEmployees.map((e) => e.empl_id);

      // ── 5. Bulk-fetch all reference data in parallel ───────────────────────
      const [
        cumulativeMap,
        paymentsMap,
        metadataMaps,
        elementDescMap,
        mthdesc,
      ] = await Promise.all([
        this.bulkGetCumulative(empIds, period.mth),
        this.bulkGetPayments(empIds),
        this.bulkGetMetadata(activeEmployees),
        this.bulkGetElementDescriptions(),
        this.getMonthDescription(period.mth),
      ]);

      // ── 6. Assemble rows in memory ────────────────────────────────────────
      const rows = [];
      let processedCount = 0;

      for (const employee of activeEmployees) {
        const empno = employee.empl_id;
        const cumulative = cumulativeMap.get(empno);
        const payments = paymentsMap.get(empno);

        if (!cumulative || !payments || payments.length === 0) {
          continue; // Skip employees with no data (matches original behaviour)
        }

        const metadata = metadataMaps.get(empno) || {};
        const prvtaxtodate =
          (cumulative.taxtodate || 0) - (cumulative.taxmth || 0);

        for (const payment of payments) {
          const row = this._assembleRow({
            employee,
            payment,
            cumulative,
            metadata,
            period,
            station,
            branch,
            mthdesc,
            prvtaxtodate,
            elementDescMap,
          });
          if (row) rows.push(row);
        }

        processedCount++;
      }

      // ── 7. Batch INSERT ───────────────────────────────────────────────────
      if (rows.length > 0) {
        await this.batchInsert(rows);
      }

      // ── 8. Clean up zero records ──────────────────────────────────────────
      await this.cleanupZeroRecords(station);

      return {
        success: true,
        message: "Payslips generated successfully",
        count: processedCount,
        total: activeEmployees.length,
      };
    } catch (error) {
      console.error("Payslip generation error:", error);
      throw error;
    }
  }

  // ==========================================================================
  // BULK: Cumulative data for all employees in one query
  // Returns Map<empId, row>
  // ==========================================================================
  async bulkGetCumulative(empIds, month) {
    if (empIds.length === 0) return new Map();

    const [rows] = await pool.query(
      `SELECT
         his_empno,
         his_taxtodate    AS taxtodate,
         his_taxmth       AS taxmth,
         his_grosstodate  AS grstodate,
         his_taxfreepaytodate AS freetodate,
         his_taxabletodate    AS taxable,
         his_netmth       AS netmth
       FROM py_mastercum
       WHERE his_empno IN (?)
         AND his_type = ?`,
      [empIds, month],
    );

    const map = new Map();
    for (const r of rows) map.set(r.his_empno, r);
    return map;
  }

  // ==========================================================================
  // BULK: Payment details for all employees in one query
  // Returns Map<empId, payment[]>
  // ==========================================================================
  async bulkGetPayments(empIds) {
    if (empIds.length === 0) return new Map();

    const [rows] = await pool.query(
      `SELECT
         his_empno,
         his_type,
         amtthismth,
         initialloan,
         totamtpayable,
         nmth,
         payindic
       FROM py_masterpayded
       WHERE his_empno IN (?)
         AND amtthismth > 0
         AND LEFT(his_type, 2) != 'FP'
       ORDER BY his_empno, his_type`,
      [empIds],
    );

    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.his_empno)) map.set(r.his_empno, []);
      map.get(r.his_empno).push(r);
    }
    return map;
  }

  // ==========================================================================
  // BULK: All metadata in 4 queries, joined in JS
  // Returns Map<empId, metadataObject>
  // ==========================================================================
  async bulkGetMetadata(employees) {
    // Only fields that exist on py_wkemployees — pfacode and email are NOT in that table
    const factoryCodes = [
      ...new Set(employees.map((e) => e.factory).filter((v) => v && v !== "0")),
    ];
    const locationCodes = [
      ...new Set(employees.map((e) => e.location).filter(Boolean)),
    ];
    const bankCodes = [
      ...new Set(employees.map((e) => e.bankcode).filter(Boolean)),
    ];
    const titleCodes = [
      ...new Set(employees.map((e) => e.title).filter(Boolean)),
    ];

    // Run all 4 lookup queries in parallel
    const [factoryRows, deptRows, bankRows, titleRows] = await Promise.all([
      factoryCodes.length
        ? pool
            .query(
              `SELECT busline, busdesc FROM ac_businessline WHERE busline IN (?)`,
              [factoryCodes],
            )
            .then((r) => r[0])
        : [],
      locationCodes.length
        ? pool
            .query(
              `SELECT unitcode, unitdesc FROM ac_costcentre WHERE unitcode IN (?)`,
              [locationCodes],
            )
            .then((r) => r[0])
        : [],
      bankCodes.length
        ? pool
            .query(
              `SELECT bankcode, bankname FROM py_bank WHERE bankcode IN (?)`,
              [bankCodes],
            )
            .then((r) => r[0])
        : [],
      titleCodes.length
        ? pool
            .query(
              `SELECT Titlecode, Description FROM py_Title WHERE Titlecode IN (?)`,
              [titleCodes],
            )
            .then((r) => r[0])
        : [],
    ]);

    // Build lookup Maps
    const factoryMap = new Map(
      factoryRows.map((r) => [r.busline, r.busdesc?.substring(0, 70) || ""]),
    );
    const deptMap = new Map(
      deptRows.map((r) => [r.unitcode, r.unitdesc?.substring(0, 70) || ""]),
    );
    const bankMap = new Map(
      bankRows.map((r) => [r.bankcode, r.bankname || ""]),
    );
    const titleMap = new Map(
      titleRows.map((r) => [r.Titlecode, r.Description || ""]),
    );

    // Build per-employee metadata Map
    const metadataMap = new Map();
    for (const e of employees) {
      metadataMap.set(e.empl_id, {
        factory_desc: factoryMap.get(e.factory) || "",
        dept_desc: deptMap.get(e.location) || "",
        bank_name: bankMap.get(e.bankcode) || "",
        pfa_desc: "", // pfacode not present on py_wkemployees
        title_desc: titleMap.get(e.title) || "",
        payclass_desc: "",
      });
    }

    return metadataMap;
  }

  // ==========================================================================
  // BULK: All element descriptions in one query
  // Returns Map<paymentType, description>
  // Replaces per-payment-row lookup inside insertPayslipRecord
  // ==========================================================================
  async bulkGetElementDescriptions() {
    const [rows] = await pool.query(
      `SELECT PaymentType, elmDesc FROM py_elementType`,
    );
    const map = new Map();
    for (const r of rows)
      map.set(r.PaymentType, (r.elmDesc || "").substring(0, 30));
    return map;
  }

  // ==========================================================================
  // Single month description (called once, not per-payment-row)
  // ==========================================================================
  async getMonthDescription(month) {
    const [rows] = await pool.query(
      `SELECT mthdesc FROM ac_months WHERE cmonth = ? LIMIT 1`,
      [month],
    );
    return rows[0]?.mthdesc || "";
  }

  // ==========================================================================
  // ASSEMBLE: Build one INSERT row in memory (no DB calls)
  // Pure function — takes pre-fetched data, returns value array.
  // ==========================================================================
  _assembleRow({
    employee,
    payment,
    cumulative,
    metadata,
    period,
    station,
    branch,
    mthdesc,
    prvtaxtodate,
    elementDescMap,
  }) {
    const paymentType = payment.his_type.substring(0, 2);

    let bpc = "",
      bpa = "";
    let loan = 0,
      ltenor = 0,
      lbal = 0,
      lmth = 0;

    if (paymentType === "BP" || paymentType === "BT") {
      bpc = "BP";
      bpa = "TAXABLE PAYMENT";
    } else if (paymentType === "PT") {
      bpc = "PT";
      bpa = "NON-TAXABLE PAYMENT";
    } else if (paymentType === "PR" || paymentType === "PL") {
      bpc = "PR";
      bpa = "DEDUCTION";
      loan = payment.initialloan || 0;
      ltenor = payment.nmth || 0;
      lbal = payment.totamtpayable || 0;
      lmth = payment.nmth || 0;
    } else {
      return null; // Unknown type — skip
    }

    if (lbal < 5.0) lbal = 0; // Match legacy: If @totamtpayable < 5.00

    const wdesc = elementDescMap.get(payment.his_type) || "";

    return [
      station,
      employee.empl_id,
      bpc,
      bpa,
      wdesc,
      payment.amtthismth,
      loan,
      ltenor,
      lbal,
      lmth,
      period.ord,
      mthdesc,
      "", // tpcoy
      "", // tpaddr
      metadata.title_desc || employee.title,
      employee.surname || "",
      employee.othername || "",
      employee.bankacnumber || "",
      metadata.bank_name || "",
      employee.gradelevel || "",
      employee.gradetype || "",
      prvtaxtodate,
      cumulative.taxtodate || 0,
      cumulative.grstodate || 0,
      cumulative.freetodate || 0,
      cumulative.taxable || 0,
      cumulative.taxmth || 0,
      cumulative.netmth || 0,
      "00", // groupcode
      metadata.factory_desc || "",
      metadata.dept_desc || "",
      metadata.pfa_desc || "",
      employee.nsitfcode || "",
      employee.email || "",
      0, // status
      branch,
    ];
  }

  // ==========================================================================
  // BATCH INSERT: INSERT all rows in chunks
  // MySQL multi-row INSERT is dramatically faster than N individual INSERTs.
  // ==========================================================================
  async batchInsert(rows) {
    const columns = `(
      work_station, NUMB, bpc, bpa, BP, BPM,
      loan, ltenor, lbal, lmth,
      ord, desc1, tpcoy, tpaddr,
      title, surname, othername, bankacnumber, bankname,
      gradelevel, gradetype, prvtaxtodate,
      taxtodate, grstodate, freetodate, txbltodate,
      currtax, netpay, groupcode, factory,
      location, nsitf, nsitfcode, email,
      status, payclass
    )`;

    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const chunk = rows.slice(i, i + INSERT_BATCH_SIZE);
      await pool.query(`INSERT INTO py_tempslipnlpc ${columns} VALUES ?`, [
        chunk,
      ]);
    }
  }

  // ==========================================================================
  // Get employees based on filter options (unchanged)
  // ==========================================================================
  async getEmployees(options) {
    const {
      empno1,
      empno2,
      branch,
      optall,
      optrange,
      optbank,
      optloc,
      optindividual,
    } = options;

    let query = `
      SELECT
        empl_id, dateleft, factory, location, title,
        surname, othername, bankacnumber, bankcode,
        gradelevel, gradetype, nsitfcode, payrollclass
      FROM py_wkemployees
      WHERE 1=1
    `;
    const params = [];

    if (branch) {
      query += ` AND payrollclass = ?`;
      params.push(branch);
    }

    if (optall === "1") {
      query += ` ORDER BY factory, location, empl_id`;
    } else if (optrange === "1") {
      query += ` AND empl_id BETWEEN ? AND ? ORDER BY factory, location, empl_id`;
      params.push(empno1, empno2);
    } else if (optbank === "1") {
      query += ` AND bankcode = ? ORDER BY bankbranch, empl_id`;
      params.push(empno1);
    } else if (optloc === "1") {
      query += ` AND location = ? ORDER BY factory, location, empl_id`;
      params.push(empno1);
    } else if (optindividual === "1") {
      query += ` AND empl_id = ? ORDER BY empl_id`;
      params.push(empno1);
    } else {
      query += ` ORDER BY factory, location, empl_id`;
    }

    const [rows] = await pool.query(query, params);
    return rows;
  }

  // ==========================================================================
  // Get current period (unchanged)
  // ==========================================================================
  async getCurrentPeriod(manualYear = null, manualMonth = null) {
    if (manualYear && manualMonth) {
      console.log(
        `📅 Using manual period: Year=${manualYear}, Month=${manualMonth}`,
      );

      const [rows] = await pool.query(
        `SELECT ord, mth, pmth FROM py_stdrate
         WHERE type = 'BT05' AND ord = ? AND mth = ? LIMIT 1`,
        [manualYear, manualMonth],
      );

      if (rows.length > 0) return rows[0];

      console.warn(
        `⚠️ Manual period ${manualYear}-${manualMonth} not found in py_stdrate, using provided values`,
      );
      return { ord: manualYear, mth: manualMonth, pmth: null };
    }

    const [rows] = await pool.query(
      `SELECT ord, mth, pmth FROM py_stdrate WHERE type = 'BT05' LIMIT 1`,
    );
    if (rows.length > 0)
      console.log(
        `📅 Using BT05 period: Year=${rows[0].ord}, Month=${rows[0].mth}`,
      );
    return rows[0] || null;
  }

  // ==========================================================================
  // Get BT05 period info including sun flag (unchanged)
  // ==========================================================================
  async getStdRatePeriod() {
    const [rows] = await pool.query(
      `SELECT sun, ord AS year, mth AS month FROM py_stdrate WHERE type = 'BT05' LIMIT 1`,
    );
    return rows[0];
  }

  // ==========================================================================
  // Clear temp data for user (unchanged)
  // ==========================================================================
  async clearTempData(station) {
    await pool.query(`DELETE FROM py_tempslipnlpc WHERE work_station = ?`, [
      station,
    ]);
  }

  // ==========================================================================
  // Clean up zero records (unchanged)
  // ==========================================================================
  async cleanupZeroRecords(station) {
    await pool.query(
      `DELETE FROM py_tempslipnlpc WHERE work_station = ? AND currtax = 0 AND bpm = 0`,
      [station],
    );
  }

  // ==========================================================================
  // Retrieve generated payslips (unchanged)
  // ==========================================================================
  async getGeneratedPayslips(station) {
    const [rows] = await pool.query(
      `SELECT * FROM py_tempslipnlpc WHERE work_station = ? ORDER BY NUMB, bpc, BP`,
      [station],
    );
    return rows;
  }

  // ==========================================================================
  // Get payslips grouped by employee
  // BEFORE: 1 GROUP BY query + N individual payment queries (N+1 problem)
  // AFTER:  2 queries total, joined in JS
  // ==========================================================================
  async getPayslipsGroupedByEmployee(station) {
    // Query 1: employee-level summary
    const [empRows] = await pool.query(
      `SELECT
         p.NUMB            AS employee_id,
         p.title, p.surname, p.othername,
         p.bankacnumber, p.bankname,
         p.gradelevel, p.gradetype,
         p.ord             AS year,
         p.desc1           AS month_desc,
         p.factory, p.location,
         p.nsitf, p.nsitfcode, p.email, p.payclass,
         pc.classname      AS payclass_name,
         MAX(p.prvtaxtodate) AS prvtaxtodate,
         MAX(p.taxtodate)    AS taxtodate,
         MAX(p.grstodate)    AS grstodate,
         MAX(p.freetodate)   AS freetodate,
         MAX(p.txbltodate)   AS txbltodate,
         MAX(p.currtax)      AS currtax,
         MAX(p.netpay)       AS netpay
       FROM py_tempslipnlpc p
       LEFT JOIN py_payrollclass pc ON p.payclass = pc.classcode
       WHERE p.work_station = ?
       GROUP BY
         p.NUMB, p.title, p.surname, p.othername, p.bankacnumber, p.bankname,
         p.gradelevel, p.gradetype, p.ord, p.desc1, p.factory, p.location,
         p.nsitf, p.nsitfcode, p.email, p.payclass, pc.classname
       ORDER BY p.NUMB`,
      [station],
    );

    if (empRows.length === 0) return [];

    // Query 2: all payment rows for this station in one shot
    const [paymentRows] = await pool.query(
      `SELECT
         NUMB             AS employee_id,
         bpc              AS category_code,
         bpa              AS category_desc,
         BP               AS payment_desc,
         BPM              AS amount,
         loan,
         ltenor           AS loan_tenor,
         lbal             AS loan_balance,
         lmth             AS loan_months
       FROM py_tempslipnlpc
       WHERE work_station = ?
       ORDER BY NUMB, bpc, BP`,
      [station],
    );

    // Group payment rows by employee in JS — no extra DB round-trips
    const paymentsByEmp = new Map();
    for (const p of paymentRows) {
      if (!paymentsByEmp.has(p.employee_id))
        paymentsByEmp.set(p.employee_id, []);
      paymentsByEmp.get(p.employee_id).push(p);
    }

    // Merge
    return empRows.map((row) => ({
      ...row,
      payments: paymentsByEmp.get(row.employee_id) || [],
    }));
  }
}

module.exports = new PayslipGenerationService();