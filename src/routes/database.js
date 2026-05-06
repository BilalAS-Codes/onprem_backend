const express = require('express');
const router = express.Router();
const databaseController = require('../controllers/databaseController');
const { authenticateToken } = require('../middleware/auth');
const { authorize, ROLES } = require('../middleware/rbac');
const { auditLog } = require('../middleware/audit');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// All database routes require Admin role
router.use(authenticateToken, authorize([ROLES.ADMIN]));

/**
 * @openapi
 * /db/connect:
 *   post:
 *     summary: Add a new database connection
 *     tags: [Database]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - db_type
 *               - database_name
 *               - host
 *               - port
 *               - username
 *               - password
 *             properties:
 *               db_type:
 *                 type: string
 *                 enum: [postgresql, mysql]
 *               database_name:
 *                 type: string
 *               host:
 *                 type: string
 *               port:
 *                 type: integer
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *               ssl_enabled:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Database connected successfully
 *       400:
 *         description: Connection failed
 */
router.post('/connect',
  auditLog('DB_CONNECT', 'DatabaseConnection'),
  databaseController.connect
);

router.get('/connections',
  databaseController.getConnections
);

router.patch('/:id',
  auditLog('DB_UPDATE', 'DatabaseConnection'),
  databaseController.updateConnection
);

/**
 * @openapi
 * /db/{id}/test:
 *   post:
 *     summary: Test an existing database connection
 *     tags: [Database]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Connection successful
 *       500:
 *         description: Connection failed
 */
router.post('/:id/test',
  auditLog('DB_TEST', 'DatabaseConnection'),
  databaseController.testConnection
);

// File source management
router.get('/file-sources',
  databaseController.getFileSources
);

/**
 * @openapi
 * /db/upload-file:
 *   post:
 *     summary: Upload Excel sheets for analysis
 *     tags: [Database]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *               type:
 *                 type: string
 *                 example: "excel"
 *               source_url:
 *                 type: string
 *                 example: "https://example.com/sheet.xlsx"
 *     responses:
 *       201:
 *         description: Files uploaded successfully
 *       400:
 *         description: Upload failed
 */
router.post('/upload-file',
  upload.array('files'),
  auditLog('FILE_UPLOAD', 'DatabaseConnection'),
  databaseController.uploadFile
);


router.put('/file-sources/:id',
  upload.single('file'),
  auditLog('FILE_UPDATE', 'DatabaseConnection'),
  databaseController.updateFileSource
);

router.delete('/file-sources/:id',
  auditLog('FILE_DELETE', 'DatabaseConnection'),
  databaseController.deleteFileSource
);

router.post('/active-source',
  databaseController.updateActiveSource
);

router.get('/active-source',
  databaseController.getActiveSource
);

module.exports = router;