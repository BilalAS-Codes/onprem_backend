# ZeroQueries API Documentation .. with docker

## 📋 Overview
ZeroQueries is a B2B SaaS platform that allows organizations to query their databases using natural language. This document covers all API endpoints and the user flow for the platform.

---

## 🚀 Getting Started

### Base URL
```
http://localhost:3000/api
```
**Production**: `https://your-domain.com/api`

### Authentication
All protected endpoints require JWT token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

---

## 📊 Database Setup (One-time)

### 1. Run Initial Setup
```sql
-- Create default plans
INSERT INTO plans (name, price_monthly, query_limit, user_limit, db_limit, features) 
VALUES 
  ('Starter', 99, 1000, 10, 3, '{"ai_queries": true, "basic_support": true, "shared_insights": true}'),
  ('Growth', 299, 10000, 50, 10, '{"ai_queries": true, "priority_support": true, "advanced_analytics": true, "custom_domains": true}'),
  ('Enterprise', 999, 100000, 500, 50, '{"ai_queries": true, "24_7_support": true, "sso": true, "audit_logs": true, "custom_integrations": true}');

-- Create default roles
INSERT INTO roles (name, description) 
VALUES 
  ('Admin', 'Full system access including user management, database connections, and permissions'),
  ('Department User', 'Can ask questions and view department-specific data'),
  ('Viewer', 'Read-only access to approved queries and insights');
```

---

## 👤 User Flow

### 1. **New Organization Registration**
```
Organization Admin → Registers → Creates Organization → Becomes Admin
```

### 2. **Post-Registration Flow**
```
Admin → Logs in → Adds DB Connections → Maps Schema → Invites Users
```

### 3. **Regular User Flow**
```
User → Logs in → Asks Questions → Views History → Shares Insights
```

---

## 🔐 Authentication APIs

### **Register Organization & Admin**
```http
POST /auth/register
Content-Type: application/json

{
  "organization_name": "Acme Corporation",
  "domain": "acme.com",
  "full_name": "John Doe",
  "email": "admin@acme.com",
  "password": "SecurePass123"
}
```
**Response:**
```json
{
  "success": true,
  "message": "Organization and admin user created successfully",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "email": "admin@acme.com",
    "full_name": "John Doe",
    "role": "Admin"
  },
  "organization": {
    "id": "uuid",
    "name": "Acme Corporation",
    "domain": "acme.com",
    "plan_id": "starter-plan-uuid"
  }
}
```

### **Login User**
```http
POST /auth/login
Content-Type: application/json

{
  "email": "admin@acme.com",
  "password": "SecurePass123"
}
```
**Response:** Same structure as register with JWT token.

### **Get User Profile**
```http
GET /auth/profile
Authorization: Bearer <token>
```

### **Change Password**
```http
PATCH /auth/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "currentPassword": "oldpass",
  "newPassword": "newpass"
}
```

---

## 🏢 Organization APIs

### **Get Organization Details**
```http
GET /organizations
Authorization: Bearer <token>
```
*Returns the authenticated user's organization details*

### **Get Organization by ID**
```http
GET /organizations/:id
Authorization: Bearer <token>
```
*Can only access own organization*

---

## 👥 User Management APIs (Admin Only)

### **Invite User to Organization**
```http
POST /users/invite
Authorization: Bearer <token>
Content-Type: application/json

{
  "email": "user@acme.com",
  "full_name": "Jane Smith",
  "role_id": "role-uuid",
  "department_id": "dept-uuid"
}
```

### **Get All Users**
```http
GET /users
Authorization: Bearer <token>
```
*Admin sees all, others see filtered results*

**Query Parameters:**
- `department_id` (optional)
- `status` (optional: active, inactive, suspended)
- `search` (optional: search by name/email)

### **Update User Role**
```http
PATCH /users/:id/role
Authorization: Bearer <token>
Content-Type: application/json

{
  "role_id": "new-role-uuid"
}
```

### **Update User Department**
```http
PATCH /users/:id/department
Authorization: Bearer <token>
Content-Type: application/json

{
  "department_id": "new-dept-uuid"
}
```

