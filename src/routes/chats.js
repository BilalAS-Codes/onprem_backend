const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticateToken } = require('../middleware/auth');

// All chat routes require authentication
router.use(authenticateToken);

// Conversation routes
router.post('/',
  chatController.createConversation
);

router.get('/',
  chatController.getConversations
);

router.get('/:id',
  chatController.getConversation
);

router.put('/:id',
  chatController.updateConversation
);

router.post('/:id/archive',
  chatController.archiveConversation
);

router.delete('/:id',
  chatController.deleteConversation
);

// Message routes
router.post('/:conversation_id/messages',
  chatController.addMessage
);

router.get('/:conversation_id/messages',
  chatController.getMessages
);

// update existing message
router.put('/:conversation_id/messages/:message_id',
  chatController.updateMessage
);

module.exports = router;
