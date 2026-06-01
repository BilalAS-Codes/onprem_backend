-- Integrations Table
CREATE TABLE IF NOT EXISTS integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    integration_type VARCHAR(50) NOT NULL,
    config JSONB DEFAULT '{}',
    api_key UUID DEFAULT gen_random_uuid() UNIQUE,
    is_enabled BOOLEAN DEFAULT true,
    allowed_domains TEXT[] DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Integration Usage Logs Table
CREATE TABLE IF NOT EXISTS integration_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id UUID REFERENCES integrations(id) ON DELETE SET NULL,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    endpoint VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL,
    duration_ms INTEGER,
    request_payload JSONB,
    response_payload JSONB,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_integrations_org_id ON integrations(organization_id);
CREATE INDEX IF NOT EXISTS idx_integrations_api_key ON integrations(api_key);
CREATE INDEX IF NOT EXISTS idx_integration_logs_org_id ON integration_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_integration_logs_created_at ON integration_logs(created_at DESC);
