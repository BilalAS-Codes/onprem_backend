const { sendInvitation } = require("./emailService");
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

async function sendOTPEmail({ to, otp }) {
  await createTransporter().sendMail({
    to,
    subject: 'Your Login OTP',
    html: `
      <p>Your login verification code:</p>
      <h2>${otp}</h2>
      <p>Expires in 5 minutes.</p>
    `
  });
}

module.exports = {
  sendInvitation,
  sendOTPEmail
};
