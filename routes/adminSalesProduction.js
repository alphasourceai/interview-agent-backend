'use strict';

const express = require('express');

const LINE_IDS = Object.freeze([
  '21000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000002',
  '21000000-0000-4000-8000-000000000003',
  '21000000-0000-4000-8000-000000000004',
]);

async function rows(db, table, columns, orderKey = 'id') {
  const pageSize = 500;
  const result = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error, count } = await db.from(table)
      .select(columns, { count: 'exact' })
      .order(orderKey, { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw Object.assign(new Error('Sales administration data is unavailable'), { code: error.code });
    if (!Array.isArray(data) || typeof count !== 'number') throw new Error('Sales administration data is incomplete');
    result.push(...data);
    if (result.length >= count) return result;
    if (data.length === 0) throw new Error('Sales administration data is incomplete');
  }
}

function buildSalesProductionOverview(data, env = process.env) {
  const members = new Map(data.members.map((row) => [row.id, row]));
  const reps = new Map(data.reps.map((row) => [row.user_id, row]));
  const phones = new Map(data.phones.map((row) => [row.id, row]));
  const assignments = new Map();
  for (const row of data.assignments) {
    if (!LINE_IDS.includes(row.phone_number_id)) continue;
    const prior = assignments.get(row.phone_number_id);
    if (!prior || (row.status === 'active' && prior.status !== 'active')) assignments.set(row.phone_number_id, row);
  }
  const configs = new Map();
  for (const row of data.configs) {
    const prior = configs.get(row.assignment_id);
    if (!prior || (row.is_current && !prior.is_current)) configs.set(row.assignment_id, row);
  }
  const lines = LINE_IDS.map((id, index) => {
    const phone = phones.get(id);
    const assignment = assignments.get(id);
    const member = assignment ? members.get(assignment.team_member_id) : null;
    const config = assignment ? configs.get(assignment.id) : null;
    const rep = member?.sales_rep_user_id ? reps.get(member.sales_rep_user_id) : null;
    return {
      slot: index + 1,
      phone_number: phone?.e164 || null,
      phone_active: phone?.active === true,
      shared_voice_entrypoint: phone?.shared_voice_entrypoint === true,
      assignment_status: assignment?.status || 'unassigned',
      representative: member ? {
        name: member.display_name,
        workspace_email: member.workspace_email,
        member_status: member.status,
        dashboard_link_active: rep?.active === true,
        ghl_user_linked: Boolean(member.ghl_user_id),
        slack_user_linked: Boolean(member.slack_user_id),
      } : null,
      voice_configuration: config ? {
        status: config.status,
        current: config.is_current === true,
        email: config.notify_email === true,
        slack: config.notify_slack === true,
        sms: config.notify_sms === true,
      } : null,
    };
  });
  const bindingStates = {};
  for (const row of data.bindings) bindingStates[row.status] = (bindingStates[row.status] || 0) + 1;
  const deliveryStates = {};
  for (const row of data.deliveries) deliveryStates[row.status] = (deliveryStates[row.status] || 0) + 1;
  return {
    generated_at: new Date().toISOString(),
    mode: 'production',
    call_policy: 'GHL Web App or Mobile App; personal-number forwarding is not configured by alphaScreen',
    settings: {
      sales_writes_enabled: env.SALES_PRODUCTION_WRITES_ENABLED === 'true',
      ghl_import_enabled: env.GHL_SALES_SYNC_ENABLED === 'true',
      voice_routes_enabled: env.SALES_VOICE_DB_ROUTES_ENABLED === 'true',
      voice_handoff_enabled: env.SALES_VOICE_HANDOFF_ENABLED === 'true',
      provider_sync_enabled: env.SALES_TEAM_PROVIDER_SYNC_ENABLED === 'true',
      team_channel_enabled: env.SALES_WON_TEAM_CHANNEL_ENABLED === 'true',
    },
    lines,
    ghl_sync: {
      bindings_by_status: bindingStates,
      deliveries_by_status: deliveryStates,
      manual_review_count: data.bindings.filter((row) => row.manual_review_required === true).length,
    },
  };
}

function createAdminSalesProductionRouter({ db, env = process.env } = {}) {
  const router = express.Router();
  router.get('/', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!db) return res.status(503).json({ error: 'sales_admin_unavailable' });
    try {
      const [members, reps, phones, assignments, configs, bindings, deliveries] = await Promise.all([
        rows(db, 'sales_team_members', 'id,sales_rep_user_id,display_name,workspace_email,ghl_user_id,slack_user_id,status'),
        rows(db, 'sales_reps', 'user_id,active', 'user_id'),
        rows(db, 'sales_phone_numbers', 'id,e164,active,shared_voice_entrypoint'),
        rows(db, 'sales_phone_assignments', 'id,team_member_id,phone_number_id,status'),
        rows(db, 'sales_voice_configs', 'assignment_id,status,is_current,notify_email,notify_slack,notify_sms'),
        rows(db, 'ghl_sales_deal_bindings', 'status,manual_review_required'),
        rows(db, 'sales_integration_deliveries', 'integration,status'),
      ]);
      return res.json(buildSalesProductionOverview({
        members, reps, phones, assignments, configs, bindings,
        deliveries: deliveries.filter((row) => row.integration === 'ghl'),
      }, env));
    } catch (error) {
      console.error('[admin-sales-production] read_failed', { code: error.code || null });
      return res.status(503).json({ error: 'sales_admin_unavailable' });
    }
  });
  return router;
}

module.exports = { buildSalesProductionOverview, createAdminSalesProductionRouter };
