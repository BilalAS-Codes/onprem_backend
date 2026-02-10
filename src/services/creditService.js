const db = require('../config/database');

const creditService = {
  /**
   * Get active quota assignment for organization
   */
  async getActiveQuota(organizationId) {
    const result = await db.query(
      `SELECT * FROM organization_quota_assignments
       WHERE organization_id = $1 
         AND is_active = true 
         AND expiration_date > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [organizationId]
    );
    return result.rows[0] || null;
  },

  /**
   * Check if organization has sufficient credits
   */
  async hasCredits(organizationId, requiredPoints = 1) {
    const quota = await this.getActiveQuota(organizationId);
    
    if (!quota) {
      return { 
        allowed: false, 
        reason: 'No active quota plan. Please subscribe.' 
      };
    }

    if (quota.remaining_points < requiredPoints) {
      return { 
        allowed: false, 
        reason: `Insufficient credits. Required: ${requiredPoints}, Available: ${quota.remaining_points}` 
      };
    }

    return { allowed: true, quota };
  },

  /**
   * Deduct credits after successful query
   */
  async deductCredits(organizationId, pointsToDeduct = 1, metadata = {}) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // Get current quota with row lock
      const quotaResult = await client.query(
        `SELECT * FROM organization_quota_assignments
         WHERE organization_id = $1 
           AND is_active = true 
           AND expiration_date > NOW()
         FOR UPDATE`,
        [organizationId]
      );

      if (quotaResult.rows.length === 0) {
        throw new Error('No active quota found');
      }

      const quota = quotaResult.rows[0];
      const pointsBefore = parseFloat(quota.remaining_points);
      const pointsAfter = pointsBefore - pointsToDeduct;

      if (pointsAfter < 0) {
        throw new Error('Insufficient credits');
      }

      // Update quota
      await client.query(
        `UPDATE organization_quota_assignments
         SET remaining_points = $1,
             remaining_queries = remaining_queries - 1,
             updated_at = NOW()
         WHERE id = $2`,
        [pointsAfter, quota.id]
      );

      // Log transaction in ledger
      await client.query(
        `INSERT INTO credit_ledger (
          organization_id, quota_assignment_id, transaction_type,
          points_before, points_after, points_changed,
          reference_type, reference_id, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          organizationId,
          quota.id,
          'deduction',
          pointsBefore,
          pointsAfter,
          -pointsToDeduct,
          metadata.reference_type || 'query',
          metadata.reference_id || null,
          JSON.stringify(metadata)
        ]
      );

      // Update usage_tracker
      await client.query(
        `INSERT INTO usage_tracker (
          organization_id, month, query_count, successful_query
         ) VALUES ($1, DATE_TRUNC('month', NOW()), 1, 1)
         ON CONFLICT (organization_id, month) 
         DO UPDATE SET 
           query_count = usage_tracker.query_count + 1,
           successful_query = usage_tracker.successful_query + 1,
           updated_at = NOW()`,
        [organizationId]
      );

      await client.query('COMMIT');

      return {
        success: true,
        pointsBefore,
        pointsAfter,
        pointsDeducted: pointsToDeduct
      };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Allocate credits on plan purchase/renewal (ChatGPT model)
   */
  async allocateCredits(organizationId, planId, paymentId) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // Get plan details
      const planResult = await client.query(
        'SELECT * FROM quota_plans WHERE id = $1',
        [planId]
      );

      if (planResult.rows.length === 0) {
        throw new Error('Plan not found');
      }

      const plan = planResult.rows[0];

      // Check for existing active quota
      const existingQuota = await client.query(
        `SELECT * FROM organization_quota_assignments
         WHERE organization_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 1`,
        [organizationId]
      );

      const effectiveDate = new Date();
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 30); // 30-day subscription

      if (existingQuota.rows.length > 0) {
        // RENEWAL: Update existing row (ChatGPT model)
        const quota = existingQuota.rows[0];
        const pointsBefore = parseFloat(quota.remaining_points);

        await client.query(
          `UPDATE organization_quota_assignments
           SET assigned_points_limit = $1,
               assigned_queries_limit = $2,
               remaining_points = $3,
               remaining_queries = $4,
               effective_date = $5,
               expiration_date = $6,
               is_active = true,
               updated_at = NOW()
           WHERE id = $7`,
          [
            plan.points_limit,
            plan.queries_limit,
            plan.points_limit, // Reset to full
            plan.queries_limit,
            effectiveDate,
            expirationDate,
            quota.id
          ]
        );

        // Log renewal in ledger
        await client.query(
          `INSERT INTO credit_ledger (
            organization_id, quota_assignment_id, transaction_type,
            points_before, points_after, points_changed,
            reference_type, reference_id, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            organizationId,
            quota.id,
            'reset',
            pointsBefore,
            plan.points_limit,
            plan.points_limit - pointsBefore,
            'payment',
            paymentId,
            JSON.stringify({ action: 'renewal', plan_id: planId })
          ]
        );

      } else {
        // NEW SUBSCRIPTION: Create new row
        const newQuotaResult = await client.query(
          `INSERT INTO organization_quota_assignments (
            organization_id, quota_plan_id,
            assigned_points_limit, assigned_queries_limit,
            remaining_points, remaining_queries,
            effective_date, expiration_date, is_active
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
           RETURNING *`,
          [
            organizationId,
            planId,
            plan.points_limit,
            plan.queries_limit,
            plan.points_limit,
            plan.queries_limit,
            effectiveDate,
            expirationDate
          ]
        );

        const newQuota = newQuotaResult.rows[0];

        // Log purchase in ledger
        await client.query(
          `INSERT INTO credit_ledger (
            organization_id, quota_assignment_id, transaction_type,
            points_before, points_after, points_changed,
            reference_type, reference_id, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            organizationId,
            newQuota.id,
            'purchase',
            0,
            plan.points_limit,
            plan.points_limit,
            'payment',
            paymentId,
            JSON.stringify({ action: 'new_subscription', plan_id: planId })
          ]
        );
      }

      await client.query('COMMIT');

      return { success: true };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Expire old quotas (run via cron)
   */
  async expireQuotas() {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      const expiredQuotas = await client.query(
        `SELECT * FROM organization_quota_assignments
         WHERE is_active = true 
           AND expiration_date <= NOW()`
      );

      for (const quota of expiredQuotas.rows) {
        await client.query(
          `UPDATE organization_quota_assignments
           SET is_active = false, updated_at = NOW()
           WHERE id = $1`,
          [quota.id]
        );

        await client.query(
          `INSERT INTO credit_ledger (
            organization_id, quota_assignment_id, transaction_type,
            points_before, points_after, points_changed,
            reference_type, reference_id, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            quota.organization_id,
            quota.id,
            'expiry',
            quota.remaining_points,
            0,
            -quota.remaining_points,
            'system',
            null,
            JSON.stringify({ reason: 'subscription_expired' })
          ]
        );
      }

      await client.query('COMMIT');

      return { expired: expiredQuotas.rows.length };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Get credit balance and usage stats
   */
  async getBalance(organizationId) {
    const quota = await this.getActiveQuota(organizationId);
    
    if (!quota) {
      return {
        active: false,
        remaining_points: 0,
        assigned_points_limit: 0,
        expiration_date: null
      };
    }

    return {
      active: true,
      remaining_points: parseFloat(quota.remaining_points),
      remaining_queries: quota.remaining_queries,
      assigned_points_limit: parseFloat(quota.assigned_points_limit),
      assigned_queries_limit: quota.assigned_queries_limit,
      effective_date: quota.effective_date,
      expiration_date: quota.expiration_date,
      usage_percentage: (
        (quota.assigned_points_limit - quota.remaining_points) / 
        quota.assigned_points_limit * 100
      ).toFixed(2)
    };
  }
};

module.exports = creditService;