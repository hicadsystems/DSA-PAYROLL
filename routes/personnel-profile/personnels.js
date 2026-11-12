const express = require("express");
const pool = require("../../config/db"); // mysql2 pool
const verifyToken = require("../../middware/authentication");
//const { attachPayrollClass } = require('../../middware/attachPayrollClass');
const router = express.Router();

// =============================================================================
// HELPER FUNCTION: Grade level + step for display
// =============================================================================

/**
 * Works out the grade level and current step for display, the same way
 * Master File Update works out the step it pays (py_updatepayroll_05):
 *   step = stored step (last two digits of the grade level)
 *        + calendar years since the promotion year,
 *   at least 1, capped at the scale's top step (step20, or 20 if blank),
 *   with no increase for location 103. The year used is the year of the
 *   month after the current payroll period (BT05), as in Master File Update.
 * Whenever that cannot be worked out properly (grade level not in GGSS
 * form, no or invalid promotion date, promotion after that year,
 * location 103, no salary scale for the grade) the stored grade level is
 * shown as it is.
 */
async function computeGradeStep({ gradelevel, datepmted, gradetype, Location } = {}) {
  const raw = gradelevel ? String(gradelevel).trim() : "";
  const fallback = {
    gradeLevel: raw || "N/A",
    currentStep: null,
    displayValue: raw || "N/A",
  };
  if (!/^\d{4}$/.test(raw)) return fallback;
  if (String(Location || "").trim() === "103") return fallback;

  // Promotion date, stored as YYYYMMDD. Like Master File Update, only the
  // year is used.
  const dateStr = datepmted ? String(datepmted).trim() : "";
  if (!/^\d{8}$/.test(dateStr)) return fallback;
  const y = +dateStr.slice(0, 4);
  if (y < 1900) return fallback;

  // Year used for the step: the month after the payroll period (BT05)
  let stepYear = new Date().getFullYear();
  try {
    const [period] = await pool.query(
      "SELECT ord, mth FROM py_stdrate WHERE type = 'BT05' LIMIT 1",
    );
    if (period && period.length && +period[0].ord) {
      stepYear = +period[0].ord + (+period[0].mth === 12 ? 1 : 0);
    }
  } catch (_) {
    /* keep the calendar year */
  }
  if (y > stepYear) return fallback;

  const gradeLevelPrefix = raw.substring(0, 2);
  const [scaleData] = await pool.query(
    "SELECT COUNT(*) AS n, MAX(step20) AS top_step FROM py_salaryscale WHERE salcode = ? AND grade = ?",
    [gradetype || "", gradeLevelPrefix],
  );
  if (!scaleData || !scaleData.length || !+scaleData[0].n) return fallback;
  const topStep =
    scaleData[0].top_step == null ? 20 : parseInt(scaleData[0].top_step, 10);
  if (!(topStep >= 1 && topStep <= 99)) return fallback;

  const yearsSincePromotion = stepYear - y;
  const currentStep = Math.min(
    topStep,
    Math.max(1, +raw.slice(2) + yearsSincePromotion),
  );
  return {
    gradeLevel: gradeLevelPrefix,
    currentStep,
    displayValue: `${gradeLevelPrefix}${String(currentStep).padStart(2, "0")}`,
    step20: topStep,
    yearsSincePromotion,
  };
}

// =============================================================================
// HELPER FUNCTION: Get Payroll Class from Current Database
// =============================================================================

/**
 * Maps database name to payroll class code from py_payrollclass
 * @param {string} dbName - Current database name
 * @returns {string} Payroll class code
 */
async function getPayrollClassFromDb(dbName) {
  const masterDb = pool.getMasterDb();
  const connection = await pool.getConnection();

  try {
    await connection.query(`USE \`${masterDb}\``);
    const [rows] = await connection.query(
      "SELECT classcode FROM py_payrollclass WHERE db_name = ?",
      [dbName],
    );

    const result = rows.length > 0 ? rows[0].classcode : null;
    console.log("🔍 Database:", dbName, "→ Payroll Class:", result);
    return result;
  } finally {
    connection.release();
  }
}

