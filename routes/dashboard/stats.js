const express = require('express');
const router = express.Router();
const pool = require('../../config/db'); // mysql2 pool
const verifyToken = require('../../middware/authentication');

// ========================================================================
// HELPER: Get Payroll Class from Current Database
// ========================================================================
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
      'SELECT classcode FROM py_payrollclass WHERE db_name = ?',
      [dbName]
    );
    
    const result = rows.length > 0 ? rows[0].classcode : null;
    console.log('🔍 Database:', dbName, '→ Payroll Class:', result);
    return result;
  } finally {
    connection.release();
  }
}


router.get('/total-personnels', verifyToken, async (req, res) => {
  try {
    // Get database from pool using user_id as session
    const currentDb = pool.getCurrentDatabase(req.user_id.toString());
    const payrollClass = await getPayrollClassFromDb(currentDb);

    const query = `
      SELECT COUNT(*) AS totalPersonnels FROM hr_employees
      WHERE (exittype IS NULL OR exittype = '')
        AND (
          DateLeft IS NULL
          OR DateLeft = ''
          OR STR_TO_DATE(DateLeft, '%Y%m%d') > CURDATE()
        )
        AND payrollclass = ?
    `;

    const [result] = await pool.execute(query, [payrollClass]);

    res.json({
      success: true,
      data: result[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


// Get current payroll period
router.get('/payroll-period', verifyToken, async (req, res) => {
  try {
    const userId = req.user_id;
    const currentClass = req.current_class;
    
    if (!currentClass) {
      return res.status(400).json({ 
        success: false, 
        error: 'No active payroll class' 
      });
    }
    
    const [rows] = await pool.query(
      `SELECT ord AS year, mth AS month FROM ${currentClass}.py_stdrate WHERE type = 'BT05' LIMIT 1`
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Payroll period not found' 
      });
    }
    
    res.json({
      success: true,
      year: rows[0].year,
      month: rows[0].month
    });
    
  } catch (error) {
    console.error('Error fetching payroll period:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch payroll period' 
    });
  }
});

router.get('/nominal-processed', verifyToken, async (req, res) => {
  try {
    const currentClass = req.current_class;

    if (!currentClass) {
      return res.status(400).json({ success: false, error: 'No active payroll class' });
    }

    // Get BT05 config (sun, ord, mth, pmth)
    const [bt05Rows] = await pool.query(
      `SELECT sun, ord, mth, pmth FROM ${currentClass}.py_stdrate WHERE type = 'BT05' LIMIT 1`
    );

    if (bt05Rows.length === 0) {
      return res.status(404).json({ success: false, error: 'BT05 config not found' });
    }

    const { sun, ord, mth, pmth } = bt05Rows[0];

    // sun = 888 → use current month (mth), else use previous month (pmth)
    const useCurrentMonth = sun >= 888;
    const targetYear = ord;
    const targetMonth = useCurrentMonth ? mth : pmth;

    const [logRows] = await pool.query(
      `SELECT records_processed
       FROM ${currentClass}.py_performance_log
       WHERE procedure_name = 'sp_extractrec_optimized'
         AND process_year = ?
         AND process_month = ?
         AND status = 'SUCCESS'
       ORDER BY completed_at DESC
       LIMIT 1`,
      [targetYear, targetMonth]
    );

    const recordsProcessed = logRows.length > 0 ? logRows[0].records_processed : 0;

    res.json({
      success: true,
      data: {
        nominalProcessed: recordsProcessed,
        period: useCurrentMonth ? 'current' : 'previous',
        year: targetYear,
        month: targetMonth
      }
    });

  } catch (error) {
    console.error('Error fetching nominal processed:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch nominal processed' });
  }
});

module.exports = router;