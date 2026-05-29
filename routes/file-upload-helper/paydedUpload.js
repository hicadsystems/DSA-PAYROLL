// batchDeductionUploadRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const pool = require("../../config/db"); // mysql2 pool
const verifyToken = require("../../middware/authentication");
const {
  parseCSVFile,
  deduplicate,
  normalize,
  generateBatchName,
} = require("../../utils/excel_helper");
const config = require("../../config");

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      "batch-deduction-" + uniqueSuffix + path.extname(file.originalname),
    );
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [".xlsx", ".xls", ".csv"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .xlsx, .xls, and .csv files are allowed"));
    }
  },
});

// Field mapping from Excel/CSV headers to database columns
const FIELD_MAPPING = {
  svc_no: "Empl_id",
  payment_type: "type",
  amount_payable: "amtp",
  payment_indicator: "payind",
  ternor: "nomth",
};

const PAYCLASS_MAPPING = {
  1: config.databases.officers,
  2: config.databases.wofficers,
  3: config.databases.ratings,
  4: config.databases.ratingsA,
  5: config.databases.ratingsB,
  6: config.databases.juniorTrainee,
};

// Helper function to parse Excel file
function parseExcelFile(filePath) {
  const workbook = XLSX.readFile(filePath);

  const allData = [];

  for (const sheetName of workbook.SheetNames) {
    // if sheetName has INACTIVE or NONEXISTENT, skip it
    if (
      sheetName.toLowerCase().includes("inactive") ||
      sheetName.toLowerCase().includes("nonexistent") ||
      sheetName.toLowerCase().includes("instruction")
    ) {
      console.log(`⚠️ Skipping sheet "${sheetName}" due to name filter`);
      continue;
    }
    const worksheet = workbook.Sheets[sheetName];
    // Convert entire sheet to JSON with row arrays
    const sheetData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1, // Return arrays instead of objects
      defval: "", // Default value for empty cells
    });

    if (sheetData.length < 5) continue; // update to adequate number

    // Row 4 (index 3) contains the actual column headers
    const headers = sheetData[3];
    const validHeaders = headers?.filter((h) => h?.toString().trim() !== "");

    if (!validHeaders || validHeaders.length === 0) {
      throw new Error(`No headers found in row 4 of sheet "${sheetName}"`);
    }

    // Rows 5+ (index 4+) contain the actual data
    const dataRows = sheetData.slice(4);

    const data = dataRows
      .filter((row) => {
        // Skip completely empty rows
        if (!row || row.length === 0) return false;

        // Skip rows where all cells are empty
        const hasData = row.some((cell) => {
          return (
            cell !== null &&
            cell !== undefined &&
            cell !== "" &&
            String(cell)?.trim() !== ""
          );
        });

        return hasData;
      })
      .map((row, rowIndex) => {
        const obj = {};
        headers.forEach((header, colIndex) => {
          if (header && header.toString().trim() !== "") {
            const cellValue = row[colIndex];
            // Convert cell value to string and trim, or use empty string
            obj[header.toString().trim()] =
              cellValue !== null && cellValue !== undefined
                ? String(cellValue).trim()
                : "";
          }
        });
        return obj;
      });

    allData.push(...data);
  }

  return allData;
}

// Helper function to map fields
function mapFields(row, defaultCreatedBy) {
  const mappedRow = {};

  Object.keys(row).forEach((key) => {
    const trimmedKey = key.trim();
    const dbField = FIELD_MAPPING[trimmedKey];

    if (dbField) {
      let value = row[key];

      // Trim string values
      if (typeof value === "string") {
        value = value.trim();
      }

      // Convert numeric strings to numbers for amount fields
      if (dbField === "amtp" && value) {
        value = Number(value) || 0;
      }

      // Convert numeric strings to integers for nomth
      if (dbField === "nomth" && value) {
        value = Number(value) || 0;
      }

      mappedRow[dbField] = value || null;
    }
  });

  // Set defaults
  mappedRow.mak1 = "";
  mappedRow.mak2 = "";
  mappedRow.amt = 0;
  mappedRow.amttd = 0;
  if (!mappedRow.nomth) mappedRow.nomth = 0;
  mappedRow.createdby = defaultCreatedBy; // Always use the dynamic value from req.user_fullname

  mappedRow.pay_class = row.pay_class || row.payclass || null; // to determine DB context later
  return mappedRow;
}

