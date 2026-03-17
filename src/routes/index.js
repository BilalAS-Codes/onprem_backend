const express = require('express');
const router = express.Router();

// Import all route modules
const authRoutes = require('./auth');
const organizationRoutes = require('./organizations');
const userRoutes = require('./users');
const departmentRoutes = require('./departments');
const databaseRoutes = require('./database');
const schemaRoutes = require('./schema');
const queryRoutes = require('./queries');
const insightRoutes = require('./insights');
const billingRoutes = require('./billing');
const auditRoutes = require('./audit');
const chatRoutes = require('./chats');

// Mount routes
router.use('/auth', authRoutes);
router.use('/organizations', organizationRoutes);
router.use('/users', userRoutes);
router.use('/departments', departmentRoutes);
router.use('/db', databaseRoutes);
router.use('/schema', schemaRoutes);
router.use('/queries', queryRoutes);
router.use('/insights', insightRoutes);
router.use('/billing', billingRoutes);
router.use('/audit', auditRoutes);
router.use('/chats', chatRoutes);

module.exports = router;