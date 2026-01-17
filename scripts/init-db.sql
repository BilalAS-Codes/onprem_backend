-- Insert default plans
INSERT INTO plans (name, price_monthly, query_limit, user_limit, db_limit, features) VALUES
('Starter', 99, 1000, 10, 3, '{"ai_queries": true, "basic_support": true, "shared_insights": true}'),
('Growth', 299, 10000, 50, 10, '{"ai_queries": true, "priority_support": true, "advanced_analytics": true, "custom_domains": true}'),
('Enterprise', 999, 100000, 500, 50, '{"ai_queries": true, "24_7_support": true, "sso": true, "audit_logs": true, "custom_integrations": true}');

-- Insert default roles
INSERT INTO roles (name, description) VALUES
('Admin', 'Full system access including user management, database connections, and permissions'),
('Department User', 'Can ask questions and view department-specific data'),
('Viewer', 'Read-only access to approved queries and insights');