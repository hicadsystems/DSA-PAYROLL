// ============================================================================
// FILE: routes/salaryHistoryRoutes.js
// Mount in app.js: app.use('/salary-history', require('./routes/salaryHistoryRoutes'));
// ============================================================================
const express    = require('express');
const router     = express.Router();
const SalaryHistoryController = require('../../controllers/Reports/salaryHistoryController');
const verifyToken = require('../../middware/authentication');
const historicalReportMiddleware = require('../../middware/historicalReportsmiddleware');

const controller = new SalaryHistoryController(null);

// ============================================
// POST /generate - Generate consolidated payslips
// ============================================
router.post('/generate', verifyToken, historicalReportMiddleware, (req, res) => {
  controller.generateSalaryHistory(req, res);
});

// ============================================
// POST /export/pdf - Generate PDF
// ============================================
router.post('/export/pdf', verifyToken, historicalReportMiddleware, (req, res) => {
  controller.generateSalaryHistoryPDF(req, res);
});

// ============================================
// POST /export/excel - Generate Excel
// ============================================
router.post('/export/excel', verifyToken, historicalReportMiddleware, (req, res) => {
  controller.generateSalaryHistoryExcel(req, res);
});


module.exports = router;