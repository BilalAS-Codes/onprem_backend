-- Create WhatsApp Conversations table to map WhatsApp users to stateful ZeroQueries sessions
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    sender_phone VARCHAR(50) NOT NULL,
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(integration_id, sender_phone)
);

-- Index for fast lookup by integration and sender
CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_lookup ON whatsapp_conversations(integration_id, sender_phone);
