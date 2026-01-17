const User = require('./User');
const Organization = require('./Organization');
const Department = require('./Department');
const DatabaseConnection = require('./DatabaseConnection');
const QueryHistory = require('./QueryHistory');
const AuditLog = require('./AuditLog');

module.exports = {
  User,
  Organization,
  Department,
  DatabaseConnection,
  QueryHistory,
  AuditLog
};