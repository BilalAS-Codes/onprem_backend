// middleware/adminAuth.js
const db = require('../config/database');

const authorizeAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if user is admin of their organization
    const userQuery = await db.query(
      `SELECT u.*, r.name as role_name 
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = $1 AND u.organization_id = $2`,
      [req.user.id, req.user.organization_id]
    );

    if (userQuery.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' });
    }

    const user = userQuery.rows[0];
    
    // Check if user has admin role
    if (user.role_name !== 'Admin' && user.role_name !== 'Super Admin') {
      return res.status(403).json({ 
        error: 'Admin access required. Only users with Admin role can access this dashboard.' 
      });
    }

    // Add admin info to req
    req.user.role = user.role_name;
    req.user.organization_id = user.organization_id;
    
    next();
  } catch (error) {
    console.error('Admin authorization error:', error);
    res.status(500).json({ error: 'Authorization check failed' });
  }
};

module.exports = { authorizeAdmin };