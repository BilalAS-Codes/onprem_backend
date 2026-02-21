const crypto = require('crypto');
const bcrypt = require('bcrypt');

exports.generateOTP = () =>
  crypto.randomInt(100000, 999999).toString();

exports.hashOTP = (otp) =>
  bcrypt.hash(otp, 10);

exports.verifyOTP = (otp, hash) =>
  bcrypt.compare(otp, hash);
