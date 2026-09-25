const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { runWithSchemaRepair, pgErrorResponse } = require('../utils/schemaRepair');
const { logAudit } = require('../utils/audit');
const projectMath = require('../utils/projectMath');

// Self-healing query wrapper: heals missing projects-module tables per request.
const q = (sql, params) => runWithSchemaRepair(() => query(sql, params));

// RA (running account) bill lifecycle, following Indian construction billing.
// Payments may be partial: a bill stays 'approved' until payment_received
// reaches net_value, then flips to 'paid'.
const RA_STATUSES = ['draft', 'submitted', 'approved', 'paid'];
const DEFAULT_RETENTION_PCT = 7.5;

// Validate the mutable fields shared by create + draft edit. Retention/net are
// computed server-side via projectMath so the stored money always matches the
// one rounding rule (2 decimals) used by the client preview.
function parseInvoiceBody(body) {
    const has = (k) => body[k] !== undefined && body[k] !== null && String(body[k]) !== '';
    const period_start = has('period_start') ? String(body.period_start).slice(0, 10) : null;
    const period_end = has('period_end') ? String(body.period_end).slice(0, 10) : null;
    if (period_start && period_end && period_end < period_start) {
        return { ok: false, status: 400, message: 'Period end must be on or after period start' };
    }
    const gross = Number(body.gross_value);
    if (!Number.isFinite(gross) || gross <= 0) {
        return { ok: false, status: 400, message: 'Gross value must be greater than 0' };
    }
    const retentionPct = has('retention_pct') ? Number(body.retention_pct) : DEFAULT_RETENTION_PCT;
    if (!Number.isFinite(retentionPct) || retentionPct < 0 || retentionPct > 100) {
        return { ok: false, status: 400, message: 'Retention % must be between 0 and 100' };
    }
    return {
        ok: true,
        values: {
            period_start,
            period_end,
            remarks: has('remarks') ? String(body.remarks).trim() : null,
            gross_value: gross,
            retention_pct: retentionPct,
            retention_amount: projectMath.retentionAmount(gross, retentionPct),
            net_value: projectMath.netValue(gross, retentionPct)
        }
    };
}