// Validate required fields
function validateRow(row, rowIndex) {
  const errors = [];
  const requiredFields = ["Empl_id", "type", "amtp", "payind"];

  requiredFields.forEach((field) => {
    if (!row[field] || row[field].toString().trim() === "") {
      errors.push(`Row ${rowIndex + 2}: Missing required field "${field}"`);
    }
  });

  // Validate numeric fields
  if (row.amtp && (isNaN(row.amtp) || row.amtp < 0)) {
    errors.push(`Row ${rowIndex + 2}: Invalid amount payable (amtp)`);
  }

  // Validate nomth
  if (row.nomth && (isNaN(row.nomth) || row.nomth < 0)) {
    errors.push(`Row ${rowIndex + 2}: Invalid ternor value (nomth)`);
  }

  return errors;
}

// Check for duplicate deductions in DB
async function checkDuplicates(deductions, connection = pool) {
  if (deductions.length === 0) return [];

  const conditions = deductions
    .map(() => "(Empl_id = ? AND type = ?)")
    .join(" OR ");
  const values = deductions.flatMap((d) => [d.Empl_id, d.type]);

  const query = `
    SELECT Empl_id, type 
    FROM py_payded 
    WHERE ${conditions}
  `;

  const [results] = await connection.query(query, values);
  return results.map((row) => `${row.Empl_id}-${row.type}`);
}

// Insert deduction record
async function insertDeduction(data, connection = pool) {
  const query = `
    INSERT INTO py_payded (
      Empl_id, type, mak1, amtp, mak2, amt, amttd, payind, nomth, createdby, datecreated, batchName
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
  `;

  const [result] = await connection.query(query, [
    data.Empl_id,
    data.type,
    data.mak1,
    data.amtp,
    data.mak2,
    data.amt,
    data.amttd,
    data.payind,
    data.nomth,
    data.createdby,
    data.batchName || null,
  ]);

  return result;
}

// POST: Batch upload endpoint
router.post(
  "/batch-upload",
  verifyToken,
  upload.single("file"),
  async (req, res) => {
    let filePath = null;
    let connection = null; // ADD THIS - declare connection at top level

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      filePath = req.file.path;
      const fileExt = path.extname(req.file.originalname).toLowerCase();
      const createdBy = req.user_fullname || "SYSTEM";

      const originalBatchame = req?.body?.batchName?.trim() || "";
      const hasBatchName = !!originalBatchame;
      const batchName = hasBatchName
        ? originalBatchame
        : generateBatchName("PAYDED", createdBy);

      // Parse and clean file
      let rawData;
      if (fileExt === ".csv") {
        rawData = (await parseCSVFile(filePath)).map(normalize);
      } else {
        rawData = parseExcelFile(filePath).map(normalize);
        console.log("raw data", rawData);
      }

      if (!rawData || rawData.length === 0) {
        return res.status(400).json({ error: "File is empty or invalid" });
      }
      rawData = rawData?.filter((row) => Object.keys(row).length > 0);

      const { cleaned, duplicates } = deduplicate(rawData);

      console.log(cleaned);

      // THEN SET DATABASE CONTEXT
      const currentDb = pool.getCurrentDatabase(req.user_id.toString());
      console.log("📊 Using database:", currentDb);

      console.log("📤 Uploaded by:", createdBy);

      // Validate rows
      // Map Excel/CSV fields to database fields and validate simultaneously
      const validationErrors = [];
      const mappedData = cleaned.map((row, index) => {
        const mapped = mapFields(row, createdBy);
        const errors = validateRow(mapped, index);
        validationErrors.push(...errors);
        return mapped;
      });

      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: "Validation failed",
          details: validationErrors,
        });
      }

      const results = {
        totalRecords: mappedData.length,
        duplicates: [],
        inserted: 0,
        successful: 0,
        failed: 0,
        errors: [],
      };

      // DB work starts
      // map by payclass and switch context
      const payclassMap = new Map();
      for (const row of mappedData) {
        const payclass = row.pay_class;
        if (!payclassMap.has(payclass)) {
          payclassMap.set(payclass, []);
        }
        payclassMap.get(payclass).push(row);
      }

      for (const [payclass, payclassData] of payclassMap) {
        console.log(
          `🔄 Processing payclass: ${payclass} with ${payclassData.length} records`,
        );

        const db = PAYCLASS_MAPPING[payclass];
        if (!db) {
          console.warn(
            `No database mapping for payclass ${payclass}, skipping`,
          );

          results.failed += payclassData.length;
          results.errors.push(
            ...payclassData.map((row, idx) => ({
              row: idx + 5,
              serviceNumber: row.Empl_id,
              deductionType: row.type,
              payclass: payclass,
              error: `No database mapping for payclass ${payclass}`,
            })),
          );
          continue;
        }

        try {
          connection = await pool.getConnection();
          await connection.query(`USE ??`, [db]);

          // Check for DB duplicates (Empl_id + type combination)

          const duplicateKeys = await checkDuplicates(payclassData, connection);

          // Filter out duplicates

          const uniqueData = payclassData.filter((row) => {
            const key = `${row.Empl_id}-${row.type}`;
            return !duplicateKeys.includes(key);
          });

          // Insert only unique deductions
          for (let i = 0; i < uniqueData.length; i++) {
            try {
              uniqueData[i].batchName = batchName;
              await insertDeduction(uniqueData[i], connection);
              results.successful++;
              results.inserted++;
            } catch (error) {
              results.failed++;
              results.errors.push({
                row: i + 5,
                serviceNumber: uniqueData[i].Empl_id,
                deductionType: uniqueData[i].type,
                payclass: payclass,
                error: error.message,
              });
            }
          }

          results.failed += duplicateKeys.length;

          // Push duplicates as soft errors for frontend visibility
          if (duplicateKeys.length > 0) {
            results.duplicates.push(...duplicateKeys);
            results.errors.push(
              ...duplicateKeys.map((key) => {
                const [emplId, type] = key.split("-");
                return {
                  row: null,
                  serviceNumber: emplId,
                  deductionType: type,
                  payclass: payclass,
                  error: "Already exists (duplicate)",
                };
              }),
            );
          }
        } finally {
          if (connection) {
            connection.release();
            connection = null;
          }
        }
      }

      // Clean up file
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      return res.status(200).json({
        message: "Batch payment and deduction upload completed",
        summary: {
          ...results,
          batchName: results.successful > 0 ? batchName : undefined,
        },
      });
    } catch (error) {
      console.error("Batch payment and deduction upload error:", error);
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

      if (connection) {
        connection.release();
      }

      return res.status(500).json({
        error: "Batch payment and deduction upload failed",
        details: error.message,
      });
    }
  },
);

