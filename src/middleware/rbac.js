const authorize = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Insufficient permissions for this action' 
      });
    }
    next();
  };
};

// Role constants
const ROLES = {
  ADMIN: 'Admin',
  DEPARTMENT_USER: 'Department User',
  VIEWER: 'Viewer'
};

module.exports = { authorize, ROLES };