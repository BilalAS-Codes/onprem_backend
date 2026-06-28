-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS analysis_api_logs (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  organization_id UUID,
  user_id UUID,
  conversation_id UUID,
  endpoint TEXT NOT NULL,
  question TEXT,
  status_code INTEGER,
  success BOOLEAN NOT NULL DEFAULT false,
  duration_ms INTEGER,
  request_payload JSONB,
  response_payload JSONB,
  error_payload JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  organization_id UUID,
  user_id UUID,
  action CHARACTER VARYING(255) NOT NULL,
  target CHARACTER VARYING(255),
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL,
  title CHARACTER VARYING(255),
  is_archived BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_message_at TIMESTAMP WITHOUT TIME ZONE
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL,
  role CHARACTER VARYING(50) NOT NULL,
  content TEXT NOT NULL,
  analysis_data JSONB,
  feedback CHARACTER VARYING(10),
  is_error BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL,
  name CHARACTER VARYING(255) NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  name CHARACTER VARYING(255) NOT NULL,
  domain CHARACTER VARYING(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS query_history (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  organization_id UUID,
  user_id UUID,
  department_id UUID,
  question TEXT,
  sql_query TEXT,
  status CHARACTER VARYING(50),
  execution_time_ms INTEGER,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS response_feedback_logs (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  organization_id UUID,
  user_id UUID,
  message_id UUID,
  feedback CHARACTER VARYING(10) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  name CHARACTER VARYING(100) NOT NULL,
  description CHARACTER VARYING(255)
);

CREATE TABLE IF NOT EXISTS usage_summary (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  organization_id UUID,
  month CHARACTER VARYING(7) NOT NULL,
  query_count INTEGER DEFAULT 0,
  successful_queries INTEGER DEFAULT 0,
  rejected_queries INTEGER DEFAULT 0,
  average_response_time NUMERIC DEFAULT 0,
  error_rate NUMERIC DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY NOT NULL DEFAULT uuid_generate_v4(),
  organization_id UUID,
  department_id UUID,
  role_id UUID,
  full_name CHARACTER VARYING(255),
  email CHARACTER VARYING(255) NOT NULL,
  password_hash CHARACTER VARYING(255),
  two_factor_enabled BOOLEAN DEFAULT false,
  otp_hash TEXT,
  otp_expires_at TIMESTAMP WITHOUT TIME ZONE,
  status CHARACTER VARYING(50) DEFAULT 'active'::character varying,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
  preferred_language CHARACTER VARYING(10)
);

-- Seed Default Organization
INSERT INTO organizations (id, name, domain, is_active)
VALUES ('d289e593-6a1c-414c-bab5-4a4f6edf7e28', 'My Organization', 'myorg.com', true)
ON CONFLICT (id) DO NOTHING;

-- Seed Default Roles
INSERT INTO roles (id, name, description) VALUES
('1c213eb4-cdbc-4353-9cb9-91be3b80608c', 'Admin', 'Full system access including user management and permissions'),
('3c635312-d67b-4c4f-9af7-9e969a430733', 'Department User', 'Can ask questions and view department-specific data'),
('cb76c4fc-d7dc-47d5-8f5b-99e4f0243cc4', 'Viewer', 'Read-only access to approved queries')
ON CONFLICT (id) DO NOTHING;

-- Seed Super Admin User
INSERT INTO users (id, organization_id, role_id, full_name, email, password_hash, status)
VALUES (
  '5d8f2eff-65ec-4f30-a94e-73861191633c',
  'd289e593-6a1c-414c-bab5-4a4f6edf7e28', 
  '1c213eb4-cdbc-4353-9cb9-91be3b80608c', 
  'Super Admin', 
  'hussain@invertio.in', 
  '$2a$10$vnUFmRYf9PZLBijJ3YByceiPcO3P3dzHh10LRvGyl4cd9bzrxQCk6', 
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- Foreign Key Constraints
ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_organization_id_fkey;
ALTER TABLE departments ADD CONSTRAINT departments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_organization_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_department_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;

ALTER TABLE chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_organization_id_fkey;
ALTER TABLE chat_conversations ADD CONSTRAINT chat_conversations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_user_id_fkey;
ALTER TABLE chat_conversations ADD CONSTRAINT chat_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_conversation_id_fkey;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE;

ALTER TABLE query_history DROP CONSTRAINT IF EXISTS query_history_organization_id_fkey;
ALTER TABLE query_history ADD CONSTRAINT query_history_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE query_history DROP CONSTRAINT IF EXISTS query_history_user_id_fkey;
ALTER TABLE query_history ADD CONSTRAINT query_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE query_history DROP CONSTRAINT IF EXISTS query_history_department_id_fkey;
ALTER TABLE query_history ADD CONSTRAINT query_history_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE;

ALTER TABLE analysis_api_logs DROP CONSTRAINT IF EXISTS analysis_api_logs_organization_id_fkey;
ALTER TABLE analysis_api_logs ADD CONSTRAINT analysis_api_logs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE analysis_api_logs DROP CONSTRAINT IF EXISTS analysis_api_logs_user_id_fkey;
ALTER TABLE analysis_api_logs ADD CONSTRAINT analysis_api_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE analysis_api_logs DROP CONSTRAINT IF EXISTS analysis_api_logs_conversation_id_fkey;
ALTER TABLE analysis_api_logs ADD CONSTRAINT analysis_api_logs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE;

ALTER TABLE response_feedback_logs DROP CONSTRAINT IF EXISTS response_feedback_logs_organization_id_fkey;
ALTER TABLE response_feedback_logs ADD CONSTRAINT response_feedback_logs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE response_feedback_logs DROP CONSTRAINT IF EXISTS response_feedback_logs_user_id_fkey;
ALTER TABLE response_feedback_logs ADD CONSTRAINT response_feedback_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE response_feedback_logs DROP CONSTRAINT IF EXISTS response_feedback_logs_message_id_fkey;
ALTER TABLE response_feedback_logs ADD CONSTRAINT response_feedback_logs_message_id_fkey FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_organization_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE usage_summary DROP CONSTRAINT IF EXISTS usage_summary_organization_id_fkey;
ALTER TABLE usage_summary ADD CONSTRAINT usage_summary_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;