// GET: Download sample template with ExcelJS
router.get("/batch-template", verifyToken, async (req, res) => {
  try {
    // Create workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Payment-Deductions", {
      views: [{ state: "frozen", ySplit: 4 }], // Freeze first 4 rows
    });

    // Add main header - Row 1
    worksheet.mergeCells("A1:F1");
    const mainHeader = worksheet.getCell("A1");
    mainHeader.value = "Nigerian Navy (Naval Headquarters)";
    mainHeader.font = {
      name: "Arial",
      size: 13,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    mainHeader.alignment = { horizontal: "center", vertical: "middle" };
    mainHeader.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" }, // Dark navy blue
    };
    mainHeader.border = {
      bottom: { style: "thin", color: { argb: "FF000000" } },
    };
    worksheet.getRow(1).height = 22;

    // Add sub header - Row 2
    worksheet.mergeCells("A2:F2");
    const subHeader = worksheet.getCell("A2");
    subHeader.value = "CENTRAL PAY OFFICE, 23 POINT ROAD, APAPA";
    subHeader.font = {
      name: "Arial",
      size: 11,
      bold: true,
      color: { argb: "FF000000" },
    };
    subHeader.alignment = { horizontal: "center", vertical: "middle" };
    subHeader.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD9D9D9" }, // Medium gray
    };
    subHeader.border = {
      bottom: { style: "thin", color: { argb: "FF000000" } },
    };
    worksheet.getRow(2).height = 18;

    // Empty row 3
    worksheet.getRow(3).height = 5;

    // Column headers - Row 4
    const headers = [
      "Svc. No.",
      "Payment Type",
      "Amount Payable",
      "Payment Indicator",
      "Ternor",
      "Pay Class",
    ];

    const headerRow = worksheet.getRow(4);
    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = {
        name: "Arial",
        size: 10,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      cell.alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF2E5C8A" }, // Darker blue
      };
      cell.border = {
        top: { style: "thin", color: { argb: "FF000000" } },
        left: { style: "thin", color: { argb: "FFFFFFFF" } },
        bottom: { style: "thin", color: { argb: "FF000000" } },
        right: { style: "thin", color: { argb: "FFFFFFFF" } },
      };
    });
    headerRow.height = 19.5;

    // Sample data - Row 5
    const sampleData = [
      "NN001", // Service Number
      "PT330", // Payment Type
      "5000.00", // Amount Payable
      "T", // Payment Indicator
      "12", // Ternor
      "1", // Pay Class
    ];

    const dataRow = worksheet.getRow(5);
    sampleData.forEach((value, index) => {
      const cell = dataRow.getCell(index + 1);
      cell.value = value;
      cell.font = { name: "Arial", size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = {
        top: { style: "thin", color: { argb: "FFD3D3D3" } },
        left: { style: "thin", color: { argb: "FFD3D3D3" } },
        bottom: { style: "thin", color: { argb: "FFD3D3D3" } },
        right: { style: "thin", color: { argb: "FFD3D3D3" } },
      };
    });
    dataRow.height = 22;

    // Add a few more empty rows with borders
    for (let rowNum = 6; rowNum <= 10; rowNum++) {
      const emptyRow = worksheet.getRow(rowNum);
      headers.forEach((_, index) => {
        const cell = emptyRow.getCell(index + 1);
        cell.border = {
          top: { style: "thin", color: { argb: "FFD3D3D3" } },
          left: { style: "thin", color: { argb: "FFD3D3D3" } },
          bottom: { style: "thin", color: { argb: "FFD3D3D3" } },
          right: { style: "thin", color: { argb: "FFD3D3D3" } },
        };
      });
      emptyRow.height = 22;
    }

    // Set column widths
    worksheet.columns = [
      { key: "serviceNumber", width: 18 },
      { key: "paymentType", width: 18 },
      { key: "amountPayable", width: 18 },
      { key: "paymentIndicator", width: 18 },
      { key: "ternor", width: 15 },
      { key: "payClass", width: 15 },
    ];

    // Add data validation
    // Payment Indicator column (D)
    worksheet.getCell("D5").dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"T,P"'],
      showErrorMessage: true,
      errorTitle: "Invalid Payment Indicator",
      error: "Please select T (Temporary) or P (Permanent)",
    };

    // Add instructions sheet
    const instructionsSheet = workbook.addWorksheet("Instructions");

    instructionsSheet.mergeCells("A1:D1");
    const instrHeader = instructionsSheet.getCell("A1");
    instrHeader.value =
      "INSTRUCTIONS FOR FILLING THE PAYMENT & DEDUCTIONS TEMPLATE";
    instrHeader.font = { size: 13, bold: true, color: { argb: "FFFFFFFF" } };
    instrHeader.alignment = { horizontal: "center", vertical: "middle" };
    instrHeader.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" },
    };
    instructionsSheet.getRow(1).height = 25;
    instructionsSheet.getRow(2).height = 10;

    const instructions = [
      "1. Do not modify the header rows (rows 1-4)",
      "2. Fill data starting from row 5",
      "3. Service Number: Employee service number (e.g., NN001)",
      "4. Payment Type: Valid payment type code (e.g., PT330)",
      "5. Amount Payable: Numeric value (e.g., 5000.00)",
      "6. Payment Indicator: T (Temporary) or P (Permanent)",
      "7. Ternor: Number of months (e.g., 12)",
      "8. Pay Class: Valid pay class code (e.g., 1)",
      "9. All fields are required",
      //'10. CreatedBy field will be automatically filled with your username'
    ];

    instructions.forEach((instruction, index) => {
      const cell = instructionsSheet.getCell(`A${index + 3}`);
      cell.value = instruction;
      cell.font = { name: "Arial", size: 11 };
      cell.alignment = { horizontal: "left", vertical: "middle" };
    });

    instructionsSheet.getColumn("A").width = 70;

    // Generate Excel file
    const buffer = await workbook.xlsx.writeBuffer();

    // Send file
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=payment-deductions_template.xlsx",
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.send(buffer);
  } catch (error) {
    console.error("Error generating template:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to generate template" });
  }
});

