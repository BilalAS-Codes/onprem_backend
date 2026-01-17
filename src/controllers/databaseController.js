const DatabaseConnection = require('../models/DatabaseConnection');
const { testConnection, getSchema } = require('../utils/dbConnection');

const databaseController = {
  async connect(req, res) {
    try {
      const { 
        db_type, 
        host, 
        port, 
        database_name, 
        username, 
        password,
        ssl_enabled = false 
      } = req.body;
      
      const organizationId = req.user.organization_id;

      // Test connection first
      const testResult = await testConnection({
        db_type,
        host,
        port,
        database_name,
        username,
        password,
        ssl_enabled
      });

      if (!testResult.success) {
        return res.status(400).json({
          error: 'Connection failed',
          details: testResult.error
        });
      }

      // Create connection record
      const connection = await DatabaseConnection.create({
        organization_id: organizationId,
        db_type,
        host,
        port,
        database_name,
        username,
        password, // Note: In production, encrypt this
        ssl_enabled,
        latency_ms: testResult.latency_ms,
        status: 'connected'
      });

      // Get and store schema
      await getSchema(connection.id, {
        db_type,
        host,
        port,
        database_name,
        username,
        password,
        ssl_enabled
      });

      res.status(201).json({
        success: true,
        connection: {
          id: connection.id,
          db_type: connection.db_type,
          host: connection.host,
          database_name: connection.database_name,
          status: connection.status,
          latency_ms: connection.latency_ms
        }
      });
    } catch (error) {
      console.error('Database connection error:', error);
      res.status(500).json({ error: 'Failed to create database connection' });
    }
  },

  async getConnections(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const connections = await DatabaseConnection.findByOrganization(organizationId);
      
      // Remove sensitive data
      const safeConnections = connections.map(conn => ({
        id: conn.id,
        db_type: conn.db_type,
        host: conn.host,
        port: conn.port,
        database_name: conn.database_name,
        ssl_enabled: conn.ssl_enabled,
        latency_ms: conn.latency_ms,
        last_synced_at: conn.last_synced_at,
        status: conn.status,
        created_at: conn.created_at
      }));

      res.json({
        success: true,
        connections: safeConnections
      });
    } catch (error) {
      console.error('Get connections error:', error);
      res.status(500).json({ error: 'Failed to fetch connections' });
    }
  },

  async updateConnection(req, res) {
    try {
      const { id } = req.params;
      const updates = req.body;
      const organizationId = req.user.organization_id;

      // Verify connection belongs to organization
      const connection = await DatabaseConnection.findById(id);
      if (!connection || connection.organization_id !== organizationId) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      // If password is being updated, test connection first
      if (updates.password || updates.host || updates.port || updates.database_name) {
        const testConfig = {
          db_type: updates.db_type || connection.db_type,
          host: updates.host || connection.host,
          port: updates.port || connection.port,
          database_name: updates.database_name || connection.database_name,
          username: updates.username || connection.username,
          password: updates.password || connection.password,
          ssl_enabled: updates.ssl_enabled || connection.ssl_enabled
        };

        const testResult = await testConnection(testConfig);
        if (!testResult.success) {
          return res.status(400).json({
            error: 'Connection test failed',
            details: testResult.error
          });
        }

        updates.latency_ms = testResult.latency_ms;
        updates.status = 'connected';
      }

      const updatedConnection = await DatabaseConnection.update(id, updates);

      // Remove sensitive data
      const { password, ...safeConnection } = updatedConnection;

      res.json({
        success: true,
        connection: safeConnection
      });
    } catch (error) {
      console.error('Update connection error:', error);
      res.status(500).json({ error: 'Failed to update connection' });
    }
  },

  async testConnection(req, res) {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      // Get connection
      const connection = await DatabaseConnection.findById(id);
      if (!connection || connection.organization_id !== organizationId) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      // Test connection
      const testResult = await testConnection({
        db_type: connection.db_type,
        host: connection.host,
        port: connection.port,
        database_name: connection.database_name,
        username: connection.username,
        password: connection.password,
        ssl_enabled: connection.ssl_enabled
      });

      // Update connection status
      await DatabaseConnection.update(id, {
        status: testResult.success ? 'connected' : 'disconnected',
        latency_ms: testResult.latency_ms,
        last_synced_at: testResult.success ? new Date() : null
      });

      res.json({
        success: testResult.success,
        latency_ms: testResult.latency_ms,
        error: testResult.error
      });
    } catch (error) {
      console.error('Test connection error:', error);
      res.status(500).json({ error: 'Connection test failed' });
    }
  }
};

module.exports = databaseController;