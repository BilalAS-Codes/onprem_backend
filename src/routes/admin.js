// routes/admin.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { authorizeAdmin } = require('../middleware/adminauth');
const adminDashboardController = require('../controllers/adminDashboard.controller');

// GET /api/admin/dashboard - Get admin dashboard data
router.get(
  '/dashboard', 
  authenticateToken, 
  authorizeAdmin, 
  adminDashboardController.getDashboard.bind(adminDashboardController)
);

module.exports = router;