// GET: Batch upload history
router.get("/list-batch", verifyToken, async (req, res) => {
  try {
    const page = Number(req.query?.page) || 1;
    const limit = Number(req.query?.limit) || 10;
    const offset = (page - 1) * limit;

    const searchTerm = req.query.search?.trim() || "";
    const hasSearch = searchTerm.length > 0;
    const searchPattern = `%${searchTerm}%`;

    const query = `
      SELECT batchName,
        GROUP_CONCAT(
          DISTINCT LOWER(TRIM(createdby))
          ORDER BY LOWER(TRIM(createdby))
          SEPARATOR ', '
        ) AS createdByList,
        MAX(datecreated) AS latestDateCreated
      FROM py_payded
      WHERE batchName IS NOT NULL
        AND TRIM(batchName) <> ''
        ${hasSearch ? "AND LOWER(batchName) LIKE LOWER(?)" : ""}
      GROUP BY batchName
      ORDER BY latestDateCreated DESC
      LIMIT ? OFFSET ?;
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM (
        SELECT batchName
        FROM py_payded
        WHERE batchName IS NOT NULL
          AND TRIM(batchName) <> ''
          ${hasSearch ? "AND LOWER(batchName) LIKE LOWER(?)" : ""}
        GROUP BY batchName
      ) AS grouped;
    `;

    // Build params dynamically based on whether search is active
    const queryParams = hasSearch
      ? [searchPattern, limit, offset]
      : [limit, offset];
    const countParams = hasSearch ? [searchPattern] : [];

    const [[batches], [countResults]] = await Promise.all([
      pool.query(query, queryParams),
      pool.query(countQuery, countParams),
    ]);

    const totalRecords = countResults[0].total;
    const totalPages = Math.ceil(totalRecords / limit);
    const results = batches.map((batch) => ({
      batchName: batch.batchName,
      uploadedBy: batch.createdByList,
      createdAt: batch.latestDateCreated,
      batchOriginal: batch.batchName,
    }));

    return res.status(200).json({
      success: true,
      data: results,
      pagination: {
        currentPage: page,
        recordsPerPage: limit,
        totalRecords,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Failed to fetch batch history:", error);
    return res.status(500).json({
      error: "Failed to fetch batch history",
      details: error.message,
    });
  }
});

// GET: Records with Batch Name
router.get("/batch-list/:batchName", verifyToken, async (req, res) => {
  try {
    const batchName = req?.params?.batchName; // to be sanitized
    if (typeof batchName !== "string") {
      return res.status(400).json({
        error: "Batch Name must be a string",
      });
    }
    if (!batchName.trim()) {
      return res.status(400).json({
        error: "Batch Name Must Not Be Empty",
      });
    }

    const page = Number(req.query?.page) || 1;
    const limit = Number(req.query?.limit) || 10;
    const offset = (page - 1) * limit;

    const query = `
      SELECT 
        p.Empl_id,
        p.type,
        p.amtp AS amount_payable,
        p.payind AS indicator,
        p.nomth AS months_remaining,
        pi.inddesc AS ind_desc
      FROM py_payded p
      LEFT JOIN py_payind pi 
        ON p.payind = pi.ind
      WHERE batchName = ?
      ORDER BY p.Empl_id, p.type
      LIMIT ? OFFSET ?;
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM py_payded
      WHERE batchName = ?;
    `;

    const [[batches], [countResults]] = await Promise.all([
      pool.query(query, [batchName.trim(), limit, offset]),
      pool.query(countQuery, [batchName.trim()]),
    ]);

    const totalRecords = countResults[0].total;
    const totalPages = Math.ceil(totalRecords / limit);
    const results = batches.map((batch) => {
      return {
        id: batch.Empl_id,
        type: batch.type,
        amount_payable: Number(batch.amount_payable) || 0,
        months_remaining: batch.months_remaining,
        indicator: batch.ind_desc,
      };
    });

    return res.status(200).json({
      success: true,
      data: results,
      pagination: {
        currentPage: page,
        recordsPerPage: limit,
        totalRecords,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Failed to fetch batch history:", error);
    return res.status(500).json({
      error: "Failed to fetch batch history",
      details: error.message,
    });
  }
});

// DELETE: Delete Batch Payded
router.delete("/batch-delete", verifyToken, async (req, res) => {
  try {
    const batchName = req?.body?.batchName; // to be sanitized
    if (typeof batchName !== "string") {
      return res.status(400).json({
        error: "Batch Name must be a string",
      });
    }
    if (!batchName.trim()) {
      return res.status(400).json({
        error: "Batch Name Must Not Be Empty",
      });
    }

    const deleteQuery = `DELETE FROM py_payded WHERE batchName = ?`;
    await pool.query(deleteQuery, [batchName]);

    return res.status(204).json({
      success: true,
      message: `Batch "${batchName}" deleted successfully`,
    });
  } catch (error) {
    console.error("Failed to delete batch:", error);
    return res.status(500).json({
      error: "Failed to delete batch",
      details: error.message,
    });
  }
});

// Error handling middleware
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File size exceeds 10MB limit" });
    }
    return res.status(400).json({ error: error.message });
  }

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  next();
});

module.exports = router;
