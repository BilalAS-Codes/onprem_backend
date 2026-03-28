const db = require('../config/database');

const chatController = {
  // Create a new chat conversation
  async createConversation(req, res) {
    try {
      const { title, connection_id } = req.body;
      const { organization_id, id: user_id } = req.user;

      console.log('🆕 Creating conversation:', { title, connection_id, user_id, organization_id });

      // Require an active database connection before starting chat
      const connectionResult = connection_id
        ? await db.query(
          `SELECT id FROM database_connections
           WHERE organization_id = $1 AND id = $2 AND status = 'connected'
           LIMIT 1`,
          [organization_id, connection_id]
        )
        : await db.query(
          `SELECT id FROM database_connections
           WHERE organization_id = $1 AND status = 'connected'
           LIMIT 1`,
          [organization_id]
        );

      if (!connectionResult.rows.length) {
        return res.status(400).json({
          error: 'Database connection not found. Please connect a database before starting chat.',
          code: 'db_not_connected'
        });
      }

      const result = await db.query(
        `INSERT INTO chat_conversations (organization_id, user_id, connection_id, title)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [organization_id, user_id, connection_id || null, title || 'New Chat']
      );

      console.log('✅ Conversation created:', result.rows[0].id);
      res.status(201).json({
        success: true,
        conversation: result.rows[0]
      });
    } catch (error) {
      console.error('❌ Create conversation error:', error.message);
      res.status(500).json({ error: 'Failed to create conversation', details: error.message });
    }
  },

  // Get all conversations for the user
  async getConversations(req, res) {
    try {
      const { organization_id, id: user_id } = req.user;
      const { limit = 50, offset = 0 } = req.query;

      console.log('📋 Fetching conversations:', { user_id, organization_id, limit, offset });

      const result = await db.query(
        `SELECT * FROM chat_conversations
         WHERE organization_id = $1 AND user_id = $2 AND is_archived = false
         ORDER BY updated_at DESC
         LIMIT $3 OFFSET $4`,
        [organization_id, user_id, parseInt(limit), parseInt(offset)]
      );

      const countResult = await db.query(
        `SELECT COUNT(*) FROM chat_conversations
         WHERE organization_id = $1 AND user_id = $2 AND is_archived = false`,
        [organization_id, user_id]
      );

      console.log('✅ Found conversations:', result.rows.length);
      res.json({
        success: true,
        conversations: result.rows,
        pagination: {
          total: parseInt(countResult.rows[0].count),
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      });
    } catch (error) {
      console.error('❌ Get conversations error:', error.message);
      res.status(500).json({ error: 'Failed to fetch conversations', details: error.message });
    }
  },

  // Get a specific conversation with all messages
  async getConversation(req, res) {
    try {
      const { id } = req.params;
      const { organization_id, id: user_id } = req.user;

      console.log('📖 Getting conversation:', { id, user_id, organization_id });

      // Verify conversation belongs to user
      const convCheck = await db.query(
        `SELECT * FROM chat_conversations
         WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
        [id, organization_id, user_id]
      );

      if (convCheck.rows.length === 0) {
        console.error('❌ Conversation not found:', { id, organization_id, user_id });
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Get all messages
      const messagesResult = await db.query(
        `SELECT * FROM chat_messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC`,
        [id]
      );

      console.log('✅ Retrieved conversation with messages:', messagesResult.rows.length);
      res.json({
        success: true,
        conversation: convCheck.rows[0],
        messages: messagesResult.rows
      });
    } catch (error) {
      console.error('❌ Get conversation error:', error.message);
      res.status(500).json({ error: 'Failed to fetch conversation', details: error.message });
    }
  },

  // Add a message to a conversation
  async addMessage(req, res) {
    try {
      const { conversation_id } = req.params;
      const { 
        role, 
        content, 
        analysis_data, 
        suggestions, 
        is_error = false, 
        error_message 
      } = req.body;
      const { organization_id, id: user_id } = req.user;

      console.log('📥 Adding message to conversation:', conversation_id);

      // Verify conversation exists and belongs to user
      const convCheck = await db.query(
        `SELECT * FROM chat_conversations
         WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
        [conversation_id, organization_id, user_id]
      );

      if (convCheck.rows.length === 0) {
        console.warn('⚠️ Conversation not found or deleted:', conversation_id);
        return res.status(404).json({ error: 'Conversation not found or has been deleted' });
      }

      const normalizedAnalysisData = analysis_data ? JSON.stringify(analysis_data) : null;
      const normalizedSuggestions = suggestions ? JSON.stringify(suggestions) : null;

      const latestMessageResult = await db.query(
        `SELECT *
         FROM chat_messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 10`,
        [conversation_id]
      );

      const duplicateMessage = latestMessageResult.rows.find((existingMessage) =>
        existingMessage.role === role &&
        String(existingMessage.content || '') === String(content || '') &&
        JSON.stringify(existingMessage.analysis_data || null) === JSON.stringify(analysis_data || null) &&
        JSON.stringify(existingMessage.suggestions || null) === JSON.stringify(suggestions || null) &&
        Boolean(existingMessage.is_error) === Boolean(is_error)
      );
      if (duplicateMessage) {
        return res.status(200).json({
          success: true,
          deduped: true,
          message: duplicateMessage
        });
      }

      // Insert message
      const messageResult = await db.query(
        `INSERT INTO chat_messages (
          conversation_id, role, content, analysis_data, suggestions, 
          is_error, error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *`,
        [
          conversation_id,
          role,
          content,
          normalizedAnalysisData,
          normalizedSuggestions,
          is_error,
          error_message
        ]
      );

      // Update conversation's last_message_at
      await db.query(
        `UPDATE chat_conversations 
         SET updated_at = CURRENT_TIMESTAMP, last_message_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [conversation_id]
      );

      // return inserted row

      console.log('✅ Message saved:', messageResult.rows[0].id);
      res.status(201).json({
        success: true,
        message: messageResult.rows[0]
      });
    } catch (error) {
      console.error('❌ Add message error:', error.message);
      res.status(500).json({ error: 'Failed to add message', details: error.message });
    }
  },

  // Update a message (e.g. replace placeholder with final analysis)
  async updateMessage(req, res) {
    try {
      const { conversation_id, message_id } = req.params;
      const { content, analysis_data, suggestions, is_error, error_message } = req.body;
      const { organization_id, id: user_id } = req.user;

      // ensure conversation belongs to user
      const convCheck = await db.query(
        `SELECT * FROM chat_conversations
         WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
        [conversation_id, organization_id, user_id]
      );
      if (convCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const updateResult = await db.query(
        `UPDATE chat_messages
         SET content = COALESCE($1, content),
             analysis_data = COALESCE($2, analysis_data),
             suggestions = COALESCE($3, suggestions),
             is_error = COALESCE($4, is_error),
             error_message = COALESCE($5, error_message)
         WHERE id = $6 AND conversation_id = $7
         RETURNING *`,
        [
          content,
          analysis_data ? JSON.stringify(analysis_data) : null,
          suggestions ? JSON.stringify(suggestions) : null,
          is_error,
          error_message,
          message_id,
          conversation_id
        ]
      );

      if (updateResult.rows.length === 0) {
        return res.status(404).json({ error: 'Message not found' });
      }

      res.json({ success: true, message: updateResult.rows[0] });
    } catch (error) {
      console.error('❌ Update message error:', error.message);
      res.status(500).json({ error: 'Failed to update message', details: error.message });
    }
  },

  // Get messages from a conversation
  async getMessages(req, res) {
    try {
      const { conversation_id } = req.params;
      const { organization_id, id: user_id } = req.user;
      const { limit = 100, offset = 0 } = req.query;

      console.log('📨 Fetching messages:', { conversation_id, limit, offset });

      // Verify conversation exists and belongs to user
      const convCheck = await db.query(
        `SELECT * FROM chat_conversations
         WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
        [conversation_id, organization_id, user_id]
      );

      if (convCheck.rows.length === 0) {
        console.error('❌ Conversation not found');
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const result = await db.query(
        `SELECT * FROM chat_messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [conversation_id, parseInt(limit), parseInt(offset)]
      );

      const countResult = await db.query(
        `SELECT COUNT(*) FROM chat_messages WHERE conversation_id = $1`,
        [conversation_id]
      );

      console.log('✅ Retrieved messages:', result.rows.length, 'of', countResult.rows[0].count);
      res.json({
        success: true,
        messages: result.rows.reverse(),
        pagination: {
          total: parseInt(countResult.rows[0].count),
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      });
    } catch (error) {
      console.error('❌ Get messages error:', error.message);
      res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
    }
  },

  // Update conversation title
  async updateConversation(req, res) {
    try {
      const { id } = req.params;
      const { title } = req.body;
      const { organization_id, id: user_id } = req.user;

      const result = await db.query(
        `UPDATE chat_conversations
         SET title = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND organization_id = $3 AND user_id = $4
         RETURNING *`,
        [title, id, organization_id, user_id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      res.json({
        success: true,
        conversation: result.rows[0]
      });
    } catch (error) {
      console.error('Update conversation error:', error);
      res.status(500).json({ error: 'Failed to update conversation' });
    }
  },

  // Archive a conversation
  async archiveConversation(req, res) {
    try {
      const { id } = req.params;
      const { organization_id, id: user_id } = req.user;

      const result = await db.query(
        `UPDATE chat_conversations
         SET is_archived = true, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND organization_id = $2 AND user_id = $3
         RETURNING *`,
        [id, organization_id, user_id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      res.json({
        success: true,
        message: 'Conversation archived successfully'
      });
    } catch (error) {
      console.error('Archive conversation error:', error);
      res.status(500).json({ error: 'Failed to archive conversation' });
    }
  },

  // Delete a conversation
  async deleteConversation(req, res) {
    try {
      const { id } = req.params;
      const { organization_id, id: user_id } = req.user;

      await db.query(
        `DELETE FROM chat_conversations
         WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
        [id, organization_id, user_id]
      );

      res.json({
        success: true,
        message: 'Conversation deleted successfully'
      });
    } catch (error) {
      console.error('Delete conversation error:', error);
      res.status(500).json({ error: 'Failed to delete conversation' });
    }
  }
};

module.exports = chatController;
