'use strict';
// Real private PostgreSQL, synthetic native rows, no SDK/Auth/mail/network.
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const { buildRetailPackageSnapshot } = require('../src/services/membershipPackageCompatibility');
const { OFFER_VERSION } = require('../src/services/membershipOffers');
const enabled = process.env.RETAIL_CHECKOUT_ATTEMPT_DISPOSABLE === 'true', opts = { skip: !enabled };
const socket = process.env.PGHOST || '', port = '55451', bin = '/opt/homebrew/opt/postgresql@17/bin/';
const database = `retail_checkout_attempt_${process.pid}`, root = path.join(__dirname, '../supabase/migrations');
const migration = '20261013065832_retail_existing_checkout_attempts.sql';
const customer = 'cus_SYNTHETIC', config = { public_backend_base: 'https://api.example.invalid', public_sign_base: 'https://site.example.invalid' };
const lit = v => v == null ? 'null' : typeof v === 'object' ? `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`
  : typeof v === 'boolean' || typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
function run(q) { return cp.spawnSync(`${bin}psql`, ['-h', socket, '-p', port, '-U', 'postgres', '-X', '-q', '-At',
  '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', q], { encoding: 'utf8' }); }
function sql(q) { const r = run(q); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function denied(q, pattern) { const r = run(q); assert.notEqual(r.status, 0); assert.match(r.stderr, pattern); }
const apply = () => sql(fs.readFileSync(path.join(root, migration), 'utf8'));
const legacy = crypto.randomUUID(); let baseline, permissions;
before(() => {
  if (!enabled) return;
  assert.match(socket, /^\/private\/tmp\/alphascreen-checkout-attempt-pg\.[A-Za-z0-9]+$/);
  assert.equal(process.env.PGPASSWORD, undefined);
  let r = cp.spawnSync(`${bin}createdb`, ['-h', socket, '-p', port, '-U', 'postgres', database], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  sql(fs.readFileSync(path.join(__dirname, 'fixtures/qa-activation-fence-disposable-bootstrap.sql'), 'utf8'));
  sql(`alter role service_role bypassrls;
    alter table clients add column parent_client_id uuid, add column archived_at timestamptz;
    alter table membership_agreements add column membership_tier text,add column billing_option text,
      add column auto_renew boolean,add column signer_accepted boolean,add column template_version text,
      add column template_snapshot jsonb,add column signed_at timestamptz,add column agreement_expires_at timestamptz,
      add column checkout_created_at timestamptz,add column replaces_stripe_subscription_id text,add column signer_token_hash text;
    alter table public_purchase_intents add column protocol text,add column expires_at timestamptz,add column promotion_code_id text;
    grant usage on schema public to service_role;
    grant select,insert,update,delete on clients,membership_agreements,public_purchase_intents to service_role;
    alter table clients enable row level security;alter table membership_agreements enable row level security;
    alter table public_purchase_intents enable row level security;
    insert into membership_agreements(id,membership_tier,billing_option,checkout_created_at) values('${legacy}','basic','monthly','2026-09-01Z');`);
  // Install only the approved pure accepted-source helpers, not unrelated old
  // contract stores, Auth fixtures or mutable native billing writers.
  const source = fs.readFileSync(path.join(root, '20261012230107_retail_existing_flow_pricing_terms.sql'), 'utf8');
  sql(source.slice(source.indexOf('create or replace function public.retail_existing_month_anchor'),
    source.indexOf('-- Assert known CHECK source')));
  baseline = sql(`select to_jsonb(t) from membership_agreements t where id='${legacy}';`);
  permissions = acl(); apply();
});
after(() => { if (enabled) { const r = cp.spawnSync(`${bin}dropdb`, ['-h', socket, '-p', port, '-U', 'postgres', database], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); } });
function acl() { return sql(`select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl::text,'rls',relrowsecurity) order by relname)
  from pg_class where oid in('clients'::regclass,'membership_agreements'::regclass,'public_purchase_intents'::regclass);`); }
function fixture({ plan = 'basic', months = 3, payment = 'prepaid', source = 'admin', role = false } = {}) {
  const id = crypto.randomUUID(), client = crypto.randomUUID(), intent = crypto.randomUUID();
  const p = buildRetailPackageSnapshot({ planKey: plan, commitmentMonths: months, paymentOption: payment,
    firstRolePrepaySelected: role, channel: 'sales', offerVersion: OFFER_VERSION });
  const snapshot = { source, template_version: 'membership_agreement_retail_terms_v2', package_snapshot: p,
    values: { membership_tier: plan, billing_option: p.billing_cadence, commitment_months: months,
      payment_option: payment, pricing_version: p.pricing_version, term_start_basis: 'successful_payment', auto_renew: true,
      platform_fee: String(p.platform_fee), per_role_fee: String(p.per_role_fee), additional_interview_fee: String(p.additional_interview_fee),
      included_interviews_per_role: String(p.included_interviews_per_role), max_interview_minutes: String(p.max_interview_minutes),
      first_role_prepay: p.first_role_prepay } };
  if (source !== 'admin') snapshot.purchase_intent = { id: intent };
  sql(`set role service_role;insert into clients(id,name,email,stripe_customer_id) values('${client}','SYNTHETIC ONLY','owner@example.invalid','${customer}');
    insert into membership_agreements(id,client_id,status,is_current,membership_tier,billing_option,auto_renew,signer_accepted,
      template_version,template_snapshot,signed_at,agreement_expires_at,signer_token_hash)
    values('${id}','${client}','signed',true,${lit(plan)},${lit(p.billing_cadence)},true,true,'membership_agreement_retail_terms_v2',
      ${lit(snapshot)},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '7 days','${'a'.repeat(64)}');`);
  if (source !== 'admin') sql(`set role service_role;insert into public_purchase_intents(id,agreement_id,client_id,status,protocol,
      selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_credit_type,
      first_role_normal_role_fee_cents,first_role_prepay_amount_cents,first_role_prepay_discount_percent,term_start_basis,expires_at)
    values('${intent}','${id}','${client}','checkout_pending','fenced_v2',${lit(plan)},${lit(p.billing_cadence)},${lit(p)},${role},
      ${lit(role ? 'first_role_prepay' : null)},${lit(role ? p.first_role_prepay.normal_role_fee_cents : null)},
      ${lit(role ? p.first_role_prepay.discounted_credit_amount_cents : null)},${lit(role ? 10 : null)},'successful_payment',clock_timestamp()+interval '7 days');`);
  return { id, client, intent, snapshot, p };
}
function claim(r, { embedded = false, replacement = null, configuration = config, expected = r.snapshot, target = r.client, cust = customer } = {}) {
  return `select claim_retail_existing_checkout_attempt(${[r.id, target, expected, cust, embedded, replacement, configuration].map(lit).join(',')});`;
}
const claimed = (r, settings) => JSON.parse(sql(`set role service_role;${claim(r, settings)}`));
const row = r => JSON.parse(sql(`select to_jsonb(t) from membership_agreements t where id='${r.id}';`));
test('native migration preserves full legacy rows, table ACL/RLS; duplicate application refuses rather than overwriting', opts, () => {
  assert.equal(sql(`select to_jsonb(t)-'checkout_embedded'-'checkout_attempt_source' from membership_agreements t where id='${legacy}';`), baseline);
  assert.equal(acl(), permissions);
  denied(fs.readFileSync(path.join(root, migration), 'utf8'), /retail_checkout_schema_drift/);
  assert.equal(acl(), permissions);
});
test('real admin/sales/public native sources across terms/options/role choices produce stable request identity, not paid terms', opts, () => {
  for (const plan of ['basic', 'pro']) for (const months of [3, 6, 12]) for (const payment of ['prepaid', 'monthly_installments']) {
    for (const source of ['admin', 'sales_assisted', ...(payment === 'prepaid' ? ['public_purchase_intent'] : [])]) {
      for (const role of [false, true]) {
      const r = fixture({ plan, months, payment, source, role }), before = row(r), first = claimed(r), second = claimed(r);
      assert.deepEqual(first, second); assert.equal(first.embedded, false);
      assert.equal(first.replacement_id, null); assert.equal(first.checkout_session_id, null);
      const after = row(r);
      for (const field of ['template_snapshot', 'client_id', 'status', 'is_current', 'checkout_status', 'checkout_paid_at', 'initial_term_start', 'initial_renewal_date']) {
        assert.deepEqual(after[field], before[field], field);
      }
      assert.ok(first.expires_at <= Math.floor(Date.parse(first.created_at) / 1000) + 86400 - 1);
      }
    }
  }
});
function parallel(q) { return new Promise((resolve, reject) => {
  const child = cp.spawn(`${bin}psql`, ['-h', socket, '-p', port, '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', q]);
  let out = '', err = '';child.stdout.on('data', v => out += v);child.stderr.on('data', v => err += v);child.on('error', reject);
  child.on('close', code => resolve({ code, out: out.trim(), err }));
}); }
test('actual competing native transactions share first clock/config/mode; loser cannot flip Checkout transport', opts, async () => {
  const r = fixture();
  const [winner, loser] = await Promise.all([
    parallel(`set role service_role;begin;${claim(r, { embedded: true })}select pg_sleep(0.15);commit;`),
    parallel(`set role service_role;select pg_sleep(0.025);${claim(r, { embedded: false,
      configuration: { ...config, public_sign_base: 'https://other.example.invalid' } })}`)
  ]);
  assert.equal(winner.code, 0, winner.err);assert.equal(loser.code, 0, loser.err);
  const parse = s => JSON.parse(s.split('\n').find(line => line.startsWith('{')));
  assert.deepEqual(parse(winner.out), parse(loser.out));
  assert.equal(parse(loser.out).embedded, row(r).checkout_embedded);
  assert.deepEqual(parse(loser.out).source.config, row(r).checkout_attempt_source.config);
});
test('paid/superseded/stale source/customer/untracked checkout and invalid canonical config write nothing', opts, () => {
  for (const [update, override] of [
    ["checkout_status='paid'", {}], ["checkout_paid_at=clock_timestamp()", {}], ["is_current=false", {}],
    ["status='voided'", {}], ["checkout_session_id='cs_OLD'", {}], ["checkout_created_at=clock_timestamp()", {}],
    ['', { expected: { synthetic: 'wrong' } }], ['', { target: crypto.randomUUID() }], ['', { cust: 'cus_OTHER' }],
    ['', { configuration: { ...config, public_backend_base: 'https://name:password@example.invalid' } }],
    ['', { configuration: { ...config, public_sign_base: 'https://site.example.invalid?token=FAKE' } }],
    ['', { embedded: null }], ['', { replacement: 'not_a_subscription' }]]) {
    const r = fixture();if (update) sql(`update membership_agreements set ${update} where id='${r.id}';`);
    const before = row(r);denied(`set role service_role;${claim(r, override)}`, /retail_checkout_/);assert.deepEqual(row(r), before);
  }
});
test('attempt fields/commercial source and first linked Session cannot be moved; lifecycle status/paid bookkeeping may change', opts, () => {
  const r = fixture();claimed(r, { replacement: 'sub_ORIGINAL' });
  for (const patch of ["checkout_created_at=clock_timestamp()", 'checkout_embedded=true', 'checkout_attempt_source=null',
    "replaces_stripe_subscription_id='sub_OTHER'", "membership_tier='pro'", "template_snapshot=template_snapshot||'{\"extra\":1}'"]) {
    denied(`set role service_role;update membership_agreements set ${patch} where id='${r.id}';`, /immutable/);
  }
  denied(`set role service_role;${claim(r)}`, /retail_checkout_attempt_changed/);
  sql(`set role service_role;update membership_agreements set checkout_session_id='cs_PINNED',checkout_status='pending_payment' where id='${r.id}';`);
  denied(`set role service_role;update membership_agreements set checkout_session_id='cs_OTHER' where id='${r.id}';`, /session_immutable/);
  sql(`set role service_role;update membership_agreements set checkout_status='paid',checkout_paid_at=clock_timestamp(),
    initial_term_start=current_date,initial_renewal_date=current_date+90,is_current=false,status='superseded' where id='${r.id}';`);
  assert.equal(row(r).checkout_status, 'paid');
});
test('native source forgery on direct update cannot bypass claim and no caller supplies attempt clock', opts, () => {
  const r = fixture();
  denied(`set role service_role;update membership_agreements set checkout_embedded=false,checkout_created_at='2099-01-01Z',
    checkout_attempt_source='{"config":{"public_backend_base":"https://api.example.invalid","public_sign_base":"https://site.example.invalid"}}'
    where id='${r.id}';`, /source_mismatch/);
  assert.equal(row(r).checkout_created_at, null);const actual = claimed(r);
  assert.ok(Date.parse(actual.created_at) < Date.parse('2099-01-01Z'));
});
test('real current clock refuses short/expired legal windows and canceled linked source; no mutation', opts, () => {
  for (const interval of ["29 minutes", "-1 minute"]) {
    const r = fixture();sql(`update membership_agreements set agreement_expires_at=clock_timestamp()+interval '${interval}' where id='${r.id}';`);
    const before = row(r);denied(`set role service_role;${claim(r)}`, /claim_denied|window_closed/);assert.deepEqual(row(r), before);
  }
  const r = fixture({ source: 'sales_assisted' });sql(`update public_purchase_intents set status='canceled',canceled_at=clock_timestamp() where id='${r.intent}';`);
  denied(`set role service_role;${claim(r)}`, /claim_denied/);assert.equal(row(r).checkout_created_at, null);
});
test('browser roles cannot claim or call source helpers; no new definer or table access', opts, () => {
  const r = fixture();
  for (const role of ['anon', 'authenticated']) denied(`set role ${role};${claim(r)}`, /permission denied/);
  assert.equal(sql(`select bool_and(not prosecdef) from pg_proc where pronamespace='public'::regnamespace
    and proname in('claim_retail_existing_checkout_attempt','retail_existing_checkout_material','retail_existing_checkout_config_valid','retail_existing_checkout_attempt_guard');`), 't');
  assert.equal(acl(), permissions);
});
test('UTC source normalization ignores session timezone; customer/promo drift after claim refuses without moving clock', opts, () => {
  const r = fixture({ source: 'sales_assisted', payment: 'monthly_installments' }), initial = claimed(r);
  assert.deepEqual(JSON.parse(sql(`set role service_role;set time zone 'Asia/Kolkata';${claim(r)}`)), initial);
  sql(`update clients set stripe_customer_id='cus_CHANGED' where id='${r.client}';`);
  const before = row(r);denied(`set role service_role;${claim(r)}`, /customer_changed/);assert.deepEqual(row(r), before);
  sql(`update clients set stripe_customer_id='${customer}' where id='${r.client}';
    update public_purchase_intents set promotion_code_id='promo_CHANGED' where id='${r.intent}';`);
  denied(`set role service_role;${claim(r)}`, /attempt_changed/);assert.deepEqual(row(r), before);
});
test('fault-injected old retained attempt is refused by real current clock; guard restored before RPC', opts, () => {
  const r = fixture();claimed(r);
  // Test-only time travel, not product admission/backfill: fixture owner changes
  // its own retained clock under an explicitly disabled guard, reinstates the
  // exact trigger, then calls the real RPC as service_role with no supplied now.
  sql(`alter table membership_agreements disable trigger retail_existing_checkout_attempt_guard;
    update membership_agreements set checkout_created_at=clock_timestamp()-interval '25 hours' where id='${r.id}';
    alter table membership_agreements enable trigger retail_existing_checkout_attempt_guard;`);
  const before = row(r);denied(`set role service_role;${claim(r)}`, /window_closed/);assert.deepEqual(row(r), before);
});
test('prerequisite source drift is rejected without replacing prior functions or touching stored attempts', opts, () => {
  const definition = sql(`select pg_get_functiondef('retail_existing_package(jsonb)'::regprocedure);`);
  sql(`create or replace function public.retail_existing_package(p_offer jsonb) returns jsonb language sql immutable
    security invoker set search_path=pg_catalog as 'select null::jsonb';`);
  denied(fs.readFileSync(path.join(root, migration), 'utf8'), /prerequisite_drift/);
  sql(definition);assert.equal(acl(), permissions);
});
test('oversized native accepted source is refused without committing an attempt', opts, () => {
  const r = fixture();sql(`update membership_agreements set template_snapshot=jsonb_set(template_snapshot,
    '{rendered_html}',to_jsonb(repeat('x',1048576))) where id='${r.id}';`);
  const q = claim(r).replace(lit(r.snapshot), `(select template_snapshot from membership_agreements where id='${r.id}')`);
  denied(`set role service_role;${q}`, /source_too_large/);
  assert.equal(sql(`select checkout_created_at is null and checkout_attempt_source is null from membership_agreements where id='${r.id}';`), 't');
});
test('ambiguous native intent association is refused before a clock or transport is recorded', opts, () => {
  const r = fixture({ source: 'sales_assisted' });
  sql(`insert into public_purchase_intents(id,agreement_id,client_id,status,protocol,expires_at)
    values('${crypto.randomUUID()}','${r.id}','${r.client}','checkout_pending','fenced_v2',clock_timestamp()+interval '7 days');`);
  const before = row(r);denied(`set role service_role;${claim(r)}`, /intent_ambiguous/);assert.deepEqual(row(r), before);
});
