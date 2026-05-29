// batchDocumentationRoutes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const pool = require("../../config/db"); // mysql2 pool
const verifyToken = require("../../middware/authentication");

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "batch-doc-" + uniqueSuffix + path.extname(file.originalname));
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
  "Svc. No.": "doc_numb",
  "Period(yyyymm)": "doc_year", // will be split into doc_year + doc_month below
  Signal: "doc_ref",
  Remarks: "doc_remark",
};

// Helper: Parse Excel file (headers on row 4, data from row 5)
function parseExcelFile(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  const allData = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: true,
    defval: "",
  });

  const headers = allData[3]; // Row 4 (0-indexed = 3)

  if (!headers || headers.length === 0) {
    throw new Error("No headers found in row 4");
  }

  console.log("📋 Detected headers:", headers);

  const dataRows = allData.slice(4); // Data starts from row 5

  const data = dataRows
    .filter((row) => {
      if (!row || row.length === 0) return false;
      return row.some(
        (cell) => cell !== null && cell !== undefined && cell !== "",
      );
    })
    .map((row) => {
      const obj = {};
      headers.forEach((header, colIndex) => {
        if (header && header.toString().trim() !== "") {
          const cellValue = row[colIndex];
          obj[header.toString().trim()] =
            cellValue !== null && cellValue !== undefined ? cellValue : "";
        }
      });
      return obj;
    });

  console.log("✅ Parsed data rows:", data.length);
  return data;
}

// Helper: Parse CSV file
function parseCSVFile(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => resolve(results))
      .on("error", (error) => reject(error));
  });
}

// Helper: Map fields from raw row to DB columns
function mapFields(row, createdBy, datecreated) {
  const mappedRow = {};

  Object.keys(row).forEach((key) => {
    const trimmedKey = key.trim();

    // Special case: Period(yyyymm) → doc_year + doc_month
    if (trimmedKey === "Period(yyyymm)") {
      const period = row[key] ? row[key].toString().trim() : "";
      if (period.length === 6) {
        mappedRow.doc_year = period.substring(0, 4); // First 4 digits = year
        mappedRow.doc_month = period.substring(4, 6); // Last 2 digits = month
      } else {
        mappedRow.doc_year = null;
        mappedRow.doc_month = null;
      }
      return;
    }

    const dbField = FIELD_MAPPING[trimmedKey];
    if (dbField) {
      let value = row[key];
      if (typeof value === "string") {
        value = value.trim();
      }
      mappedRow[dbField] = value || null;
    }
  });

  // System fields — same pattern as personnel upload
  mappedRow.createdby = createdBy;
  mappedRow.datecreated = datecreated;

  return mappedRow;
}

// Helper: Validate a mapped row
function validateRow(row, rowIndex) {
  const errors = [];
  const requiredFields = ["doc_numb"];

  requiredFields.forEach((field) => {
    if (!row[field] || row[field].toString().trim() === "") {
      errors.push(`Row ${rowIndex + 5}: Missing required field "${field}"`);
    }
  });

  return errors;
}

// Helper: Check for duplicate doc_numb + doc_ref combinations in DB
async function checkDuplicates(documentationList) {
  if (documentationList.length === 0) return [];

  const placeholders = documentationList.map(() => "(?, ?)").join(",");
  const params = documentationList.flatMap((d) => [d.doc_numb, d.doc_ref]);

  const query = `
    SELECT doc_numb, doc_ref 
    FROM py_documentation 
    WHERE (doc_numb, doc_ref) IN (${placeholders})
  `;

  const [results] = await pool.query(query, params);
  return results.map((row) => `${row.doc_numb}::${row.doc_ref}`);
}

// Helper: Insert a single documentation record
async function insertDocumentation(data) {
  const fields = Object.keys(data);
  const values = Object.values(data);
  const placeholders = fields.map(() => "?").join(", ");

  const query = `
    INSERT INTO py_documentation (${fields.join(", ")}) 
    VALUES (${placeholders})
  `;

  const [result] = await pool.query(query, values);
  return result;
}

