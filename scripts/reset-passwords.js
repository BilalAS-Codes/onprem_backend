require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../src/config/database');

async function resetPassword() {
  const email = 'syedsmuzakkir46@gmail.com';
  const plainPassword = 'Test@123';

  const hash = await bcrypt.hash(plainPassword, 10);
  console.log('Generated hash:', hash);

  const result = await db.query(
    'UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING email, status',
    [hash, email]
  );

  if (result.rows.length > 0) {
    console.log('✅ Password updated for:', result.rows[0].email);
  } else {
    console.log('❌ User not found:', email);
  }

  // Also update admin@myorg.com with Admin@123
  const adminHash = await bcrypt.hash('Admin@123', 10);
  const adminResult = await db.query(
    'UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING email',
    [adminHash, 'admin@myorg.com']
  );
  if (adminResult.rows.length > 0) {
    console.log('✅ Password updated for:', adminResult.rows[0].email);
  }

  process.exit(0);
}

resetPassword().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
