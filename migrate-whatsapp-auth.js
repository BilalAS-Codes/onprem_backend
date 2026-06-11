const db = require('./src/config/database');

async function runMigration() {
  try {
    console.log('⏳ Running WhatsApp Authentication schema migration...');
    
    // Create whatsapp_authorized_numbers
    await db.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_authorized_numbers (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
          mobile_number VARCHAR(50) NOT NULL,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(integration_id, mobile_number)
      );
    `);
    console.log('✅ Created whatsapp_authorized_numbers table');

    // Create index on whatsapp_authorized_numbers
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_auth_lookup ON whatsapp_authorized_numbers(integration_id, mobile_number);
    `);
    console.log('✅ Created idx_whatsapp_auth_lookup index');

    // Alter whatsapp_conversations for OTP and sessions
    await db.query(`
      ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
      ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10);
      ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;
      ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
      ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP;
      ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
    `);
    console.log('✅ Updated whatsapp_conversations table schema');

    console.log('🎉 WhatsApp Authentication schema migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ WhatsApp Authentication schema migration failed:', err);
    process.exit(1);
  }
}

runMigration();
