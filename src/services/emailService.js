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
    const safeOrganizationName = organization_name || 'your organization';
    const safeInvitedBy = invited_by || 'your team';
    const safeFullName = full_name || 'there';

    const mailOptions = {
      from: `"ZeroQueries" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `You've been invited to join ${safeOrganizationName} on ZeroQueries`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to ZeroQueries!</h2>
          <p>Hello ${safeFullName},</p>
          <p>You've been invited by ${safeInvitedBy} to join ${safeOrganizationName} on ZeroQueries.</p>
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
  ,

  async sendPlanChange({ to, plan_name, price_monthly, payment_id, effective_date, scheduled }) {
    if (!to) return;
    const transporter = createTransporter();
    const effectiveText = effective_date
      ? new Date(effective_date).toLocaleDateString()
      : null;

    const mailOptions = {
      from: `"ZeroQueries" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: scheduled ? `Plan Change Scheduled: ${plan_name}` : `Plan Updated: ${plan_name}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>${scheduled ? 'Your plan change is scheduled' : 'Your plan has been updated'}</h2>
          <p>Plan: <strong>${plan_name}</strong></p>
          <p>Price: <strong>${price_monthly || 'N/A'} / month</strong></p>
          ${scheduled && effectiveText ? `<p>Effective Date: <strong>${effectiveText}</strong></p>` : ''}
          <p>Payment ID: <strong>${payment_id || 'N/A'}</strong></p>
          <br>
          <p>Thank you,<br>The ZeroQueries Team</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
  },

  async sendContactSalesInquiry({ to, requester_name, requester_email, organization_name, plan_name = 'Contact Sales' }) {
    if (!to) return;

    const transporter = createTransporter();
    const safeRequesterName = requester_name || 'Unknown user';
    const safeRequesterEmail = requester_email || 'Email unavailable';
    const safeOrganizationName = organization_name || 'Unknown organization';
    const safePlanName = plan_name || 'Contact Sales';

    const mailOptions = {
      from: `"ZeroQueries" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `Contact Sales Inquiry: ${safeRequesterName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>New Contact Sales Inquiry</h2>
          <p>A logged-in user requested contact from the sales team.</p>
          <p><strong>Name:</strong> ${safeRequesterName}</p>
          <p><strong>Email:</strong> ${safeRequesterEmail}</p>
          <p><strong>Organization:</strong> ${safeOrganizationName}</p>
          <p><strong>Interested In:</strong> ${safePlanName}</p>
          <br>
          <p>Best regards,<br>The ZeroQueries Team</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
  },

  async sendOtp({ to, otpCode, chatbotName = 'WhatsApp Bot' }) {
    const transporter = createTransporter();
    const mailOptions = {
      from: `"ZeroQueries" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `Verification Code for ZeroQueries ${chatbotName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
          <h2 style="color: #4f46e5; margin-bottom: 16px;">ZeroQueries Verification</h2>
          <p>Hello,</p>
          <p>You have requested a secure verification code to access the ZeroQueries WhatsApp chatbot (<strong>${chatbotName}</strong>).</p>
          <div style="background-color: #f3f4f6; border-radius: 8px; padding: 16px; text-align: center; margin: 24px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #1e1b4b;">${otpCode}</span>
          </div>
          <p>This verification code is valid for 15 minutes. Please do not share this code with anyone.</p>
          <br>
          <p>Best regards,<br>The ZeroQueries Team</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
  }
};

module.exports = emailService;
