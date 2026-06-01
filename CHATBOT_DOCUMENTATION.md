# ZeroQueries Public Chatbot Documentation

This document provides a deep technical dive into the architecture, database schema, and code logic of the ZeroQueries Public Chatbot Widget (Version 12).

---

## 🚀 Quick Summary of Changes
- **New Database Tables**: 2
- **New Backend APIs**: 5
- **Frontend Modules**: 4
- **Security Features**: Domain Authorization, Credit-based throttling, and API Key validation.

---

## 1. High-Level Architecture
The chatbot is designed as a **Zero-Latency Micro-Widget**. It uses a modular structure to ensure that the main website embedding the bot is never slowed down.

- **Orchestrator**: `chatbot-widget.js` (The entry point)
- **API Module**: `chatbot-api.js` (Handles requests and storage)
- **UI Module**: `chatbot-ui.js` (Handles DOM and animations)
- **Renderer Module**: `chatbot-renderer.js` (Handles Plotly graphs and HTML)
- **Backend Service**: `src/routes/publicChat.js` (Secure AI execution)

---

## 2. Database Schema

Two primary tables were added/modified to support this functionality:

### A. `integrations`
Stores the configuration for each chatbot instance.
- `id` (UUID): Primary Key.
- `api_key` (UUID): The unique key used in the script tag.
- `organization_id` (UUID): Links the bot to a specific client.
- `integration_type`: Defaulted to `website_chatbot`.
- `is_enabled` (Boolean): Master switch to turn the bot ON/OFF.
- `allowed_domains` (Text[]): List of authorized hostnames (CORS security).
- `config` (JSONB): Stores `primaryColor`, `botName`, and `greeting`.

### B. `integration_logs`
Audit trail for every question asked.
- `id`: Primary Key.
- `integration_id`: Reference to the bot.
- `endpoint`: `/api/public/chat`.
- `status`: 'success' or 'error'.
- `request_payload`: Stores the user's question.
- `response_payload`: Stores the full AI result (for debugging).

---

## 3. The Embedding Mechanism
Users embed the bot using a single script tag. The orchestrator reads `data-*` attributes to configure the bot dynamically.

```html
<script 
  src="https://your-api.com/widgets/chatbot-widget.js?v=12" 
  data-api-key="YOUR_KEY"
  data-primary-color="#4f46e5"
  data-bot-name="ZeroQueries"
  async
></script>
```

---

## 4. Widget Logic (Frontend)

### A. Dynamic Loading (`chatbot-widget.js`)
To avoid large bundles, we load dependencies only when the script runs. We use **Cache Busting** (`?v=12`) to ensure users always have the latest fixes.

### B. Rich Data Rendering (`chatbot-renderer.js`)
The renderer converts AI JSON into premium UI components. It specifically handles:
- **Plotly.js**: Dynamic Bar, Pie, and Line charts.
- **KPI Cards**: Single value metrics.
- **Data Tables**: Scrollable responsive tables.
- **SQL Cards**: Collapsible code blocks.

```javascript
// Example: Plotly Initialization within the widget
window.Plotly.newPlot(element, data, {
    autosize: true,
    margin: { t: 20, r: 10, b: 40, l: 40 },
    height: 220,
    paper_bgcolor: 'rgba(0,0,0,0)'
}, { responsive: true });
```

---

## 5. Backend Infrastructure (5 New APIs)

We developed a dedicated set of APIs to manage and execute the chatbot logic securely.

### API 1: Public Chat Engine
- **Endpoint**: `POST /api/public/chat`
- **Purpose**: The main AI execution engine. It validates keys, checks credits, runs SQL, and polls for AI results.

### API 2: List Integrations
- **Endpoint**: `GET /api/v1/integrations`
- **Purpose**: Fetches all configured chatbots for an organization.

### API 3: Create/Update Integration
- **Endpoint**: `POST /api/v1/integrations`
- **Purpose**: Handles saving new bot configurations or updating existing ones (Name, Color, Domains).

### API 4: Usage Audit Logs
- **Endpoint**: `GET /api/v1/integrations/logs`
- **Purpose**: Provides a paginated history of every query asked through the chatbot for admin review.

### API 5: Delete Integration
- **Endpoint**: `DELETE /api/v1/integrations/:id`
- **Purpose**: Permanently removes a chatbot integration and its associated configuration.

---

## 6. Backend Logic (`publicChat.js`)

This is the core security and execution layer.

### A. API Key & Domain Validation
Every request is checked against the database and the `Origin` header.
```javascript
const intResult = await db.query('SELECT * FROM integrations WHERE api_key = $1', [api_key]);
if (!intResult.rows[0].is_enabled) throw new Error('Disabled');

// Domain Check
if (integration.allowed_domains.length > 0) {
    const originHost = new URL(req.headers.origin).hostname;
    if (!integration.allowed_domains.includes(originHost)) throw new Error('Unauthorized');
}
```

### B. History Synchronization (Real-Time)
We implemented a dual-sync strategy:
1. **Authenticated Sync**: If a user is logged into the ZeroQueries portal, their chatbot queries are synced to their personal "Public Chatbot" history.
2. **Anonymous Sync**: If the user is a random visitor, the query is synced to the **Admin's "Public Inquiries"** conversation.

```javascript
// Syncing to Admin Dashboard
const ownerResult = await db.query(
    'SELECT u.id FROM users u JOIN roles r ON u.role_id = r.id ' +
    'WHERE u.organization_id = $1 AND r.name = \'Admin\' ORDER BY u.created_at ASC LIMIT 1',
    [orgId]
);
// ... Insert into chat_messages for the Admin ...
```

---

## 6. Management UI (`Integrations.tsx`)

Admins manage their bots through a dedicated React interface. We added a **Real-Time Toggle** to the list view:

```tsx
<label className="relative inline-flex items-center cursor-pointer">
  <input 
    type="checkbox" 
    checked={integration.is_enabled}
    onChange={(e) => updateIntegrationStatus(integration, e.target.checked)}
  />
  <div className="peer-checked:bg-emerald-500 ..."></div>
</label>
```

---

## 7. Performance & Responsiveness
- **Persistence**: Uses `localStorage` to keep the chat open across page refreshes.
- **Resizing**: Listens to window `resize` events to trigger `Plotly.Plots.resize()`, ensuring graphs never break on mobile devices.
- **Credit Deductions**: Integrates with `creditService` to ensure pay-as-you-go usage is accurately tracked.
