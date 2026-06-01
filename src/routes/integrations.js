const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Middleware to ensure only admins can manage integrations
const isAdmin = (req, res, next) => {
    if (req.user.role !== 'Admin') {
        return res.status(403).json({ error: 'Only admins can manage integrations' });
    }
    next();
};

/**
 * GET /api/v1/integrations
 * List all integrations for the organization
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM integrations WHERE organization_id = $1 ORDER BY created_at DESC',
            [req.user.organization_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching integrations:', err);
        res.status(500).json({ error: 'Failed to fetch integrations' });
    }
});

/**
 * POST /api/v1/integrations
 * Create or update an integration
 */
router.post('/', authenticateToken, isAdmin, async (req, res) => {
    const { id, integration_type, config, is_enabled, allowed_domains, target_organization_id, target_role_id, target_department_id, target_department_ids } = req.body;
    const organization_id = req.user.organization_id;

    // Convert empty strings to null for UUID columns
    const t_org_id = target_organization_id || null;
    const t_role_id = target_role_id || null;
    const t_dept_id = target_department_id || (Array.isArray(target_department_ids) && target_department_ids.length > 0 ? target_department_ids[0] : null) || null;
    const t_dept_ids = Array.isArray(target_department_ids) ? JSON.stringify(target_department_ids) : JSON.stringify(target_department_id ? [target_department_id] : []);

    try {
        if (id) {
            // Update existing
            const result = await db.query(
                `UPDATE integrations 
                 SET config = $1, is_enabled = $2, allowed_domains = $3, 
                     target_organization_id = $4, target_role_id = $5, target_department_id = $6,
                     target_department_ids = $7,
                     updated_at = NOW()
                 WHERE id = $8 AND organization_id = $9
                 RETURNING *`,
                [config, is_enabled, allowed_domains, t_org_id, t_role_id, t_dept_id, t_dept_ids, id, organization_id]
            );
            res.json(result.rows[0]);
        } else {
            // Create new
            const result = await db.query(
                `INSERT INTO integrations (organization_id, integration_type, config, is_enabled, allowed_domains, target_organization_id, target_role_id, target_department_id, target_department_ids)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING *`,
                [organization_id, integration_type, config, is_enabled, allowed_domains, t_org_id, t_role_id, t_dept_id, t_dept_ids]
            );
            res.status(201).json(result.rows[0]);
        }
    } catch (err) {
        console.error('Error saving integration:', err);
        res.status(500).json({ error: 'Failed to save integration' });
    }
});

/**
 * GET /api/v1/integrations/logs
 * Fetch usage logs for integrations
 */
router.get('/logs', authenticateToken, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const filterType = req.query.integration_type;

    try {
        let countQuery = `
            SELECT COUNT(*) 
            FROM integration_logs l
            LEFT JOIN integrations i ON l.integration_id = i.id
            WHERE l.organization_id = $1
        `;
        let listQuery = `
            SELECT l.*, COALESCE(i.integration_type, CASE WHEN l.endpoint = '/api/v1/chat' THEN 'developer_api' ELSE 'website_chatbot' END) as integration_type
            FROM integration_logs l
            LEFT JOIN integrations i ON l.integration_id = i.id
            WHERE l.organization_id = $1
        `;

        const queryParams = [req.user.organization_id];

        if (filterType) {
            countQuery += ` AND COALESCE(i.integration_type, CASE WHEN l.endpoint = '/api/v1/chat' THEN 'developer_api' ELSE 'website_chatbot' END) = $2`;
            listQuery += ` AND COALESCE(i.integration_type, CASE WHEN l.endpoint = '/api/v1/chat' THEN 'developer_api' ELSE 'website_chatbot' END) = $2`;
            queryParams.push(filterType);
        }

        const countResult = await db.query(countQuery, queryParams);
        const total = parseInt(countResult.rows[0].count);

        listQuery += ` ORDER BY l.created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
        const listParams = [...queryParams, limit, offset];

        const result = await db.query(listQuery, listParams);

        res.json({
            logs: result.rows,
            pagination: {
                total,
                page,
                limit,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('Error fetching integration logs:', err);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

/**
 * DELETE /api/v1/integrations/:id
 * Delete an integration
 */
/**
 * GET /api/v1/integrations/metadata/roles
 * List all available roles
 */
router.get('/metadata/roles', authenticateToken, async (req, res) => {
    try {
        const result = await db.query('SELECT id, name FROM roles ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch roles' });
    }
});

/**
 * GET /api/v1/integrations/metadata/organizations
 * List only the user's own organization
 */
router.get('/metadata/organizations', authenticateToken, async (req, res) => {
    try {
        const result = await db.query('SELECT id, name FROM organizations WHERE id = $1', [req.user.organization_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch organization' });
    }
});

/**
 * GET /api/v1/integrations/metadata/departments/:orgId
 * List departments for an organization (Validated)
 */
router.get('/metadata/departments/:orgId', authenticateToken, async (req, res) => {
    try {
        // Security check: Ensure orgId matches user's organization
        if (req.params.orgId !== req.user.organization_id) {
            return res.status(403).json({ error: 'Unauthorized organization access' });
        }
        const result = await db.query('SELECT id, name FROM departments WHERE organization_id = $1 ORDER BY name', [req.params.orgId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch departments' });
    }
});

router.delete('/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        await db.query(
            'DELETE FROM integrations WHERE id = $1 AND organization_id = $2',
            [req.params.id, req.user.organization_id]
        );
        res.json({ success: true, message: 'Integration deleted' });
    } catch (err) {
        console.error('Error deleting integration:', err);
        res.status(500).json({ error: 'Failed to delete integration' });
    }
});

module.exports = router;

