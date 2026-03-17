module.exports = {
  secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
  expiresIn: '24h', // Reverted back to 24 hours for production
  refreshSecret: process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key',
  refreshExpiresIn: '7d',
};

// Add this for compatibility with existing code
module.exports.jwtConfig = module.exports;