// Next RA number for a project: RA-01, RA-02... computed from the max suffix so
// deleting the highest bill never reuses a number.
async function nextRaNumber(projectId) {
    const result = await q(
        `SELECT invoice_no FROM project_invoices WHERE project_id = $1`,
        [projectId]
    );
    let max = 0;
    for (const row of result.rows || []) {
        const m = /^RA-(\d+)$/i.exec(String(row.invoice_no || '').trim());
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return 'RA-' + String(max + 1).padStart(2, '0');
}

// Shared fetch (rows[0] or null).
async function getInvoice(projectId, invoiceId) {
    const result = await q(
        `SELECT pi.*, p.name as project_name,
            COALESCE(ab.first_name || ' ' || ab.last_name, '') as approved_by_name,
            COALESCE(cb.first_name || ' ' || cb.last_name, '') as created_by_name
         FROM project_invoices pi
         JOIN projects p ON p.id = pi.project_id
         LEFT JOIN employees ab ON ab.id = pi.approved_by
         LEFT JOIN employees cb ON cb.id = pi.created_by
         WHERE pi.project_id = $1 AND pi.id = $2`,
        [projectId, invoiceId]
    );
    return result.rows.length ? result.rows[0] : null;
}

/**
 * GET /api/project-invoices/:projectId
 * List RA bills for a project + a register summary (Indian RA-bill practice:
 * the register shows what is billed, held as retention, and received).
 */
router.get('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const result = await q(
            `SELECT pi.*, p.name as project_name
             FROM project_invoices pi
             JOIN projects p ON p.id = pi.project_id
             WHERE pi.project_id = $1
             ORDER BY pi.invoice_no`,
            [req.params.projectId]
        );
        const invoices = result.rows.map(mapRow);
        let gross = 0, net = 0, retention = 0, received = 0;
        let byStatus = { draft: 0, submitted: 0, approved: 0, paid: 0 };
        for (const inv of invoices) {
            gross += inv.gross_value;
            net += inv.net_value;
            retention += inv.retention_amount;
            received += inv.payment_received;
            if (byStatus[inv.status] !== undefined) byStatus[inv.status]++;
        }
        res.json({
            success: true,
            invoices,
            summary: {
                count: invoices.length,
                by_status: byStatus,
                total_gross: round2(gross),
                total_net: round2(net),
                total_retention: round2(retention),
                total_received: round2(received)
            }
        });
    } catch (error) {
        console.error(`Error listing invoices for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * GET /api/project-invoices/:projectId/:id
 * Single RA bill.
 */
router.get('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const invoice = await getInvoice(req.params.projectId, req.params.id);
        if (!invoice) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }
        res.json({ success: true, invoice: mapRow(invoice) });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/project-invoices/:projectId
 * Create a draft RA bill. Invoice number is auto-assigned (RA-01, RA-02...).
 */
router.post('/:projectId', verifyToken, isAdmin, async (req, res) => {
    try {
        const projectId = req.params.projectId;
        const proj = await q(`SELECT id, name FROM projects WHERE id = $1`, [projectId]);
        if (proj.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Project not found' });
        }
        const parsed = parseInvoiceBody(req.body);
        if (!parsed.ok) {
            return res.status(parsed.status).json({ success: false, message: parsed.message });
        }
        const v = parsed.values;
        const invoiceNo = await nextRaNumber(projectId);

        const result = await q(
            `INSERT INTO project_invoices
                (project_id, invoice_no, period_start, period_end, remarks,
                 gross_value, retention_pct, retention_amount, net_value, status, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10)
             RETURNING *`,
            [projectId, invoiceNo, v.period_start, v.period_end, v.remarks,
             v.gross_value, v.retention_pct, v.retention_amount, v.net_value, req.user.id]
        );
        const created = mapRow(result.rows[0]);
        logAudit({
            actorId: req.user.id, action: 'invoice.create', entityType: 'project_invoice',
            entityId: created.id, details: { projectId, invoiceNo, gross: created.gross_value, retentionPct: created.retention_pct },
            ip: req.ip
        });
        res.json({ success: true, invoice: created });
    } catch (error) {
        console.error(`Error creating invoice for project ${req.params.projectId}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * PUT /api/project-invoices/:projectId/:id
 * Edit a DRAFT RA bill only. Bills that are submitted/approved/paid are frozen
 * (they represent a certified claim; edits must go through reject/revise).
 */
router.put('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const existing = await getInvoice(req.params.projectId, req.params.id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }
        if (existing.status !== 'draft') {
            return res.status(400).json({ success: false, message: 'Only draft invoices can be edited. Reject/revise the bill to change it.' });
        }
        const parsed = parseInvoiceBody(req.body);
        if (!parsed.ok) {
            return res.status(parsed.status).json({ success: false, message: parsed.message });
        }
        const v = parsed.values;
        const result = await q(
            `UPDATE project_invoices SET
                period_start = $1, period_end = $2, remarks = $3,
                gross_value = $4, retention_pct = $5, retention_amount = $6, net_value = $7,
                updated_at = NOW()
             WHERE project_id = $8 AND id = $9
             RETURNING *`,
            [v.period_start, v.period_end, v.remarks,
             v.gross_value, v.retention_pct, v.retention_amount, v.net_value,
             req.params.projectId, req.params.id]
        );
        const updated = mapRow(result.rows[0]);
        logAudit({
            actorId: req.user.id, action: 'invoice.update', entityType: 'project_invoice',
            entityId: updated.id, details: { projectId: req.params.projectId, invoiceNo: updated.invoice_no, gross: updated.gross_value },
            ip: req.ip
        });
        res.json({ success: true, invoice: updated });
    } catch (error) {
        console.error(`Error updating invoice ${req.params.id}:`, error);
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/project-invoices/:projectId/:id/submit
 * draft -> submitted (bill presented to the client/PM for certification).
 */
router.post('/:projectId/:id/submit', verifyToken, isAdmin, async (req, res) => {
    try {
        const existing = await getInvoice(req.params.projectId, req.params.id);
        if (!existing) return res.status(404).json({ success: false, message: 'Invoice not found' });
        if (existing.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft invoices can be submitted' });
        const result = await q(
            `UPDATE project_invoices SET status = 'submitted', updated_at = NOW()
             WHERE project_id = $1 AND id = $2 RETURNING *`,
            [req.params.projectId, req.params.id]
        );
        logAudit({
            actorId: req.user.id, action: 'invoice.submit', entityType: 'project_invoice',
            entityId: result.rows[0].id, details: { projectId: req.params.projectId, invoiceNo: existing.invoice_no },
            ip: req.ip
        });
        res.json({ success: true, invoice: mapRow(result.rows[0]) });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/project-invoices/:projectId/:id/approve
 * submitted -> approved (certified by the architect/PM; retention held).
 */
router.post('/:projectId/:id/approve', verifyToken, isAdmin, async (req, res) => {
    try {
        const existing = await getInvoice(req.params.projectId, req.params.id);
        if (!existing) return res.status(404).json({ success: false, message: 'Invoice not found' });
        if (existing.status !== 'submitted') return res.status(400).json({ success: false, message: 'Only submitted invoices can be approved' });
        const result = await q(
            `UPDATE project_invoices SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
             WHERE project_id = $2 AND id = $3 RETURNING *`,
            [req.user.id, req.params.projectId, req.params.id]
        );
        logAudit({
            actorId: req.user.id, action: 'invoice.approve', entityType: 'project_invoice',
            entityId: result.rows[0].id, details: { projectId: req.params.projectId, invoiceNo: existing.invoice_no, net: existing.net_value },
            ip: req.ip
        });
        res.json({ success: true, invoice: mapRow(result.rows[0]) });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/project-invoices/:projectId/:id/reject
 * submitted -> draft (bill sent back with a note for revision).
 */
router.post('/:projectId/:id/reject', verifyToken, isAdmin, async (req, res) => {
    try {
        const existing = await getInvoice(req.params.projectId, req.params.id);
        if (!existing) return res.status(404).json({ success: false, message: 'Invoice not found' });
        if (existing.status !== 'submitted') return res.status(400).json({ success: false, message: 'Only submitted invoices can be rejected' });
        const note = req.body && req.body.note ? String(req.body.note).trim() : null;
        const result = await q(
            `UPDATE project_invoices SET status = 'draft', rejected_note = $1, updated_at = NOW()
             WHERE project_id = $2 AND id = $3 RETURNING *`,
            [note, req.params.projectId, req.params.id]
        );
        logAudit({
            actorId: req.user.id, action: 'invoice.reject', entityType: 'project_invoice',
            entityId: result.rows[0].id, details: { projectId: req.params.projectId, invoiceNo: existing.invoice_no, note },
            ip: req.ip
        });
        res.json({ success: true, invoice: mapRow(result.rows[0]), message: 'Invoice rejected (back to draft)' });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * POST /api/project-invoices/:projectId/:id/pay
 * Record payment against an approved bill. Accepts an optional partial amount;
 * the bill flips to 'paid' only when payment_received reaches net_value.
 */
router.post('/:projectId/:id/pay', verifyToken, isAdmin, async (req, res) => {
    try {
        const existing = await getInvoice(req.params.projectId, req.params.id);
        if (!existing) return res.status(404).json({ success: false, message: 'Invoice not found' });
        if (existing.status !== 'approved') return res.status(400).json({ success: false, message: 'Only approved invoices can receive payment' });
        const net = Number(existing.net_value) || 0;
        const already = Number(existing.payment_received) || 0;
        const bodyAmount = req.body && req.body.amount !== undefined && req.body.amount !== null && String(req.body.amount) !== ''
            ? Number(req.body.amount) : null;
        const amount = bodyAmount === null ? net : bodyAmount;
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Payment amount must be greater than 0' });
        }
        const received = round2(already + amount);
        let finalStatus = 'approved';
        if (received >= net - 0.005) {
            finalStatus = 'paid';
        } else if (received > net + 0.005) {
            return res.status(400).json({ success: false, message: `Payment exceeds the bill net value (${net})` });
        }
        const result = await q(
            `UPDATE project_invoices SET payment_received = $1, status = $2, paid_at = CASE WHEN $2 = 'paid' THEN NOW() ELSE paid_at END, updated_at = NOW()
             WHERE project_id = $3 AND id = $4 RETURNING *`,
            [received, finalStatus, req.params.projectId, req.params.id]
        );
        logAudit({
            actorId: req.user.id, action: finalStatus === 'paid' ? 'invoice.paid' : 'invoice.partial_payment', entityType: 'project_invoice',
            entityId: result.rows[0].id, details: { projectId: req.params.projectId, invoiceNo: existing.invoice_no, amount, received, net },
            ip: req.ip
        });
        res.json({ success: true, invoice: mapRow(result.rows[0]), message: finalStatus === 'paid' ? 'Invoice marked paid' : 'Partial payment recorded' });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

/**
 * DELETE /api/project-invoices/:projectId/:id
 * Remove a draft/submitted bill. Approved and paid bills are kept (they are a
 * financial record); close them via payment + project closeout instead.
 */
router.delete('/:projectId/:id', verifyToken, isAdmin, async (req, res) => {
    try {
        const existing = await getInvoice(req.params.projectId, req.params.id);
        if (!existing) return res.status(404).json({ success: false, message: 'Invoice not found' });
        if (existing.status !== 'draft' && existing.status !== 'submitted') {
            return res.status(400).json({ success: false, message: 'Approved or paid invoices cannot be deleted' });
        }
        await q(
            `DELETE FROM project_invoices WHERE project_id = $1 AND id = $2`,
            [req.params.projectId, req.params.id]
        );
        logAudit({
            actorId: req.user.id, action: 'invoice.delete', entityType: 'project_invoice',
            entityId: existing.id, details: { projectId: req.params.projectId, invoiceNo: existing.invoice_no },
            ip: req.ip
        });
        res.json({ success: true, message: 'Invoice deleted' });
    } catch (error) {
        const r = pgErrorResponse(error);
        res.status(r.status).json({ success: false, message: r.message });
    }
});

// Normalize numeric/timestamp columns for JSON (pg returns DECIMAL as strings).
function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}
function mapRow(row) {
    if (!row) return row;
    return {
        ...row,
        gross_value: round2(row.gross_value),
        retention_pct: round2(row.retention_pct),
        retention_amount: round2(row.retention_amount),
        net_value: round2(row.net_value),
        payment_received: round2(row.payment_received)
    };
}

module.exports = router;