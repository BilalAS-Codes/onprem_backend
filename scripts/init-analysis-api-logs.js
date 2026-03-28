#!/usr/bin/env node
require('dotenv').config();
const db = require('../src/config/database');

const SQL = `
CREATE TABLE IF NOT EXISTS analysis_api_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES chat_conversations(id) ON DELETE SET NULL,
  service_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST',
  question TEXT,
  request_id TEXT,
  task_id TEXT,
  status_code INTEGER,
  success BOOLEAN NOT NULL DEFAULT false,
  duration_ms INTEGER,
  request_payload JSONB,
  response_payload JSONB,
  error_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analysis_api_logs_created_at
  ON analysis_api_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analysis_api_logs_task_id
  ON analysis_api_logs(task_id);

CREATE INDEX IF NOT EXISTS idx_analysis_api_logs_request_id
  ON analysis_api_logs(request_id);

CREATE INDEX IF NOT EXISTS idx_analysis_api_logs_org_id
  ON analysis_api_logs(organization_id);

CREATE INDEX IF NOT EXISTS idx_analysis_api_logs_conversation_id
  ON analysis_api_logs(conversation_id);

CREATE INDEX IF NOT EXISTS idx_analysis_api_logs_request_payload_gin
  ON analysis_api_logs USING GIN (request_payload);

CREATE INDEX IF NOT EXISTS idx_analysis_api_logs_response_payload_gin
  ON analysis_api_logs USING GIN (response_payload);
`;

async function initialize() {
  try {
    const statements = SQL.split(';').map((s) => s.trim()).filter(Boolean);
    for (const statement of statements) {
      await db.query(statement);
    }
    console.log('analysis_api_logs initialized successfully');
    process.exit(0);
  } catch (error) {
    console.error('Failed to initialize analysis_api_logs:', error.message);
    process.exit(1);
  }
}

initialize();
