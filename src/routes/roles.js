const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const db = require('../config/database');

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, description FROM roles ORDER BY name'
    );

    res.json({
      success: true,
      roles: result.rows
    });
  } catch (error) {
    console.error('Fetch roles error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch roles'
    });
  }
});

module.exports = router;