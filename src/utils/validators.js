const validator = {
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  },

  isValidPassword(password) {
    // At least 8 characters, 1 uppercase, 1 lowercase, 1 number
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    return passwordRegex.test(password);
  },

  isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  },

  sanitizeInput(input) {
    if (typeof input === 'string') {
      // Remove potentially harmful characters
      return input.replace(/[<>]/g, '');
    }
    return input;
  },

  validateDatabaseConnection(config) {
    const errors = [];

    if (!config.db_type || !['postgresql', 'mysql'].includes(config.db_type.toLowerCase())) {
      errors.push('Database type must be either postgresql or mysql');
    }

    if (!config.host || config.host.trim().length === 0) {
      errors.push('Host is required');
    }

    if (!config.port || isNaN(config.port) || config.port < 1 || config.port > 65535) {
      errors.push('Port must be a valid number between 1 and 65535');
    }

    if (!config.database_name || config.database_name.trim().length === 0) {
      errors.push('Database name is required');
    }

    if (!config.username || config.username.trim().length === 0) {
      errors.push('Username is required');
    }

    if (!config.password || config.password.trim().length === 0) {
      errors.push('Password is required');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
};

module.exports = validator;