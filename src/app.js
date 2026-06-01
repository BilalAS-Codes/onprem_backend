const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');



// Import routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const organizationRoutes = require('./routes/organizations');
const userRoutes = require('./routes/users');
const departmentRoutes = require('./routes/departments');
const databaseRoutes = require('./routes/database');
const schemaRoutes = require('./routes/schema');
const queryRoutes = require('./routes/queries');
const insightRoutes = require('./routes/insights');
const billingRoutes = require('./routes/billing');
const auditRoutes = require('./routes/audit');
const roleRoutes = require('./routes/roles');
const questionsRoutes = require('./routes/questions');
const analysisRoutes = require('./routes/analysis');
const chatRoutes = require('./routes/chats');
const integrationRoutes = require('./routes/integrations');
const publicChatRoutes = require('./routes/publicChat');
const developerApiRoutes = require('./routes/developerApi');
const whatsappRoutes = require('./routes/whatsapp');

const { startRaiseInvoicesJob } = require('./jobs/raiseInvoices');
const { startQuotaExpiryJob } = require('./jobs/expiryQuotas');


const app = express();

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: "*",
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));
app.use(express.json({ limit: "5mb" }));
app.use(morgan('combined'));
app.use(express.static('public'));


// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});
// express.json configured above with size limit


// Public Chat Widget Route (Must be before protected routes)
app.use('/api/public', publicChatRoutes);
app.use('/api/public/whatsapp', whatsappRoutes);

// Protected API Routes
// Developer API (Uses API Key Auth)
app.use('/api/v1', developerApiRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/db', databaseRoutes);
app.use('/api/schema', schemaRoutes);
app.use('/api/queries', queryRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/', questionsRoutes)
app.use('/api/v1', analysisRoutes);
app.use('/api/v1/chats', chatRoutes);
app.use('/api/v1/integrations', integrationRoutes);



// Swagger Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));


// Background jobs
startRaiseInvoicesJob();
startQuotaExpiryJob();

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`ZeroQueries API server running on port ${PORT}`);
});

module.exports = app;
