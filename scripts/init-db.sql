-- Insert default plans
INSERT INTO plans (name, price_monthly, query_limit, user_limit, db_limit, features) VALUES
('Starter', 499, 500, 5, 3, '{"role_based_access_control": true, "downloadable_reports": true, "cloud_deployment": true, "support_included": false}'),
('Growth', 1499, 2000, 20, 10, '{"role_based_access_control": true, "downloadable_reports": true, "email_support": true, "enhanced_performance_scalability": true}'),
('Enterprise', 0, 100000, 500, 50, '{"custom_pricing": true, "on_premise_deployment": true, "role_based_access_control": true, "downloadable_reports": true, "email_chat_support": true, "dedicated_meeting_support": true, "complete_data_privacy": true}');

-- Insert default roles
INSERT INTO roles (name, description) VALUES
('Admin', 'Full system access including user management, database connections, and permissions'),
('Department User', 'Can ask questions and view department-specific data'),
('Viewer', 'Read-only access to approved queries and insights');
