const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

// Import routes
const authRoutes = require('./routes/auth');
const organizationRoutes = require('./routes/organizations');
const userRoutes = require('./routes/users');
const departmentRoutes = require('./routes/departments');
const databaseRoutes = require('./routes/database');
const schemaRoutes = require('./routes/schema');
const queryRoutes = require('./routes/queries');
const insightRoutes = require('./routes/insights');
const billingRoutes = require('./routes/billing');
const auditRoutes = require('./routes/audit');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('combined'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/db', databaseRoutes);
app.use('/api/schema', schemaRoutes);
app.use('/api/queries', queryRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/audit', auditRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ZeroQueries API server running on port ${PORT}`);
});

module.exports = app;