### **Update User Status**
```http
PATCH /users/:id/status
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "inactive"
}
```
*Status values: active, inactive, suspended, invited*

---

## 🏢 Department APIs (Admin Only)

### **Create Department**
```http
POST /departments/create
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Finance",
  "privacy_level": "private"
}
```

### **Get All Departments**
```http
GET /departments
Authorization: Bearer <token>
```

### **Update Department**
```http
PATCH /departments/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Finance & Accounting",
  "privacy_level": "confidential"
}
```

### **Delete Department**
```http
DELETE /departments/:id
Authorization: Bearer <token>
```

### **Set Department Permissions**
```http
POST /departments/:id/permissions
Authorization: Bearer <token>
Content-Type: application/json

{
  "permissions": [
    {
      "table_name": "sales_data",
      "access_level": "read_write"
    },
    {
      "table_name": "customer_data",
      "access_level": "read_only"
    }
  ]
}
```

### **Get Department Permissions**
```http
GET /departments/:id/permissions
Authorization: Bearer <token>
```

---

## 🗄️ Database Connection APIs (Admin Only)

### **Connect Database**
```http
POST /db/connect
Authorization: Bearer <token>
Content-Type: application/json

{
  "db_type": "postgresql",
  "host": "localhost",
  "port": 5432,
  "database_name": "sales_db",
  "username": "readonly_user",
  "password": "readonly_pass",
  "ssl_enabled": false
}
```
**Supported DB Types:** `postgresql`, `mysql`

### **Get All Connections**
```http
GET /db/connections
Authorization: Bearer <token>
```

### **Update Connection**
```http
PATCH /db/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "host": "new-host.com",
  "port": 5433,
  "ssl_enabled": true
}
```

### **Test Connection**
```http
POST /db/:id/test
Authorization: Bearer <token>
Content-Type: application/json

{}
```

---

## 📊 Schema & Mapping APIs

### **Get Tables from Connection**
```http
GET /schema/:connectionId/tables
Authorization: Bearer <token>
```

### **Get Columns from Table**
```http
GET /schema/:connectionId/columns/:tableName
Authorization: Bearer <token>
```
*Example:* `/schema/conn-uuid/columns/sales_data`

### **Create Table Mapping** (Admin Only)
```http
POST /schema/mapping/table
Authorization: Bearer <token>
Content-Type: application/json

{
  "connection_id": "conn-uuid",
  "table_name": "sales_data",
  "business_name": "Monthly Sales Report",
  "is_enabled": true
}
```

### **Create Column Mapping** (Admin Only)
```http
POST /schema/mapping/column
Authorization: Bearer <token>
Content-Type: application/json

{
  "semantic_table_id": "table-uuid",
  "column_name": "amount",
  "business_name": "Sale Amount",
  "data_type": "numeric",
  "is_nullable": false,
  "default_value": "0",
  "department_access": "Finance,Sales",
  "is_enabled": true
}
```

### **Get Mapped Tables**
```http
GET /schema/mapping/tables
Authorization: Bearer <token>
```

### **Get Mapped Columns**
```http
GET /schema/mapping/columns
Authorization: Bearer <token>
```
**Query Parameter:** `table_id` (optional)

---

## ❓ Query & Insights APIs

### **Get Query History**
```http
GET /queries/history
Authorization: Bearer <token>
```
**Query Parameters:**
- `limit` (default: 50)
- `offset` (default: 0)
- `department_id` (optional)
- `status` (optional: success, failed, pending)
- `search` (optional: search in question/SQL)

### **Get Query by ID**
```http
GET /queries/:id
Authorization: Bearer <token>
```

### **Delete Query**
```http
DELETE /queries/:id
Authorization: Bearer <token>
```

### **Share Query**
```http
POST /queries/:id/share
Authorization: Bearer <token>
Content-Type: application/json

{}
```
**Response includes:** `share_token` and `share_url`

### **Get Shared Insight** (Public - No Auth)
```http
GET /insights/shared/:token
```
*No authentication required*

