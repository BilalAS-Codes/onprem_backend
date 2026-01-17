const express = require('express');
const router = express.Router();
const insightController = require('../controllers/insightController');

// Public route for shared insights (no authentication required)
router.get('/shared/:token',
  insightController.getSharedInsight
);

module.exports = router;