// =============================================================================
// HR_EMPLOYEES CRUD OPERATIONS
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: replaces the per-employee N×3 serial COUNT queries with 3 bulk
// queries regardless of how many employees are in the page.
// ─────────────────────────────────────────────────────────────────────────────
async function attachRelationshipCounts(employees) {
  if (!employees.length) return;

  const ids = employees.map((e) => e.Empl_ID);

  const [childrenRows] = await pool.query(
    "SELECT Empl_ID, COUNT(*) as count FROM children WHERE Empl_ID IN (?) AND chactive = 1 GROUP BY Empl_ID",
    [ids],
  );
  const [nokRows] = await pool.query(
    "SELECT Empl_ID, COUNT(*) as count FROM nextofkin WHERE Empl_ID IN (?) AND IsActive = 1 GROUP BY Empl_ID",
    [ids],
  );
  const [spouseRows] = await pool.query(
    "SELECT Empl_ID, COUNT(*) as count FROM spouse WHERE Empl_ID IN (?) AND spactive = 1 GROUP BY Empl_ID",
    [ids],
  );

  const childrenMap = Object.fromEntries(
    childrenRows.map((r) => [r.Empl_ID, r.count]),
  );
  const nokMap = Object.fromEntries(nokRows.map((r) => [r.Empl_ID, r.count]));
  const spouseMap = Object.fromEntries(
    spouseRows.map((r) => [r.Empl_ID, r.count]),
  );

  for (const employee of employees) {
    employee.children_count = childrenMap[employee.Empl_ID] ?? 0;
    employee.nok_count = nokMap[employee.Empl_ID] ?? 0;
    employee.spouse_count = spouseMap[employee.Empl_ID] ?? 0;
  }
}

