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
const queryRoutes = require('./routes/queries');
const auditRoutes = require('./routes/audit');
const roleRoutes = require('./routes/roles');
const analysisRoutes = require('./routes/analysis');
const chatRoutes = require('./routes/chats');
const feedbackRoutes = require('./routes/feedback');
const publicChatRoutes = require('./routes/publicChat');
const whatsappRoutes = require('./routes/whatsapp');
const developerApiRoutes = require('./routes/developerApi');

const app = express();

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));
app.use(express.json({ limit: '5mb' }));
app.use(morgan('combined'));
app.use(express.static('public'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Public Integration Routes (WhatsApp + Chatbot Widget — no auth required)
app.use('/api/public', publicChatRoutes);
app.use('/api/public/whatsapp', whatsappRoutes);

// API Routes
app.use('/api/v1', analysisRoutes);
app.use('/api/v1', developerApiRoutes);
app.use('/api/v1/chats', chatRoutes);
app.use('/api/v1/feedback', feedbackRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/queries', queryRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/roles', roleRoutes);

// Swagger Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`ZeroQueries On-Prem API running on port ${PORT}`);
});

module.exports = app;
