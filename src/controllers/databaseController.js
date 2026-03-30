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
          success: false,
          error: 'Connection failed',
          details: testResult.error
        });
      }

      const effectiveSslEnabled = Boolean(testResult.used_ssl ?? ssl_enabled);

      // Create connection record
      const connection = await DatabaseConnection.create({
        organization_id: organizationId,
        db_type,
        host,
        port,
        database_name,
        username,
        password, // Note: In production, encrypt this
        ssl_enabled: effectiveSslEnabled,
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
        ssl_enabled: effectiveSslEnabled
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
      res.status(500).json({ 
        success: false,
        error: 'Failed to create database connection' 
      });
    }
  },

async getConnections(req, res) {
  try {
    // 🔴 ADD THIS
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });

    const organizationId = req.user.organization_id;
    const connections = await DatabaseConnection.findByOrganization(organizationId);

    const safeConnections = connections.map(conn => ({
      id: conn.id,
      db_type: conn.db_type,
      host: conn.host,
      port: conn.port,
      database_name: conn.database_name,
      username: conn.username,
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
    res.status(500).json({
      success: false,
      error: 'Failed to fetch connections'
    });
  }
}
,

//   async updateConnection(req, res) {
//   try {
//     const { id } = req.params;
//     const updates = req.body;
//     const organizationId = req.user.organization_id;

//     const connection = await DatabaseConnection.findById(id);
//     if (!connection || connection.organization_id !== organizationId) {
//       return res.status(404).json({
//         success: false,
//         error: 'Connection not found'
//       });
//     }

//     // ---------- NORMALIZE + COMPARE (NO PASSWORD) ----------
//     const normalize = (v) =>
//       typeof v === 'string' ? v.trim() : v;

//     const incoming = {
//       db_type: normalize(updates.db_type ?? connection.db_type),
//       host: normalize(updates.host ?? connection.host),
//       port: Number(updates.port ?? connection.port),
//       database_name: normalize(updates.database_name ?? connection.database_name),
//       username: normalize(updates.username ?? connection.username),
//       ssl_enabled: updates.ssl_enabled ?? connection.ssl_enabled
//     };

//     const existing = {
//       db_type: normalize(connection.db_type),
//       host: normalize(connection.host),
//       port: Number(connection.port),
//       database_name: normalize(connection.database_name),
//       username: normalize(connection.username),
//       ssl_enabled: connection.ssl_enabled
//     };

//     const isSameConfig =
//       incoming.db_type === existing.db_type &&
//       incoming.host === existing.host &&
//       incoming.port === existing.port &&
//       incoming.database_name === existing.database_name &&
//       incoming.username === existing.username &&
//       incoming.ssl_enabled === existing.ssl_enabled;

//     // ---------- CASE 1: SAME CONFIG, NO PASSWORD ----------
//     if (isSameConfig && !updates.password) {
//       return res.json({
//         success: true,
//         no_change: true,
//         message: 'No changes detected.'
//       });
//     }

//     // ---------- CASE 2: SAME CONFIG, PASSWORD ONLY ----------
//     if (isSameConfig && updates.password) {
//       const testResult = await testConnection({
//         ...incoming,
//         password: updates.password
//       });

//       if (!testResult.success) {
//         return res.status(400).json({
//           success: false,
//           error: 'Connection test failed',
//           details: testResult.error
//         });
//       }

//       return res.json({
//         success: true,
//         no_change: true,
//         message: 'Credentials verified. No configuration changes.'
//       });
//     }

//     // ---------- CASE 3: CONFIG CHANGED ----------
//     const testResult = await testConnection({
//       ...incoming,
//       password: updates.password || connection.password
//     });

//     if (!testResult.success) {
//       return res.status(400).json({
//         success: false,
//         error: 'Connection test failed',
//         details: testResult.error
//       });
//     }

//     // const updatedConnection = await DatabaseConnection.update(id, {
//     //   ...incoming,
//     //   ...(updates.password && { password: updates.password }),
//     //   latency_ms: testResult.latency_ms,
//     //   status: 'connected'
//     // });

//     // const { password, ...safeConnection } = updatedConnection;

//     // res.json({
//     //   success: true,
//     //   updated: true,
//     //   connection: safeConnection
//     // });


//     // Update the connection record
// const updatedConnection = await DatabaseConnection.update(id, {
//   ...incoming,
//   ...(updates.password && { password: updates.password }),
//   latency_ms: testResult.latency_ms,
//   status: 'connected'
// });

// // 🔁 Auto re-seed schema ONLY when config actually changed
// await schemaController.discoverAndSeedSchema({
//   params: { connectionId: id },
//   body: { override_existing: true, seed_tables: true, seed_columns: true },
//   user: req.user,
//   query: {}
// });

// const { password, ...safeConnection } = updatedConnection;
// res.json({
//   success: true,
//   updated: true,
//   connection: safeConnection,
//   schema_resynced: true // optional signal to frontend
// });

//   } catch (error) {
//     console.error('Update connection error:', error);
//     res.status(500).json({
//       success: false,
//       error: 'Failed to update connection'
//     });
//   }
// }
// In databaseController.js - updateConnection method

async updateConnection(req, res) {
  try {
    const { id } = req.params;
    const updates = req.body;
    const organizationId = req.user.organization_id;

    const connection = await DatabaseConnection.findById(id);
    if (!connection || connection.organization_id !== organizationId) {
      return res.status(404).json({
        success: false,
        error: 'Connection not found'
      });
    }

    // ---------- NORMALIZE + COMPARE (NO PASSWORD) ----------
    const normalize = (v) =>
      typeof v === 'string' ? v.trim() : v;

    const incoming = {
      db_type: normalize(updates.db_type ?? connection.db_type),
      host: normalize(updates.host ?? connection.host),
      port: Number(updates.port ?? connection.port),
      database_name: normalize(updates.database_name ?? connection.database_name),
      username: normalize(updates.username ?? connection.username),
      ssl_enabled: updates.ssl_enabled ?? connection.ssl_enabled
    };

    const existing = {
      db_type: normalize(connection.db_type),
      host: normalize(connection.host),
      port: Number(connection.port),
      database_name: normalize(connection.database_name),
      username: normalize(connection.username),
      ssl_enabled: connection.ssl_enabled
    };

    const isSameConfig =
      incoming.db_type === existing.db_type &&
      incoming.host === existing.host &&
      incoming.port === existing.port &&
      incoming.database_name === existing.database_name &&
      incoming.username === existing.username &&
      incoming.ssl_enabled === existing.ssl_enabled;

    // ---------- CASE 1: SAME CONFIG, NO PASSWORD ----------
    if (isSameConfig && !updates.password) {
      return res.json({
        success: true,
        no_change: true,
        message: 'No changes detected.'
      });
    }

    // ---------- CASE 2: SAME CONFIG, PASSWORD ONLY ----------
    if (isSameConfig && updates.password) {
      const testResult = await testConnection({
        ...incoming,
        password: updates.password
      });

      if (!testResult.success) {
        return res.status(400).json({
          success: false,
          error: 'Connection test failed',
          details: testResult.error
        });
      }

      const effectiveSslEnabled = Boolean(testResult.used_ssl ?? incoming.ssl_enabled);

      return res.json({
        success: true,
        no_change: true,
        message: 'Credentials verified. No configuration changes.',
        ssl_enabled: effectiveSslEnabled
      });
    }

    // ---------- CASE 3: CONFIG CHANGED ----------
    const testResult = await testConnection({
      ...incoming,
      password: updates.password || connection.password
    });

    if (!testResult.success) {
      return res.status(400).json({
        success: false,
        error: 'Connection test failed',
        details: testResult.error
      });
    }

    const effectiveSslEnabled = Boolean(testResult.used_ssl ?? incoming.ssl_enabled);

    // Update the connection record
    const updatedConnection = await DatabaseConnection.update(id, {
      ...incoming,
      ssl_enabled: effectiveSslEnabled,
      ...(updates.password && { password: updates.password }),
      latency_ms: testResult.latency_ms,
      status: 'connected'
    });

    // 🔁 Auto re-seed schema ONLY when config actually changed
    // Create a mock request object for the controller
    const mockReq = {
      params: { connectionId: id },
      body: { override_existing: true, seed_tables: true, seed_columns: true },
      user: req.user,
      query: {}
    };
    
    const mockRes = {
      json: (data) => {
        console.log('Schema discovery completed:', data);
      },
      status: (code) => ({
        json: (data) => {
          console.error('Schema discovery error:', data);
        }
      })
    };

    try {
      await schemaController.discoverAndSeedSchema(mockReq, mockRes);
    } catch (schemaError) {
      console.error('Schema re-seeding failed:', schemaError);
      // Don't fail the whole request if schema seeding fails
    }

    const { password, ...safeConnection } = updatedConnection;
    res.json({
      success: true,
      updated: true,
      connection: safeConnection,
      schema_resynced: true
    });

  } catch (error) {
    console.error('Update connection error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update connection'
    });
  }
}
,

  async testConnection(req, res) {
  try {
    const { id } = req.params;
    const organizationId = req.user.organization_id;

    // Get stored connection
    const connection = await DatabaseConnection.findById(id);
    if (!connection || connection.organization_id !== organizationId) {
      return res.status(404).json({ 
        success: false,
        error: 'Connection not found' 
      });
    }

    // Use credentials from request body if provided, otherwise use stored credentials
    const {
      host = connection.host,
      port = connection.port,
      database_name = connection.database_name,
      username = connection.username,
      password = connection.password,
      ssl_enabled = connection.ssl_enabled,
      db_type = connection.db_type
    } = req.body;

    // Test connection with provided or stored credentials
    const testResult = await testConnection({
      db_type,
      host,
      port,
      database_name,
      username,
      password,
      ssl_enabled
    });

    const effectiveSslEnabled = Boolean(testResult.used_ssl ?? ssl_enabled);

    // Update connection status in database
    await DatabaseConnection.update(id, {
      status: testResult.success ? 'connected' : 'disconnected',
      latency_ms: testResult.latency_ms,
      last_synced_at: testResult.success ? new Date() : null,
      ...(testResult.success ? { ssl_enabled: effectiveSslEnabled } : {})
    });

    // Return appropriate HTTP status based on test result
    if (testResult.success) {
      return res.status(200).json({
        success: true,
        latency_ms: testResult.latency_ms,
        ssl_enabled: effectiveSslEnabled
      });
    } else {
      return res.status(400).json({
        success: false,
        error: testResult.error || 'Database connection failed',
        latency_ms: testResult.latency_ms
      });
    }
  } catch (error) {
    console.error('Test connection error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Connection test failed' 
    });
  }
}};

module.exports = databaseController;
