const AuditLog = require('../models/AuditLog');

const auditLog = (action, target, metadata = {}) => {
  return async (req, res, next) => {
    // Store original send function
    const originalSend = res.send;
    
    res.send = function(data) {
      // Don't await this - fire and forget
      AuditLog.create({
        organization_id: req.user?.organization_id,
        user_id: req.user?.id,
        action,
        target,
        metadata: {
          ...metadata,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          requestBody: req.body,
          // Don't include full response in metadata to avoid large logs
          response_type: typeof data
        }
      }).catch(error => {
        console.error('Audit log error:', error);
        // Don't throw error - audit logging shouldn't break the main flow
      });
      
      originalSend.call(this, data);
    };
    
    next();
  };
};

module.exports = { auditLog };