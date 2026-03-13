const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { connectToExternalDB } = require('../utils/externalDb');
const { pipeline } = require('stream');
const copyTo = require('pg-copy-streams').to;
const exportDb = require('../config/exportDb');
const { checkCredits } = require('../middleware/creditCheck');
const creditService = require('../services/creditService');

router.get('/questions', checkCredits, async (req, res) => {
  const { type, table, page = 1, limit = 10 } = req.query;
  const { organization_id } = req.user;

  const offset = (page - 1) * limit;

  try {
    if (!['narrative', 'kpi', 'export'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }

    if (type !== 'export' && !table) {
      return res.status(400).json({ error: 'Table name is required' });
    }

    /**
     * ==============================
     * ✅ PLAN ENFORCEMENT SECTION
     * ==============================
     */

    // 1️⃣ Get organization plan
    const planResult = await db.query(
      `
      SELECT p.query_limit
      FROM organizations o
      JOIN plans p ON o.plan_id = p.id
      WHERE o.id = $1
      `,
      [organization_id]
    );

    if (!planResult.rows.length) {
      return res.status(403).json({ error: 'No active plan found' });
    }

    const queryLimit = planResult.rows[0].query_limit;

    // 2️⃣ Count queries used this month
    // Use `credit_ledger` entries as the authoritative source for query usage
    const usageResult = await db.query(
      `
      SELECT COUNT(*)
      FROM credit_ledger
      WHERE organization_id = $1
        AND reference_type = 'query'
        AND created_at >= date_trunc('month', CURRENT_DATE)
      `,
      [organization_id]
    );

    const usedQueries = Number(usageResult.rows[0].count || 0);

    if (queryLimit !== null && usedQueries >= queryLimit) {
      return res.status(403).json({
        error: 'Monthly query limit exceeded'
      });
    }

    /**
     * ==============================
     * ✅ DATABASE CONNECTION CHECK
     * ==============================
     */
 const connectionResult = await db.query(
      `
      SELECT *
      FROM database_connections
      WHERE organization_id = $1
        AND status = 'connected'
      LIMIT 1
      `,
      [organization_id]
    );

    if (!connectionResult.rows.length) {
      return res.status(404).json({ error: 'No active database connection found' });
    }

    const connection = connectionResult.rows[0];
    const externalClient = await connectToExternalDB(connection);

    /**
     * ==============================
     * KPI QUERY
     * ==============================
     */
    if (type === 'kpi') {
      const kpiQuery = `
        SELECT COUNT(*) AS new_users_this_month

        FROM ${table}
        WHERE created_at >= date_trunc('month', CURRENT_DATE)
          AND created_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      `;

      const result = await externalClient.query(kpiQuery);


      await externalClient.end();


      await creditService.deductCredits(organization_id, 1, {
        reference_type: 'query',
        reference_id: `kpi_${Date.now()}`,
        query_type: 'kpi',
        table
      });

      return res.json({
        question: 'How many new users joined this month?',
        table,
        kpis: result.rows[0]
      });
    }
     if (type === 'export') {
      const range = req.query.range || '30d';
      let interval = range === '7d' ? '7 days' : '30 days';



      const fileName = `user_activity_${range}_${Date.now()}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );

      const client = await exportDb.getClient();

      const copyQuery = `
        COPY (
          SELECT id, user_id, action, target, metadata, created_at
          FROM audit_logs
          WHERE organization_id = '${organization_id}'
            AND created_at >= NOW() - INTERVAL '${interval}'
          ORDER BY created_at DESC
        )
        TO STDOUT WITH CSV HEADER
      `;

      const stream = client.query(copyTo(copyQuery));


      await creditService.deductCredits(organization_id, 1, {
        reference_type: 'query',
        reference_id: `export_${Date.now()}`,
        query_type: 'export',
        range
      });

      pipeline(stream, res, (err) => {
        client.release();
        if (err && !res.headersSent) {
          res.status(500).end();
        }
      });

      return;
    }
  /**
     * ==============================
     * NARRATIVE QUERY
     * ==============================
     */

    const dataQuery = `
      SELECT *
      FROM ${table}
      LIMIT $1 OFFSET $2
    `;

    const countQuery = `
      SELECT COUNT(*) FROM ${table}
    `;

    const [dataResult, countResult] = await Promise.all([
      externalClient.query(dataQuery, [limit, offset]),
      externalClient.query(countQuery)
    ]);



    await externalClient.end();


    await creditService.deductCredits(organization_id, 1, {
      reference_type: 'query',
      reference_id: `narrative_${Date.now()}`,
      query_type: 'narrative',
      table,
      rows_returned: dataResult.rows.length
    });

    return res.json({
      question: `Show data from ${table}`,
      table,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: Number(countResult.rows[0].count)
      },
      data: dataResult.rows
    });

  } catch (err) {
    console.error('External DB query error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
