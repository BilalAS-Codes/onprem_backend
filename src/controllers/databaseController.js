const DatabaseConnection = require('../models/DatabaseConnection');
const FileSource = require('../models/FileSource');
const Organization = require('../models/Organization');
const { s3, bucketName } = require('../config/s3');
const { testConnection, getSchema } = require('../utils/dbConnection');
const schemaController = require('./schemaController');


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
},

  async getFileSources(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const sources = await FileSource.findByOrganization(organizationId);
      res.json({ success: true, sources });
    } catch (error) {
      console.error('Get file sources error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch file sources' });
    }
  },

  async uploadFile(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const { type, source_url } = req.body;
      
      const files = req.files || (req.file ? [req.file] : []);
      const createdSources = [];

      if (files.length === 0 && !source_url) {
        return res.status(400).json({ success: false, error: 'No files or URL provided' });
      }

      // Handle File Uploads
      if (files.length > 0) {
        for (const file of files) {
          const safeFileName = file.originalname.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
          const s3Key = `${organizationId}/${safeFileName}`;

          const uploadResult = await s3.upload({
            Bucket: bucketName,
            Key: s3Key,
            Body: file.buffer,
            ContentType: file.mimetype
          }).promise();

          const source = await FileSource.create({
            organization_id: organizationId,
            source_type: type || 'excel',
            filename: file.originalname.toLowerCase(),
            s3_key: s3Key,
            url: uploadResult.Location,
            status: 'active'
          });

          // 🔁 AUTOMATION: Discover Schema
          try {
            await schemaController.discoverFileSchema({
              fileSourceId: source.id,
              organizationId: organizationId
            });
          } catch (autoErr) {
            console.error(`[UPLOAD] Automation failed for ${file.originalname}:`, autoErr.message);
          }

          createdSources.push(source);
        }

        // Activate the last uploaded source in the organization preference
        if (createdSources.length > 0) {
          const lastSource = createdSources[createdSources.length - 1];
          const db = require('../config/database');
          await db.query(
            'UPDATE organizations SET active_source_id = $1, active_source_type = $2 WHERE id = $3',
            [lastSource.id, lastSource.source_type, organizationId]
          );
        }

        return res.json({ success: true, sources: createdSources });
      }

      // Handle URL-only upload (e.g. Google Sheets link)
      if (source_url) {
        const source = await FileSource.create({
          organization_id: organizationId,
          source_type: type || 'google_sheets',
          filename: 'Google Sheet',
          url: source_url,
          status: 'active'
        });
        
        return res.json({ success: true, source });
      }

    } catch (error) {
      console.error('Upload file source error:', error);
      res.status(500).json({ success: false, error: 'Failed to upload file source' });
    }
  },

  async updateFileSource(req, res) {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;
      const { source_url, name } = req.body;
      const source = await FileSource.findById(id);

      if (!source || source.organization_id !== organizationId) {
        return res.status(404).json({ success: false, error: 'Source not found' });
      }

      const updates = {};
      if (name) updates.filename = name;

      if (req.file) {
        // Replace file in S3
        const safeFileName = req.file.originalname.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
        const s3Key = `${organizationId}/${safeFileName}`;

        // Delete old file from S3
        if (source.s3_key) {
          try {
            await s3.deleteObject({ Bucket: bucketName, Key: source.s3_key }).promise();
          } catch (e) {
            console.warn('Failed to delete old S3 object:', e);
          }
        }

        // Upload new file
        const uploadResult = await s3.upload({
          Bucket: bucketName,
          Key: s3Key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype
        }).promise();

        updates.filename = req.file.originalname.toLowerCase();
        updates.s3_key = s3Key;
        updates.url = uploadResult.Location;
      } else if (source_url && source.source_type === 'google_sheets') {
        updates.url = source_url;
      }

      if (Object.keys(updates).length > 0) {
        const updatedSource = await FileSource.update(id, updates);

        // 🔁 AUTOMATION: Re-discover Schema if file was replaced
        if (req.file) {
          try {
            console.log(`[UPDATE] Automating re-discovery for source: ${id}`);
            await schemaController.discoverFileSchema({
              fileSourceId: id,
              organizationId: organizationId
            });
          } catch (autoErr) {
            console.error('[UPDATE] Re-discovery failed:', autoErr.message);
          }
        }

        return res.json({ success: true, source: updatedSource });
      }

      res.json({ success: true, message: 'No changes detected' });
    } catch (error) {
      console.error('Update file source error:', error);
      res.status(500).json({ success: false, error: 'Failed to update file source' });
    }
  },

  async deleteFileSource(req, res) {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;
      const source = await FileSource.findById(id);

      if (!source || source.organization_id !== organizationId) {
        return res.status(404).json({ success: false, error: 'Source not found' });
      }

      // 1. Delete associated semantic schema metadata
      const db = require('../config/database');
      await db.query('DELETE FROM semantic_relationships WHERE file_source_id = $1', [id]);
      await db.query('DELETE FROM semantic_columns WHERE semantic_table_id IN (SELECT id FROM semantic_tables WHERE file_source_id = $1)', [id]);
      await db.query('DELETE FROM semantic_tables WHERE file_source_id = $1', [id]);

      // 2. Delete from S3 (Attempt to delete from current bucket, or fallback to old bucket if needed)
      if (source.s3_key) {
        try {
          // Try current configured bucket first
          await s3.deleteObject({ Bucket: bucketName, Key: source.s3_key }).promise();
          console.log(`[DELETE] Successfully deleted file from S3: ${source.s3_key} (Bucket: ${bucketName})`);
        } catch (s3Error) {
          // If it fails, try the old bucket name just in case it was stored there
          const oldBucket = 'invertiotaxdocs';
          if (bucketName !== oldBucket) {
            try {
              await s3.deleteObject({ Bucket: oldBucket, Key: source.s3_key }).promise();
              console.log(`[DELETE] Successfully deleted file from old S3 bucket: ${source.s3_key} (Bucket: ${oldBucket})`);
            } catch (oldS3Error) {
              console.warn(`[DELETE] Failed to delete file from both S3 buckets. Proceeding with DB cleanup.`, {
                key: source.s3_key,
                currentBucket: bucketName,
                oldBucket: oldBucket,
                error: oldS3Error.message
              });
            }
          } else {
            console.warn(`[DELETE] Failed to delete file from S3 bucket: ${bucketName}. Proceeding with DB cleanup.`, s3Error.message);
          }
        }
      }

      // 3. Delete file source record
      await FileSource.delete(id, organizationId);
      
      res.json({ success: true, message: 'Source and associated schema deleted successfully' });
    } catch (error) {
      console.error('Delete file source error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete file source' });
    }
  },
  async updateActiveSource(req, res) {
    try {
      const { source_id, source_type } = req.body;
      const organizationId = req.user.organization_id;
      
      const db = require('../config/database');
      await db.query(
        'UPDATE organizations SET active_source_id = $1, active_source_type = $2 WHERE id = $3',
        [source_id, source_type, organizationId]
      );
      
      res.json({ success: true });
    } catch (error) {
      console.error('Update active source error:', error);
      res.status(500).json({ success: false, error: 'Failed to update active source' });
    }
  },

  async getActiveSource(req, res) {
    try {
      const organizationId = req.user.organization_id;
      const db = require('../config/database');
      
      const result = await db.query(
        'SELECT active_source_id, active_source_type FROM organizations WHERE id = $1',
        [organizationId]
      );
      
      res.json({ success: true, active_source: result.rows[0] });
    } catch (error) {
      console.error('Get active source error:', error);
      res.status(500).json({ success: false, error: 'Failed to get active source' });
    }
  }
};

module.exports = databaseController;
