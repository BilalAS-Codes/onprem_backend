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
         AND expiration_date >= CURRENT_DATE
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

    if (quota.remaining_queries != null && quota.remaining_queries <= 0) {
      return {
        allowed: false,
        reason: 'Query limit reached for current period.'
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
           AND expiration_date >= CURRENT_DATE
         FOR UPDATE`,
        [organizationId]
      );

      if (quotaResult.rows.length === 0) {
        throw new Error('No active quota found');
      }

      const quota = quotaResult.rows[0];
      const pointsBefore = parseFloat(quota.remaining_points);
      const pointsAfter = pointsBefore - pointsToDeduct;
      const queriesBefore = quota.remaining_queries != null ? Number(quota.remaining_queries) : null;
      const queriesAfter = queriesBefore != null ? queriesBefore - 1 : null;

      if (pointsAfter < 0) {
        throw new Error('Insufficient credits');
      }
      if (queriesAfter != null && queriesAfter < 0) {
        throw new Error('Query limit reached');
      }

      // Update quota
      await client.query(
        `UPDATE organization_quota_assignments
         SET remaining_points = $1,
             remaining_queries = CASE
               WHEN remaining_queries IS NULL THEN NULL
               ELSE remaining_queries - 1
             END,
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
          JSON.stringify({
            ...metadata,
            queries_before: queriesBefore,
            queries_after: queriesAfter
          })
        ]
      );

      // Update usage tracking table if present (supports two naming variants)
      const usageTrackerExistsRes = await client.query(
        `SELECT to_regclass('public.usage_tracker') AS tracker_exists, to_regclass('public.usage_tracking') AS tracking_exists, to_regclass('public.usage_traking') AS traking_exists`








      );

      const existsRow = usageTrackerExistsRes.rows[0] || {};
      const trackerExists = existsRow.tracker_exists;
      const trackingExists = existsRow.tracking_exists;
      const trakingExists = existsRow.traking_exists;

      if (trackerExists) {
        // Try update first
        const updRes = await client.query(
          `UPDATE usage_tracker
           SET query_count = usage_tracker.query_count + 1,
               successful_query = usage_tracker.successful_query + 1,
               updated_at = NOW()
           WHERE organization_id = $1
             AND month = DATE_TRUNC('month', NOW())::date`,
          [organizationId]
        );

        if (updRes.rowCount === 0) {
          await client.query(
            `INSERT INTO usage_tracker (organization_id, month, query_count, successful_query)
             VALUES ($1, DATE_TRUNC('month', NOW()), 1, 1)`,
            [organizationId]
          );
        }
      } else if (trackingExists) {
        // usage_tracking has slightly different column names
        const monthStr = new Date().toISOString().slice(0,7); // YYYY-MM

        const updRes = await client.query(
          `UPDATE usage_tracking
           SET query_count = usage_tracking.query_count + 1,
               successful_queries = usage_tracking.successful_queries + 1,
               total_points_used = usage_tracking.total_points_used + $2,
               updated_at = NOW()
           WHERE organization_id = $1
             AND month = $3`,
          [organizationId, metadata.points_used || 0, monthStr]
        );

        if (updRes.rowCount === 0) {
          await client.query(
            `INSERT INTO usage_tracking (
              id, organization_id, month, query_count, successful_queries, total_points_used, created_at
             ) VALUES (gen_random_uuid(), $1, $2, 1, 1, $3, NOW())`,
            [organizationId, monthStr, metadata.points_used || 0]
          );
        }
      } else if (trakingExists) {
        // legacy misspelled table `usage_traking` — treat like `usage_tracking`
        const monthStr = new Date().toISOString().slice(0,7); // YYYY-MM

        const updRes = await client.query(
          `UPDATE usage_traking
           SET query_count = usage_traking.query_count + 1,
               successful_queries = usage_traking.successful_queries + 1,
               total_points_used = usage_traking.total_points_used + $2,
               updated_at = NOW()
           WHERE organization_id = $1
             AND month = $3`,
          [organizationId, metadata.points_used || 0, monthStr]
        );

        if (updRes.rowCount === 0) {
          await client.query(
            `INSERT INTO usage_traking (
              id, organization_id, month, query_count, successful_queries, total_points_used, created_at
             ) VALUES (gen_random_uuid(), $1, $2, 1, 1, $3, NOW())`,
            [organizationId, monthStr, metadata.points_used || 0]
          );
        }
      } else {
        console.info('No usage tracking table found; skipping usage tracking update');
      }

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
      console.info('allocateCredits called', { organizationId, planId, paymentId });
      await client.query('BEGIN');

      // Get plan details
      // Support passing either a quota_plans.id or a plans.id here.
      const originalPlanId = planId;
      let planResult = await client.query(
        'SELECT * FROM quota_plans WHERE id = $1',
        [planId]
      );

      if (planResult.rows.length === 0) {
        // Try mapping via plans table: attempt several fallbacks using the plans row
        const planRowRes = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);

        if (planRowRes.rows.length > 0) {
          const p = planRowRes.rows[0];
          // 1) exact name match (case-insensitive)
          let mapRes = await client.query(
            'SELECT * FROM quota_plans WHERE lower(plan_name) = lower($1)',
            [p.name]
          );

          // 2) partial name match
          if (mapRes.rows.length === 0 && p.name) {
            mapRes = await client.query(
              'SELECT * FROM quota_plans WHERE plan_name ILIKE $1',
              ['%' + p.name + '%']
            );
          }

          // 3) match by price if provided
          if (mapRes.rows.length === 0 && p.price_monthly != null) {
            mapRes = await client.query(
              'SELECT * FROM quota_plans WHERE monthly_price = $1',
              [p.price_monthly]
            );
          }

          // 4) match by query limit if provided
          if (mapRes.rows.length === 0 && p.query_limit != null) {
            mapRes = await client.query(
              'SELECT * FROM quota_plans WHERE queries_limit = $1',
              [p.query_limit]
            );
          }

          if (mapRes.rows.length > 0) {
            planResult = mapRes;
          } else {
            console.warn('plans row found but no matching quota_plans for plan id', planId, 'plan:', p);

            // As a last resort, create a quota_plans entry derived from the plans row
            try {
              const insertRes = await client.query(
                `INSERT INTO quota_plans (plan_name, description, points_limit, queries_limit, monthly_price, is_active)
                 VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
                [
                  p.name,
                  JSON.stringify(p.features || {}),
                  // Use query_limit as a reasonable default for points_limit when not specified
                  p.query_limit != null ? p.query_limit : 0,
                  p.query_limit != null ? p.query_limit : 0,
                  p.price_monthly != null ? p.price_monthly : null
                ]
              );

              if (insertRes.rows.length > 0) {
                console.info('Created quota_plans row from plans record', { created: insertRes.rows[0].id, planName: p.name });
                planResult = insertRes;
              }
            } catch (err) {
              console.error('Failed to create quota_plans from plans row:', err.message || err);
            }
          }
        } else {
          console.warn('No plans row found for id', planId);
        }
      }

      if (planResult.rows.length === 0) {
        console.warn('No quota_plans match by id or by plans mapping for id:', planId);
        throw new Error('Quota plan not found for provided plan id');
      }

      const plan = planResult.rows[0];
      const quotaPlanId = plan.id; // resolved quota_plans.id
      console.info('Resolved quota plan', { quotaPlanId, plan_name: plan.plan_name });

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
            JSON.stringify({ action: 'renewal', quota_plan_id: quotaPlanId, original_plan_reference: originalPlanId })
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
            quotaPlanId,
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
            JSON.stringify({ action: 'new_subscription', quota_plan_id: quotaPlanId, original_plan_reference: originalPlanId })
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
           AND expiration_date < CURRENT_DATE`
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
  ,

  /**
   * Grant free trial credits on signup
   */
  async grantFreeCredits(organizationId, { points = 10, queries = 10 } = {}) {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id FROM organization_quota_assignments
         WHERE organization_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 1`,
        [organizationId]
      );

      if (existing.rows.length) {
        await client.query('COMMIT');
        return { skipped: true };
      }

      let quotaPlanId = null;
      let qpRes = await client.query(
        `SELECT id FROM quota_plans WHERE lower(plan_name) = 'free trial' LIMIT 1`
      );

      if (qpRes.rows.length === 0) {
        qpRes = await client.query(
          `INSERT INTO quota_plans (plan_name, description, points_limit, queries_limit, monthly_price, is_active)
           VALUES ('Free Trial', 'Signup free credits', $1, $2, 0, true)
           RETURNING id`,
          [points, queries]
        );
      }

      quotaPlanId = qpRes.rows[0].id;

      const effectiveDate = new Date();
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 30);

      const quotaRes = await client.query(
        `INSERT INTO organization_quota_assignments (
          organization_id, quota_plan_id,
          assigned_points_limit, assigned_queries_limit,
          remaining_points, remaining_queries,
          effective_date, expiration_date, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         RETURNING id`,
        [
          organizationId,
          quotaPlanId,
          points,
          queries,
          points,
          queries,
          effectiveDate,
          expirationDate
        ]
      );

      await client.query(
        `INSERT INTO credit_ledger (
          organization_id, quota_assignment_id, transaction_type,
          points_before, points_after, points_changed,
          reference_type, reference_id, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          organizationId,
          quotaRes.rows[0].id,
          'bonus',
          0,
          points,
          points,
          'signup',
          null,
          JSON.stringify({ action: 'free_trial' })
        ]
      );

      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
};
module.exports=creditService;
