const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * POST /api/v1/feedback
 * Body: { message_id: UUID, feedback: 'like' | 'dislike' }
 * Records user feedback on an AI assistant message.
 */
router.post('/', authenticateToken, async (req, res) => {
  const { message_id, feedback } = req.body;
  const { organization_id, id: user_id } = req.user;

  if (!message_id || !['like', 'dislike'].includes(feedback)) {
    return res.status(400).json({
      success: false,
      error: 'message_id and feedback ("like" or "dislike") are required'
    });
  }

  try {
    // Update feedback column on the message
    await db.query(
      'UPDATE chat_messages SET feedback = $1 WHERE id = $2',
      [feedback, message_id]
    );

    // Upsert into feedback audit log
    await db.query(
      `INSERT INTO response_feedback_logs (organization_id, user_id, message_id, feedback)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id, user_id)
       DO UPDATE SET feedback = EXCLUDED.feedback`,
      [organization_id, user_id, message_id, feedback]
    );

    console.log(`[FEEDBACK] user=${user_id} message=${message_id} feedback=${feedback}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[FEEDBACK] Error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