// GET all current employees
router.get("/employees-current", verifyToken, async (req, res) => {
  try {
    // Get database from pool using user_id as session
    const currentDb = pool.getCurrentDatabase(req.user_id.toString());
    const payrollClass = await getPayrollClassFromDb(currentDb);

    //console.log('🔍 Current database:', currentDb);
    //console.log('🔍 Payroll class filter:', payrollClass);
    //console.log('🔍 User ID:', req.user_id);

    // Get employees filtered by payroll class
    const [rows] = await pool.query(
      `
      SELECT hr.Empl_ID, hr.Title, hr.Surname, hr.OtherName, tt.rank_order
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      WHERE (hr.exittype IS NULL OR hr.exittype = '')
        AND (
              hr.DateLeft IS NULL
              OR hr.DateLeft = ''
              OR hr.DateLeft > DATE_FORMAT(CURDATE(), '%Y%m%d')
            )
        AND hr.payrollclass = ?
      ORDER BY tt.rank_order DESC, hr.Empl_ID ASC
    `,
      [payrollClass],
    );

    await attachRelationshipCounts(rows);

    console.log(
      "✅ Query returned:",
      rows.length,
      "records for payroll class",
      payrollClass,
    );

    res.json({
      success: true,
      data: rows,
      payrollClass,
      database: currentDb,
    });
  } catch (error) {
    console.error("❌ Query error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET all current employees with pagination
router.get("/employees-current-pages", verifyToken, async (req, res) => {
  try {
    // Get database from pool using user_id as session
    const currentDb = pool.getCurrentDatabase(req.user_id.toString());
    const payrollClass = await getPayrollClassFromDb(currentDb);

    //console.log('🔍 Current database:', currentDb);
    //console.log('🔍 Payroll class filter:', payrollClass);
    //console.log('🔍 User ID:', req.user_id);

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    console.log("Pagination - Page:", page, "Limit:", limit, "Offset:", offset);

    // Get total count with payroll class filter
    const [countResult] = await pool.query(
      `
      SELECT COUNT(*) as total
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      WHERE (hr.exittype IS NULL OR hr.exittype = '')
        AND (
          hr.DateLeft IS NULL
          OR hr.DateLeft = ''
          OR hr.DateLeft > DATE_FORMAT(CURDATE(), '%Y%m%d')
        )
        AND hr.payrollclass = ?
    `,
      [payrollClass],
    );

    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limit);

    // Get paginated employees with payroll class filter
    const [rows] = await pool.query(
      `
      SELECT hr.Empl_ID, hr.Title, hr.Surname, hr.OtherName, tt.rank_order
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      WHERE (hr.exittype IS NULL OR hr.exittype = '')
        AND (
          hr.DateLeft IS NULL
          OR hr.DateLeft = ''
          OR hr.DateLeft > DATE_FORMAT(CURDATE(), '%Y%m%d')
        )
        AND hr.payrollclass = ?
      ORDER BY tt.rank_order DESC, hr.Empl_ID ASC
      LIMIT ? OFFSET ?
    `,
      [payrollClass, limit, offset],
    );

    await attachRelationshipCounts(rows);

    console.log("🔍 Query returned:", rows.length, "records");

    res.json({
      success: true,
      data: rows,
      payrollClass,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        limit: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error("❌ Query error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET current employees with SEARCH
router.get("/employees-current/search", verifyToken, async (req, res) => {
  try {
    const currentDb = pool.getCurrentDatabase(req.user_id.toString());
    const payrollClass = await getPayrollClassFromDb(currentDb);

    const searchTerm = req.query.q || req.query.search || "";
    const rankFilter = req.query.rank || "";
    const findEmployee = req.query.findEmployee || ""; // NEW: Find which page an employee is on
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    console.log("🔎 Search term:", searchTerm);
    console.log("🔎 Rank filter:", rankFilter);
    console.log("🔎 Find employee:", findEmployee);
    console.log(
      "📄 Pagination - Page:",
      page,
      "Limit:",
      limit,
      "Offset:",
      offset,
    );

    // Base WHERE clause
    let whereClause = `
      WHERE (hr.exittype IS NULL OR hr.exittype = '')
        AND (
          hr.DateLeft IS NULL
          OR hr.DateLeft = ''
          OR hr.DateLeft > DATE_FORMAT(CURDATE(), '%Y%m%d')
        )
        AND hr.payrollclass = ?
    `;

    const params = [payrollClass];

    // Add search conditions if search term provided
    if (searchTerm) {
      whereClause += ` AND (
        hr.Empl_ID LIKE ? OR
        hr.Surname LIKE ? OR
        hr.OtherName LIKE ? OR
        hr.Title LIKE ? OR
        hr.email LIKE ? OR
        hr.gsm_number LIKE ? OR
        CONCAT(hr.Surname, ' ', hr.OtherName) LIKE ?
      )`;

      const searchPattern = `%${searchTerm}%`;
      params.push(
        searchPattern, // Empl_ID
        searchPattern, // Surname
        searchPattern, // OtherName
        searchPattern, // Title
        searchPattern, // email
        searchPattern, // gsm_number
        searchPattern, // Full name
      );
    }

    // Add rank filter if provided
    if (rankFilter) {
      whereClause += ` AND hr.Title = ?`;
      params.push(rankFilter);
    }

    // ===== NEW: FIND EMPLOYEE PAGE LOGIC =====
    if (findEmployee) {
      console.log("🎯 Finding page for employee:", findEmployee);

      // Count how many records come BEFORE this employee (with same filters)
      const positionQuery = `
        SELECT COUNT(*) as position
        FROM hr_employees hr
        LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
        ${whereClause}
        AND hr.Empl_ID < ?
      `;

      const [positionResult] = await pool.query(positionQuery, [
        ...params,
        findEmployee,
      ]);
      const recordsBefore = positionResult[0].position;

      // Calculate which page this employee is on
      const employeePage = Math.floor(recordsBefore / limit) + 1;

      console.log(
        "📍 Employee position:",
        recordsBefore + 1,
        "→ Page:",
        employeePage,
      );

      // Return just the page number
      return res.json({
        success: true,
        employeePage: employeePage,
        position: recordsBefore + 1,
        totalRecords: recordsBefore + 1, // Will be updated with actual total if needed
      });
    }
    // ===== END NEW LOGIC =====

    // Get total count with all filters
    const countQuery = `
      SELECT COUNT(*) as total
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      ${whereClause}
    `;

    const [countResult] = await pool.query(countQuery, params);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limit);

    // Get paginated results with all filters
    const dataQuery = `
      SELECT hr.Empl_ID, hr.Title, hr.Surname, hr.OtherName, tt.rank_order
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      ${whereClause}
      ORDER BY tt.rank_order DESC, hr.Empl_ID ASC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.query(dataQuery, [...params, limit, offset]);

    await attachRelationshipCounts(rows);

    console.log(
      "🔍 Search returned:",
      rows.length,
      "of",
      totalRecords,
      "total records",
    );

    res.json({
      success: true,
      data: rows,
      payrollClass,
      searchTerm: searchTerm,
      rankFilter: rankFilter,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        limit: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error("❌ Search error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET old employees
router.get("/employees-old", verifyToken, async (req, res) => {
  try {
    const currentDb = pool.getCurrentDatabase(req.user_id.toString());
    const payrollClass = await getPayrollClassFromDb(currentDb);

    //console.log('🔍 Current database:', currentDb);
    //console.log('🔍 Payroll class filter:', payrollClass);
    //console.log('🔍 User ID:', req.user_id);

    // Get employees with payroll class filter
    const [rows] = await pool.query(
      `
      SELECT hr.Empl_ID, hr.Title, hr.Surname, hr.OtherName, tt.rank_order
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      WHERE ((hr.exittype IS NOT NULL AND hr.exittype <> '')
          OR (
            hr.DateLeft IS NOT NULL
            AND hr.DateLeft <> ''
            AND hr.DateLeft <= DATE_FORMAT(CURDATE(), '%Y%m%d')
          )) 
        AND hr.payrollclass = ?
      ORDER BY tt.rank_order DESC, hr.Empl_ID ASC
      `,
      [payrollClass],
    );

    await attachRelationshipCounts(rows);

    console.log("🔍 Query returned:", rows.length, "records");

    res.json({ success: true, data: rows, payrollClass });
  } catch (error) {
    console.error("❌ Query error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET old employees with pagination
router.get("/employees-old-pages", verifyToken, async (req, res) => {
  try {
    const currentDb = pool.getCurrentDatabase(req.user_id.toString());
    const payrollClass = await getPayrollClassFromDb(currentDb);

    //console.log('🔍 Current database:', currentDb);
    //console.log('🔍 Payroll class filter:', payrollClass);
    //console.log('🔍 User ID:', req.user_id);

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    console.log("Pagination - Page:", page, "Limit:", limit, "Offset:", offset);

    // Get total count with payroll class filter
    const [countResult] = await pool.query(
      `
      SELECT COUNT(*) as total
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      WHERE ((hr.exittype IS NOT NULL AND hr.exittype <> '')
          OR (
            hr.DateLeft IS NOT NULL
            AND hr.DateLeft <> ''
            AND hr.DateLeft <= DATE_FORMAT(CURDATE(), '%Y%m%d')
          )) 
        AND hr.payrollclass = ?
    `,
      [payrollClass],
    );

    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limit);

    // Get paginated employees with payroll class filter
    const [rows] = await pool.query(
      `
      SELECT hr.Empl_ID, hr.Title, hr.Surname, hr.OtherName, tt.rank_order
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      WHERE ((hr.exittype IS NOT NULL AND hr.exittype <> '')
          OR (
            hr.DateLeft IS NOT NULL
            AND hr.DateLeft <> ''
            AND hr.DateLeft <= DATE_FORMAT(CURDATE(), '%Y%m%d')
          )) 
        AND hr.payrollclass = ?
      ORDER BY tt.rank_order DESC, hr.Empl_ID ASC
      LIMIT ? OFFSET ?
    `,
      [payrollClass, limit, offset],
    );

    await attachRelationshipCounts(rows);

    console.log("🔍 Query returned:", rows.length, "records");

    res.json({
      success: true,
      data: rows,
      payrollClass,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        limit: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error("❌ Query error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET old employees with SEARCH
router.get("/employees-old/search", verifyToken, async (req, res) => {
  try {
    const currentDb = pool.getCurrentDatabase(req.user_id.toString());
    const payrollClass = await getPayrollClassFromDb(currentDb);

    const searchTerm = req.query.q || req.query.search || "";
    const rankFilter = req.query.rank || "";
    const findEmployee = req.query.findEmployee || ""; // ← ADD THIS
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    console.log("🔎 Search term:", searchTerm);
    console.log("🔎 Rank filter:", rankFilter);
    console.log("🔎 Find employee:", findEmployee); // ← ADD THIS
    console.log(
      "📄 Pagination - Page:",
      page,
      "Limit:",
      limit,
      "Offset:",
      offset,
    );

    // Base WHERE clause
    let whereClause = `
      WHERE ((hr.exittype IS NOT NULL AND hr.exittype <> '')
          OR (
            hr.DateLeft IS NOT NULL
            AND hr.DateLeft <> ''
            AND hr.DateLeft <= DATE_FORMAT(CURDATE(), '%Y%m%d')
          )) 
        AND hr.payrollclass = ?
    `;

    const params = [payrollClass];

    // Add search conditions if search term provided
    if (searchTerm) {
      whereClause += ` AND (
        hr.Empl_ID LIKE ? OR
        hr.Surname LIKE ? OR
        hr.OtherName LIKE ? OR
        hr.Title LIKE ? OR
        hr.email LIKE ? OR
        hr.gsm_number LIKE ? OR
        CONCAT(hr.Surname, ' ', hr.OtherName) LIKE ?
      )`;

      const searchPattern = `%${searchTerm}%`;
      params.push(
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
      );
    }

    // Add rank filter if provided
    if (rankFilter) {
      whereClause += ` AND hr.Title = ?`;
      params.push(rankFilter);
    }

    // ===== ADD THIS BLOCK: FIND EMPLOYEE PAGE LOGIC =====
    if (findEmployee) {
      console.log("🎯 Finding page for employee:", findEmployee);

      const positionQuery = `
        SELECT COUNT(*) as position
        FROM hr_employees hr
        LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
        ${whereClause}
        AND hr.Empl_ID < ?
      `;

      const [positionResult] = await pool.query(positionQuery, [
        ...params,
        findEmployee,
      ]);
      const recordsBefore = positionResult[0].position;

      const employeePage = Math.floor(recordsBefore / limit) + 1;

      console.log(
        "📍 Employee position:",
        recordsBefore + 1,
        "→ Page:",
        employeePage,
      );

      return res.json({
        success: true,
        employeePage: employeePage,
        position: recordsBefore + 1,
        totalRecords: recordsBefore + 1,
      });
    }
    // ===== END FIND EMPLOYEE PAGE LOGIC =====

    // Get total count with all filters
    const countQuery = `
      SELECT COUNT(*) as total
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      ${whereClause}
    `;

    const [countResult] = await pool.query(countQuery, params);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limit);

    // Get paginated results with all filters
    const dataQuery = `
      SELECT hr.Empl_ID, hr.Title, hr.Surname, hr.OtherName, tt.rank_order
      FROM hr_employees hr
      LEFT JOIN py_title tt ON tt.Titlecode = hr.Title
      ${whereClause}
      ORDER BY tt.rank_order DESC, hr.Empl_ID ASC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.query(dataQuery, [...params, limit, offset]);

    await attachRelationshipCounts(rows);

    console.log(
      "🔍 Search returned:",
      rows.length,
      "of",
      totalRecords,
      "total records",
    );

    res.json({
      success: true,
      data: rows,
      payrollClass,
      searchTerm: searchTerm,
      rankFilter: rankFilter,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        limit: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error("❌ Search error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Grade step calculation
router.get("/employees/:id/grade-step", verifyToken, async (req, res) => {
  try {
    const employeeId = req.params.id.replace(/_SLASH_/g, "/");

    // Get employee's gradelevel and datepmted
    const [employee] = await pool.query(
      "SELECT gradelevel, datepmted, gradetype, Location FROM hr_employees WHERE Empl_ID = ?",
      [employeeId],
    );

    if (!employee || employee.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Employee not found" });
    }

    // Grade level + step (falls back to the stored grade level)
    res.json({
      success: true,
      data: await computeGradeStep(employee[0]),
    });
  } catch (error) {
    console.error("❌ Grade step calculation error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single employee (no payroll class filter needed - specific ID lookup)
router.get("/employees/:id", verifyToken, async (req, res) => {
  try {
    const employeeId = req.params.id.replace(/_SLASH_/g, "/");

    // Existing employee query...
    const [employees] = await pool.query(
      "SELECT * FROM hr_employees WHERE Empl_ID = ?",
      [employeeId],
    );

    if (employees.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Employee not found",
      });
    }

    const employee = employees[0];

    // Grade level + step (falls back to the stored grade level)
    const gradeStepData = await computeGradeStep(employee);

    // Get related data (children, NOK, spouse)...
    const [children] = await pool.query(
      "SELECT * FROM children WHERE Empl_ID = ? AND chactive = 1",
      [employeeId],
    );

    const [nextOfKin] = await pool.query(
      "SELECT * FROM nextofkin WHERE Empl_ID = ? AND IsActive = 1",
      [employeeId],
    );

    const [spouse] = await pool.query(
      "SELECT * FROM spouse WHERE Empl_ID = ? AND spactive = 1",
      [employeeId],
    );

    res.json({
      success: true,
      data: {
        employee: employee,
        children: children,
        nextOfKin: nextOfKin,
        spouse: spouse,
        gradeStep: gradeStepData,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching employee:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Validation (no payroll class filter - checking uniqueness across all classes)
router.get("/employees/check/:field/:value", verifyToken, async (req, res) => {
  const { field, value } = req.params;
  const { exclude } = req.query;

  const allowedFields = ["Empl_ID"];
  if (!allowedFields.includes(field)) {
    return res.status(400).json({ error: "Invalid field" });
  }

  try {
    let query = `SELECT ${field} FROM hr_employees WHERE ${field} = ?`;
    let params = [value];

    if (exclude) {
      query += " AND Empl_ID != ?";
      params.push(exclude);
    }

    const [existing] = await pool.query(query, params);

    res.json({ exists: existing.length > 0 });
  } catch (err) {
    console.error(`Error checking ${field}:`, err);
    res.status(500).json({ error: "Database error" });
  }
});

// POST create employee - AUTO-ASSIGN PAYROLL CLASS
router.post("/employees", verifyToken, async (req, res) => {
  try {
    console.log("=== CREATE EMPLOYEE ===");

    const currentDb = pool.getCurrentDatabase(req.user_id.toString());
    const payrollClass = await getPayrollClassFromDb(currentDb);

    console.log("🔍 Current database:", currentDb);
    console.log("🔍 Auto-assigning payroll class:", payrollClass);
    console.log("Received fields:", Object.keys(req.body));
    console.log("Passport present?", !!req.body.passport);

    if (req.body.passport) {
      console.log("Passport length:", req.body.passport.length);
    }

    // Add created_by and payroll class automatically
    const createdBy = req.user_fullname || "System";
    req.body.createdby = createdBy;
    req.body.payrollclass = payrollClass; // ← AUTO-ASSIGN based on current DB

    const fields = Object.keys(req.body);
    const values = Object.values(req.body);
    const placeholders = fields.map(() => "?").join(", ");

    const query = `INSERT INTO hr_employees (${fields.join(", ")}) VALUES (${placeholders})`;
    console.log("Executing query with", fields.length, "fields");
    console.log("✅ Payroll class assigned:", payrollClass);

    const [result] = await pool.query(query, values);

    console.log("Insert successful, ID:", req.body.Empl_ID);

    res.status(201).json({
      success: true,
      message: "New Personnel created successfully",
      employeeId: req.body.Empl_ID,
      payrollClass: payrollClass,
      created_by: createdBy,
    });
  } catch (error) {
    console.error("CREATE ERROR:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT update employee (no payroll class modification allowed)
router.put("/employees/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id.replace(/_SLASH_/g, "/");

    console.log("=== UPDATE EMPLOYEE ===");
    console.log("Employee ID:", id);
    console.log("Received fields:", Object.keys(req.body));

    // Prevent payroll class from being modified
    if (req.body.payrollclass) {
      delete req.body.payrollclass;
      console.log("⚠️ Removed payrollclass from update - cannot be modified");
    }

    console.log("Passport present?", !!req.body.passport);

    if (req.body.passport) {
      console.log("Passport length:", req.body.passport.length);
    }

    const fields = Object.keys(req.body);
    const values = Object.values(req.body);
    const setClause = fields.map((field) => `${field} = ?`).join(", ");

    const query = `UPDATE hr_employees SET ${setClause} WHERE Empl_ID = ?`;
    const [result] = await pool.query(query, [...values, id]);

    console.log("Affected rows:", result.affectedRows);

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    }

    res.json({ success: true, message: "Personnel updated successfully" });
  } catch (error) {
    console.error("UPDATE ERROR:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE employee (cascades to related tables)
router.delete("/employees/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id.replace(/_SLASH_/g, "/");

    const [result] = await pool.query(
      "DELETE FROM hr_employees WHERE Empl_ID = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    }

    res.json({
      success: true,
      message: "Personnel and all related records deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// CHILDREN CRUD OPERATIONS
// =============================================================================

// GET all children for an employee
router.get("/employees/:id/children", verifyToken, async (req, res) => {
  try {
    const id = req.params.id.replace(/_SLASH_/g, "/");
    const [rows] = await pool.query(
      "SELECT * FROM children WHERE Empl_ID = ? AND chactive = 1 ORDER BY dateofbirth",
      [id],
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST create new child
router.post("/employees/:id/children", verifyToken, async (req, res) => {
  try {
    // Convert URL-safe format back to actual employee ID
    const id = req.params.id.replace(/_SLASH_/g, "/");

    console.log("📝 Creating child for employee:", id);

    // Verify employee exists
    const [employeeCheck] = await pool.query(
      "SELECT Empl_ID FROM hr_employees WHERE Empl_ID = ?",
      [id],
    );

    if (employeeCheck.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Employee not found",
        message: `Employee with ID ${id} does not exist in the system`,
      });
    }

    const childData = {
      ...req.body,
      Empl_ID: id, // Use the converted ID
    };

    const fields = Object.keys(childData);
    const values = Object.values(childData);
    const placeholders = fields.map(() => "?").join(", ");

    const query = `INSERT INTO children (${fields.join(", ")}) VALUES (${placeholders})`;
    const [result] = await pool.query(query, values);

    console.log("✅ Child created successfully, ID:", result.insertId);

    res.status(201).json({
      success: true,
      message: "Child record created successfully",
      childId: result.insertId,
      employeeId: id,
    });
  } catch (error) {
    console.error("❌ Child creation failed:", error.message);

    if (error.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(400).json({
        success: false,
        error: "Foreign key constraint failed",
        message: "The specified employee does not exist",
      });
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// PUT update child
router.put("/children/:childId", verifyToken, async (req, res) => {
  try {
    const fields = Object.keys(req.body);
    const values = Object.values(req.body);
    const setClause = fields.map((field) => `${field} = ?`).join(", ");

    const query = `UPDATE children SET ${setClause} WHERE child_id = ?`;
    const [result] = await pool.query(query, [...values, req.params.childId]);

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Child record not found" });
    }

    res.json({ success: true, message: "Child record updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE child (soft delete by setting chactive = 0)
router.delete("/children/:childId", verifyToken, async (req, res) => {
  try {
    const [result] = await pool.query(
      "UPDATE children SET chactive = 0 WHERE child_id = ?",
      [req.params.childId],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Child record not found" });
    }

    res.json({ success: true, message: "Child record deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// NEXT OF KIN CRUD OPERATIONS
// =============================================================================

// GET all next of kin for an employee
router.get("/employees/:id/nextofkin", verifyToken, async (req, res) => {
  try {
    const id = req.params.id.replace(/_SLASH_/g, "/");
    const [rows] = await pool.query(
      "SELECT * FROM nextofkin WHERE Empl_ID = ? AND IsActive = 1 ORDER BY NextofkinType DESC, FirstName",
      [id],
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST create new next of kin
router.post("/employees/:id/nextofkin", verifyToken, async (req, res) => {
  try {
    // Convert URL-safe format back to actual employee ID
    const id = req.params.id.replace(/_SLASH_/g, "/");

    console.log("📝 Creating NOK for employee:", id);
    console.log("📝 Original URL param:", req.params.id);

    // First, verify the employee exists
    const [employeeCheck] = await pool.query(
      "SELECT Empl_ID FROM hr_employees WHERE Empl_ID = ?",
      [id],
    );

    if (employeeCheck.length === 0) {
      console.error("❌ Employee not found:", id);
      return res.status(404).json({
        success: false,
        error: "Employee not found",
        message: `Employee with ID ${id} does not exist in the system`,
      });
    }

    console.log("✅ Employee found:", employeeCheck[0].Empl_ID);

    // Build the NOK data with the correct Empl_ID
    const nokData = {
      ...req.body,
      Empl_ID: id, // Use the converted ID, not the URL param
    };

    // Validate required fields
    const requiredFields = [
      "FirstName",
      "LastName",
      "RShipcode",
      "MobileNumber",
    ];
    const missingFields = requiredFields.filter((field) => !nokData[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
        message: `Please provide: ${missingFields.join(", ")}`,
      });
    }

    const fields = Object.keys(nokData);
    const values = Object.values(nokData);
    const placeholders = fields.map(() => "?").join(", ");

    const query = `INSERT INTO nextofkin (${fields.join(", ")}) VALUES (${placeholders})`;

    console.log("🔄 Executing query with Empl_ID:", id);

    const [result] = await pool.query(query, values);

    console.log("✅ NOK created successfully, ID:", result.insertId);

    res.status(201).json({
      success: true,
      message: "Next of kin record created successfully",
      nokId: result.insertId,
      employeeId: id,
    });
  } catch (error) {
    console.error("❌ NOK creation failed:", error.message);

    // Handle specific database errors
    if (error.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(400).json({
        success: false,
        error: "Foreign key constraint failed",
        message: "The specified employee does not exist",
      });
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        error: "Duplicate entry",
        message: "This next of kin record already exists",
      });
    }

    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  }
});

// PUT update next of kin
router.put("/nextofkin/:nokId", verifyToken, async (req, res) => {
  try {
    const fields = Object.keys(req.body);
    const values = Object.values(req.body);
    const setClause = fields.map((field) => `${field} = ?`).join(", ");

    const query = `UPDATE nextofkin SET ${setClause} WHERE nok_id = ?`;
    const [result] = await pool.query(query, [...values, req.params.nokId]);

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Next of kin record not found" });
    }

    res.json({
      success: true,
      message: "Next of kin record updated successfully",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE next of kin (soft delete by setting IsActive = 0)
router.delete("/nextofkin/:nokId", verifyToken, async (req, res) => {
  try {
    const [result] = await pool.query(
      "UPDATE nextofkin SET IsActive = 0 WHERE nok_id = ?",
      [req.params.nokId],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Next of kin record not found" });
    }

    res.json({
      success: true,
      message: "Next of kin record deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// SPOUSE CRUD OPERATIONS
// =============================================================================

// GET all spouse records for an employee
router.get("/employees/:id/spouse", verifyToken, async (req, res) => {
  try {
    const id = req.params.id.replace(/_SLASH_/g, "/");
    const [rows] = await pool.query(
      "SELECT * FROM spouse WHERE Empl_ID = ? AND spactive = 1 ORDER BY marrieddate DESC",
      [id],
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST create new spouse record
router.post("/employees/:id/spouse", verifyToken, async (req, res) => {
  try {
    // Convert URL-safe format back to actual employee ID
    const id = req.params.id.replace(/_SLASH_/g, "/");

    console.log("📝 Creating spouse for employee:", id);

    // Verify employee exists
    const [employeeCheck] = await pool.query(
      "SELECT Empl_ID FROM hr_employees WHERE Empl_ID = ?",
      [id],
    );

    if (employeeCheck.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Employee not found",
        message: `Employee with ID ${id} does not exist in the system`,
      });
    }

    const spouseData = {
      ...req.body,
      Empl_ID: id, // Use the converted ID
    };

    const fields = Object.keys(spouseData);
    const values = Object.values(spouseData);
    const placeholders = fields.map(() => "?").join(", ");

    const query = `INSERT INTO spouse (${fields.join(", ")}) VALUES (${placeholders})`;
    const [result] = await pool.query(query, values);

    console.log("✅ spouse created successfully, ID:", result.insertId);

    res.status(201).json({
      success: true,
      message: "spouse record created successfully",
      spouseId: result.insertId,
      employeeId: id,
    });
  } catch (error) {
    console.error("❌ spouse creation failed:", error.message);

    if (error.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(400).json({
        success: false,
        error: "Foreign key constraint failed",
        message: "The specified employee does not exist",
      });
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// PUT update spouse
router.put("/spouse/:spouseId", verifyToken, async (req, res) => {
  try {
    const fields = Object.keys(req.body);
    const values = Object.values(req.body);
    const setClause = fields.map((field) => `${field} = ?`).join(", ");

    const query = `UPDATE spouse SET ${setClause} WHERE spouse_id = ?`;
    const [result] = await pool.query(query, [...values, req.params.spouseId]);

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "spouse record not found" });
    }

    res.json({ success: true, message: "spouse record updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE spouse (soft delete by setting spactive = 0)
router.delete("/spouse/:spouseId", verifyToken, async (req, res) => {
  try {
    const [result] = await pool.query(
      "UPDATE spouse SET spactive = 0 WHERE spouse_id = ?",
      [req.params.spouseId],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "spouse record not found" });
    }

    res.json({ success: true, message: "spouse record deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// BULK OPERATIONS
// =============================================================================

// GET complete family profile (employee + all related records)
router.get("/employees/:id/profile", verifyToken, async (req, res) => {
  try {
    const [employee] = await pool.query(
      "SELECT * FROM hr_employees WHERE Empl_ID = ?",
      [req.params.id],
    );

    if (employee.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    }

    const [children] = await pool.query(
      `SELECT *, YEAR(CURDATE()) - YEAR(dateofbirth) as age 
       FROM children WHERE Empl_ID = ? AND chactive = 1 
       ORDER BY dateofbirth`,
      [req.params.id],
    );

    const [nextOfKin] = await pool.query(
      `SELECT * FROM nextofkin WHERE Empl_ID = ? AND IsActive = 1 
       ORDER BY NextofkinType DESC, FirstName`,
      [req.params.id],
    );

    const [spouse] = await pool.query(
      `SELECT * FROM spouse WHERE Empl_ID = ? AND spactive = 1 
       ORDER BY marrieddate DESC`,
      [req.params.id],
    );

    res.json({
      success: true,
      data: {
        employee: employee[0],
        family: {
          children: children,
          nextOfKin: nextOfKin,
          spouse: spouse,
          summary: {
            totalchildren: children.length,
            totalNOK: nextOfKin.length,
            totalspouse: spouse.length,
          },
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE all family records for an employee (soft delete)
router.delete("/employees/:id/family", verifyToken, async (req, res) => {
  try {
    await pool.query("UPDATE children SET chactive = 0 WHERE Empl_ID = ?", [
      req.params.id,
    ]);
    await pool.query("UPDATE nextofkin SET IsActive = 0 WHERE Empl_ID = ?", [
      req.params.id,
    ]);
    await pool.query("UPDATE spouse SET spactive = 0 WHERE Empl_ID = ?", [
      req.params.id,
    ]);

    res.json({
      success: true,
      message: "All family records deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
