const nodemailer = require('nodemailer');

const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD
    }
  });
};

const emailService = {
  async sendInvitation({ to, full_name, tempPassword, organization_name, invited_by }) {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const mailOptions = {
      from: `"ZeroQueries" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `You've been invited to join ${organization_name} on ZeroQueries`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to ZeroQueries!</h2>
          <p>Hello ${full_name},</p>
          <p>You've been invited by ${invited_by} to join ${organization_name} on ZeroQueries.</p>
          <p>Your temporary password is: <strong>${tempPassword}</strong></p>
          <p>Please login at: <a href="${frontendUrl}/login">${frontendUrl}/login</a></p>
          <p>For security reasons, please change your password after your first login.</p>
          <br>
          <p>Best regards,<br>The ZeroQueries Team</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
  },

  async sendPasswordReset({ to, resetToken }) {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

    const mailOptions = {
      from: `"ZeroQueries" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: 'Password Reset Request - ZeroQueries',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Password Reset Request</h2>
          <p>We received a request to reset your password.</p>
          <p>Click the link below to reset your password:</p>
          <p><a href="${resetUrl}">Reset Password</a></p>
          <p>This link will expire in 1 hour.</p>
          <p>If you didn't request a password reset, please ignore this email.</p>
          <br>
          <p>Best regards,<br>The ZeroQueries Team</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
  }
};

module.exports = emailService;