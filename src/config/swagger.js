const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'ZeroQueries API',
      version: '1.0.0',
      description: 'API documentation for the ZeroQueries B2B SaaS platform. This documentation covers data connection, file uploads, and billing workflows.',
      contact: {
        name: 'ZeroQueries Support',
        email: 'support@zeroqueries.com',
      },
    },
    servers: [
      {
        url: 'http://localhost:5000/api',
        description: 'Development server',
      },
      {
        url: 'https://api.zeroqueries.com/api',
        description: 'Production server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ['./src/routes/*.js'], // Path to the API docs in JSDoc comments
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
