const db = require('../config/database');

/**
 * Middleware to authenticate requests using an X-API-Key header.
 * This is used for the Developer API.
 */
async function authenticateApiKey(req, res, next) {
    const apiKey = req.header('X-API-Key');

    if (!apiKey) {
        return res.status(401).json({ error: 'X-API-Key header is required' });
    }

    try {
        const result = await db.query(
            `SELECT i.*, r.name as role_name 
             FROM integrations i 
             LEFT JOIN roles r ON i.target_role_id = r.id
             WHERE i.api_key = $1 AND i.is_enabled = true AND i.integration_type = 'developer_api'`,
            [apiKey]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid or disabled API key' });
        }

        const integration = result.rows[0];
        
        // Construct a virtual user object for downstream use
        req.user = {
            organization_id: integration.target_organization_id || integration.organization_id,
            role: integration.role_name || 'Viewer',
            department_id: integration.target_department_id,
            department_ids: Array.isArray(integration.target_department_ids) 
                ? integration.target_department_ids 
                : (integration.target_department_id ? [integration.target_department_id] : []),
            is_api_user: true
        };

        req.integration = integration;
        next();
    } catch (err) {
        console.error('API Key Auth Error:', err);
        res.status(500).json({ error: 'Authentication failed' });
    }
}

module.exports = { authenticateApiKey };