// =============================================================================
// POST: Batch upload documentation
// =============================================================================
router.post(
  "/batch-upload",
  verifyToken,
  upload.single("file"),
  async (req, res) => {
    let filePath = null;

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      filePath = req.file.path;
      const fileExt = path.extname(req.file.originalname).toLowerCase();
      const createdBy = req.user_fullname || "SYSTEM";

      // Parse file
      let rawData;
      if (fileExt === ".csv") {
        rawData = await parseCSVFile(filePath);
      } else {
        rawData = parseExcelFile(filePath);
      }

      if (!rawData || rawData.length === 0) {
        return res.status(400).json({ error: "File is empty or invalid" });
      }

      console.log("📊 Total rows parsed:", rawData.length);

      // Map and validate
      const validationErrors = [];
      const mappedData = rawData.map((row, index) => {
        const mapped = mapFields(row, createdBy);

        if (index === 0) {
          console.log("🔍 First mapped row:", mapped);
        }

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

      // Check duplicates
      const duplicateKeys = await checkDuplicates(mappedData);

      // Filter out duplicates (composite key: doc_numb + doc_ref)
      const uniqueData = mappedData.filter(
        (row) => !duplicateKeys.includes(`${row.doc_numb}::${row.doc_ref}`),
      );

      const results = {
        totalRecords: mappedData.length,
        duplicates: duplicateKeys,
        inserted: uniqueData.length,
        successful: 0,
        failed: 0,
        errors: [],
      };

      // Insert records
      for (let i = 0; i < uniqueData.length; i++) {
        try {
          await insertDocumentation(uniqueData[i]);
          results.successful++;
        } catch (error) {
          results.failed++;
          results.errors.push({
            row: i + 5,
            serviceNumber: uniqueData[i].doc_numb,
            error: error.message,
          });
          console.error(
            `❌ Failed to insert ${uniqueData[i].doc_numb}:`,
            error.message,
          );
        }
      }

      // Add duplicates to failed count
      results.failed += results.duplicates.length;

      if (results.duplicates.length > 0) {
        results.errors.push(
          ...results.duplicates.map((compositeKey) => {
            const [docNumb, docRef] = compositeKey.split("::");
            return {
              row: null,
              serviceNumber: docNumb,
              signal: docRef,
              error: "Already exists (duplicate Svc. No. + Signal combination)",
            };
          }),
        );
      }

      // Clean up uploaded file
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      console.log("✅ Batch documentation upload complete:", results);

      return res.status(200).json({
        message: "Batch documentation upload completed",
        summary: results,
      });
    } catch (error) {
      console.error("Documentation batch upload error:", error);
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

      return res.status(500).json({
        error: "Documentation batch upload failed",
        details: error.message,
      });
    }
  },
);

// =============================================================================
// GET: Download sample documentation template
// =============================================================================
router.get("/batch-template", verifyToken, async (req, res) => {
  const ExcelJS = require("exceljs");

  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Documentation", {
      views: [{ state: "frozen", ySplit: 4 }],
    });

    // Row 1 — Main header
    worksheet.mergeCells("A1:D1");
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
      fgColor: { argb: "FF1F4E78" },
    };
    mainHeader.border = {
      bottom: { style: "thin", color: { argb: "FF000000" } },
    };
    worksheet.getRow(1).height = 22;

    // Row 2 — Sub header
    worksheet.mergeCells("A2:D2");
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
      fgColor: { argb: "FFD9D9D9" },
    };
    subHeader.border = {
      bottom: { style: "thin", color: { argb: "FF000000" } },
    };
    worksheet.getRow(2).height = 18;

    // Row 3 — Empty spacer
    worksheet.getRow(3).height = 5;

    // Row 4 — Column headers
    const headers = ["Svc. No.", "Period(yyyymm)", "Signal", "Remarks"];

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
        fgColor: { argb: "FF2E5C8A" },
      };
      cell.border = {
        top: { style: "thin", color: { argb: "FF000000" } },
        left: { style: "thin", color: { argb: "FFFFFFFF" } },
        bottom: { style: "thin", color: { argb: "FF000000" } },
        right: { style: "thin", color: { argb: "FFFFFFFF" } },
      };
    });
    headerRow.height = 19.5;

    // Row 5 — Sample data
    const sampleData = [
      "NN001",
      "202501",
      "SIG/001/2025",
      "Sample documentation remark",
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

    // Rows 6-10 — Empty bordered rows for visual guidance
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

    // Column widths
    worksheet.columns = [
      { key: "serviceNumber", width: 12 },
      { key: "period", width: 16 },
      { key: "signal", width: 20 },
      { key: "remarks", width: 40 },
    ];

    // Instructions sheet
    const instructionsSheet = workbook.addWorksheet("Instructions");

    instructionsSheet.mergeCells("A1:D1");
    const instrHeader = instructionsSheet.getCell("A1");
    instrHeader.value = "INSTRUCTIONS FOR FILLING THE DOCUMENTATION TEMPLATE";
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
      "3. Svc. No. is required (e.g., NN001)",
      "4. Period must be in YYYYMM format (e.g., 202501 for January 2025)",
      "5. Signal is the reference or signal number for the documentation",
      "6. Remarks is optional additional notes for the record",
    ];

    instructions.forEach((instruction, index) => {
      const cell = instructionsSheet.getCell(`A${index + 3}`);
      cell.value = instruction;
      cell.font = { name: "Arial", size: 11 };
      cell.alignment = { horizontal: "left", vertical: "middle" };
    });

    instructionsSheet.getColumn("A").width = 60;

    // Send file
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Input_Documentation_Template.xlsx",
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

// Error handling middleware for multer
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