---

## 💳 Billing & Plans APIs

### **Get Current Plan**
```http
GET /billing/plan
Authorization: Bearer <token>
```
*Returns plan details with usage statistics*

**Response includes:**
- Plan name, price, limits
- Current usage (users, databases, queries)
- Usage percentages

### **Upgrade Plan**
```http
POST /billing/upgrade
Authorization: Bearer <token>
Content-Type: application/json

{
  "plan_id": "growth-plan-uuid"
}
```

---

## 📝 Audit Logs APIs (Admin Only)

### **Get Audit Logs**
```http
GET /audit/logs
Authorization: Bearer <token>
```
**Query Parameters:**
- `limit` (default: 100)
- `offset` (default: 0)
- `action` (optional: filter by action)
- `user_id` (optional: filter by user)
- `start_date`, `end_date` (optional: date range)
- `target` (optional: filter by target type)

---

## 🏥 Health Check

### **System Health**
```http
GET /health
```
**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-17T08:00:00.000Z"
}
```

---

## 🔐 Role-Based Access Control

### **Roles & Permissions**

| Role | Permissions |
|------|-------------|
| **Admin** | Full system access, user management, DB connections, billing |
| **Department User** | Ask questions, view department data, view query history |
| **Viewer** | Read-only access to approved queries and insights |

### **API Access Matrix**

| Endpoint | Admin | Dept User | Viewer |
|----------|-------|-----------|--------|
| `/auth/*` | ✅ | ✅ | ✅ |
| `/organizations/*` | ✅ | ✅ | ✅ |
| `/users/*` | ✅ | ❌ | ❌ |
| `/departments/*` | ✅ | ❌ | ❌ |
| `/db/*` | ✅ | ❌ | ❌ |
| `/schema/*` | ✅ | ✅ | ✅ |
| `/schema/mapping/*` | ✅ | ❌ | ❌ |
| `/queries/*` | ✅ | ✅ | ✅* |
| `/billing/*` | ✅ | ❌ | ❌ |
| `/audit/*` | ✅ | ❌ | ❌ |

*Viewers cannot see SQL queries, only results

---

## ⚠️ Error Handling

### **Common HTTP Status Codes**

| Code | Meaning | Typical Cause |
|------|---------|---------------|
| 200 | Success | Request completed successfully |
| 201 | Created | Resource created successfully |
| 400 | Bad Request | Invalid input, missing parameters |
| 401 | Unauthorized | No/invalid authentication token |
| 403 | Forbidden | Insufficient permissions |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Resource already exists (duplicate email/domain) |
| 500 | Server Error | Internal server error |

### **Error Response Format**
```json
{
  "error": "Descriptive error message",
  "details": "Additional details in development mode"
}
```

---

## 🚦 Rate Limiting
*Note: Implement based on plan tier*

| Plan | Requests/Minute |
|------|----------------|
| Starter | 100 |
| Growth | 500 |
| Enterprise | 2000 |

---

## 📚 Postman Collection

Import the complete Postman collection from:
- `zeroqueries-postman-collection.json`
- Or use the cURL commands provided above

---

## 🆘 Support & Troubleshooting

### **Common Issues**

1. **"Admin role not found"**
   ```sql
   INSERT INTO roles (name) VALUES ('Admin');
   ```

2. **"No plans available"**
   ```sql
   INSERT INTO plans (name, price_monthly) VALUES ('Starter', 99);
   ```

3. **Database connection fails**
   - Check AWS RDS security groups
   - Verify credentials in `.env` file
   - Ensure database exists

4. **JWT token expired**
   - Login again to get new token
   - Tokens expire in 24 hours

### **Debug Mode**
Set in `.env`:
```env
NODE_ENV=development
DEBUG=true
```

---

## 🔄 Changelog

### **v1.0.0** - Initial Release
- Complete SaaS multi-tenant architecture
- Self-service registration
- Database connection management
- Natural language query interface
- Role-based access control
- Audit logging

---

**Last Updated:** January 17, 2026  
**Version:** 1.0.0
