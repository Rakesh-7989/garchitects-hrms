const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair } = require('../utils/schemaRepair');
const { uploadBuffer, deleteFile, getStorageClient } = require('../services/storage');
const { logAudit } = require('../utils/audit');

const ALLOWED_MIME = new Set([
    'application/pdf',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.dwg', 'application/octet-stream',
    'text/plain',
    'text/csv'
]);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME.has(file.mimetype)) {
            return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
        }
        cb(null, true);
    }
});

const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

/**
 * GET /api/project-documents/:projectId
 * Document register for one project, newest first, uploader name joined.
 */
router.get('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(`
            SELECT pd.*, e.first_name || ' ' || e.last_name AS uploader_name
            FROM project_documents pd
            LEFT JOIN employees e ON e.id = pd.uploader_id
            WHERE pd.project_id = $1
            ORDER BY pd.created_at DESC, pd.id DESC`,
            [req.params.projectId]);
        res.json({ success: true, documents: result.rows });
    } catch (error) {
        console.error('Error listing project documents:', error);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * POST /api/project-documents/:projectId/upload
 * Multipart upload (field `file`) plus title/doc_type/description fields.
 */
router.post('/:projectId/upload', verifyToken, isAdmin, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: 'File too large. Maximum size is 15 MB.' });
            }
            if (err instanceof multer.MulterError && err.code === 'LIMIT_UNEXPECTED_FILE') {
                return res.status(400).json({ success: false, message: 'File type not allowed. Use PDF, images, Word, Excel, PowerPoint, CSV, DWG or text files.' });
            }
            return res.status(400).json({ success: false, message: 'Upload failed: ' + err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        if (!Number.isFinite(projectId)) {
            return res.status(400).json({ success: false, message: 'Invalid project id' });
        }
        if (!req.file) return res.status(400).json({ success: false, message: 'No file selected' });

        const { title, doc_type, description } = req.body;
        const cleanTitle = (title || '').trim();
        if (!cleanTitle && !req.file.originalname) {
            return res.status(400).json({ success: false, message: 'Document title is required' });
        }
        const cleanExt = path.extname(req.file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
        const fileName = `pdoc-${crypto.randomBytes(16).toString('hex')}${cleanExt}`;
        const file_url = await uploadBuffer('documents', fileName, req.file.buffer, req.file.mimetype, { public: false });

        const result = await q(
            `INSERT INTO project_documents (project_id, title, doc_type, description, file_name, file_url, uploader_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [projectId, cleanTitle || req.file.originalname, (doc_type || '').trim() || 'other', (description || '').trim() || null, fileName, file_url, req.user.id]
        );

        logAudit({
            actorId: req.user.id,
            action: 'document.upload',
            entityType: 'project_document',
            entityId: result.rows[0].id,
            details: { projectId, title: result.rows[0].title, doc_type: result.rows[0].doc_type },
            ip: req.ip
        });

        res.status(201).json({ success: true, document: result.rows[0] });
    } catch (error) {
        console.error('Project document upload error:', error.message);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * GET /api/project-documents/:projectId/:id/download
 * Streams the stored file with the document title as the download name.
 */
router.get('/:projectId/:id/download', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            'SELECT * FROM project_documents WHERE id = $1 AND project_id = $2',
            [req.params.id, req.params.projectId]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Document not found' });
        const doc = result.rows[0];
        if (!doc.file_name) return res.status(404).json({ success: false, message: 'No file attached to this document' });

        const { data, error } = await getStorageClient().storage.from('documents').download(doc.file_name);
        if (error || !data) return res.status(404).json({ success: false, message: 'File not found on server' });

        const buf = Buffer.from(await data.arrayBuffer());
        const safeName = encodeURIComponent(doc.title + path.extname(doc.file_name));
        res.setHeader('Content-Type', data.type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
        res.send(buf);
    } catch (error) {
        console.error('Project document download error:', error.message);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * PUT /api/project-documents/:projectId/:id
 * Metadata-only edit (title, doc_type, description). File stays untouched.
 */
router.put('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const { title, doc_type, description } = req.body;
        const cleanTitle = (title || '').trim();
        if (!cleanTitle) return res.status(400).json({ success: false, message: 'Document title is required' });
        const result = await q(
            `UPDATE project_documents
             SET title = $1, doc_type = $2, description = $3
             WHERE id = $4 AND project_id = $5
             RETURNING *`,
            [cleanTitle, (doc_type || '').trim() || 'other', (description || '').trim() || null, req.params.id, req.params.projectId]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Document not found' });
        logAudit({
            actorId: req.user.id,
            action: 'document.update',
            entityType: 'project_document',
            entityId: result.rows[0].id,
            details: { projectId: Number(req.params.projectId), title: result.rows[0].title, doc_type: result.rows[0].doc_type },
            ip: req.ip
        });
        res.json({ success: true, document: result.rows[0] });
    } catch (error) {
        console.error('Project document update error:', error.message);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

/**
 * DELETE /api/project-documents/:projectId/:id
 * Removes the row and the stored file (best effort on storage failure).
 */
router.delete('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const doc = await q('SELECT * FROM project_documents WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
        if (doc.rows.length === 0) return res.status(404).json({ success: false, message: 'Document not found' });
        const result = await q('DELETE FROM project_documents WHERE id = $1 AND project_id = $2 RETURNING id', [req.params.id, req.params.projectId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Document not found' });
        if (doc.rows[0].file_name) {
            try { await deleteFile('documents', doc.rows[0].file_name); } catch (e) { console.warn('Storage delete skipped for project document:', e.message); }
        }
        logAudit({
            actorId: req.user.id,
            action: 'document.delete',
            entityType: 'project_document',
            entityId: Number(req.params.id),
            details: { projectId: Number(req.params.projectId), title: doc.rows[0].title },
            ip: req.ip
        });
        res.json({ success: true, message: 'Document deleted' });
    } catch (error) {
        console.error('Project document delete error:', error.message);
        res.status(500).json({ success: false, message: (error && error.message) || 'Server error' });
    }
});

module.exports = router;