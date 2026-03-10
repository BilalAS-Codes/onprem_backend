#!/usr/bin/env node
/**
 * Initialize Chat Database Tables
 * 
 * This script creates the required chat_conversations and chat_messages tables
 * Run this after setting up the backend for the first time
 * 
 * Usage: node scripts/init-chat-db.js
 */

require('dotenv').config();
const db = require('../src/config/database');

const SQL = `
-- Chat Conversations Table
CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES database_connections(id) ON DELETE SET NULL,
  title VARCHAR(255),
  description TEXT,
  is_archived BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_message_at TIMESTAMP
);

-- Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  analysis_data JSONB,
  suggestions JSONB,
  is_error BOOLEAN DEFAULT false,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_id ON chat_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_organization_id ON chat_conversations(organization_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_created_at ON chat_conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at DESC);
`;

const initializeTables = async () => {
  try {
    console.log('🔄 Initializing chat database tables...');
    
    // Split by semicolon and execute each statement
    const statements = SQL.split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    for (const statement of statements) {
      console.log(`📝 Executing: ${statement.substring(0, 50)}...`);
      await db.query(statement);
    }
    
    console.log('✅ Chat tables initialized successfully!');
    console.log('');
    console.log('📊 Tables created:');
    console.log('  - chat_conversations');
    console.log('  - chat_messages');
    console.log('');
    console.log('🔑 Indexes created:');
    console.log('  - idx_chat_conversations_user_id');
    console.log('  - idx_chat_conversations_organization_id');
    console.log('  - idx_chat_conversations_created_at');
    console.log('  - idx_chat_messages_conversation_id');
    console.log('  - idx_chat_messages_created_at');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to initialize tables:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  }
};

initializeTables();
