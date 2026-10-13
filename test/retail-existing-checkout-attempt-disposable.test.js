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
      add column checkout_created_at timestamptz,add column replaces_stripe_subscription_id text,add column signer_token_hash text,
      add column replacement_policy text,add column replacement_error text;
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
  // Fixture-only pre-existing non-service writer, constrained by native RLS.
  // Capture these grants before the migration, which must not broaden them.
  sql(`create role synthetic_legacy_writer;
    grant usage on schema public to synthetic_legacy_writer;
    grant select,update on membership_agreements to synthetic_legacy_writer;
    create policy synthetic_legacy_select on membership_agreements for select to synthetic_legacy_writer
      using(id='${legacy}'::uuid);
    create policy synthetic_legacy_update on membership_agreements for update to synthetic_legacy_writer
      using(id='${legacy}'::uuid) with check(id='${legacy}'::uuid);`);
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
test('native open-status allowlists refuse NULL, unknown and terminal intent statuses and unknown agreement Checkout statuses', opts, () => {
  const nullRow = fixture({ source: 'sales_assisted' });
  denied(`update public_purchase_intents set status=null where id='${nullRow.intent}';`, /not-null constraint/);
  // NULL is natively impossible on this baseline; test the real constraint
  // rather than weakening it for an invented admissible row.
  for (const status of ['failed', 'expired', 'completed', 'canceled', 'unexpected_status']) {
    const r = fixture({ source: 'sales_assisted' });sql(`update public_purchase_intents set status=${lit(status)} where id='${r.intent}';`);
    const before = row(r);denied(`set role service_role;${claim(r)}`, /claim_denied/);assert.deepEqual(row(r), before);
  }
  for (const status of ['failed', 'unknown', 'expired']) {
    const r = fixture();sql(`update membership_agreements set checkout_status=${lit(status)} where id='${r.id}';`);
    const before = row(r);denied(`set role service_role;${claim(r)}`, /claim_denied/);assert.deepEqual(row(r), before);
  }
  const r = fixture({ source: 'sales_assisted' });sql(`update public_purchase_intents set status='agreement_pending' where id='${r.intent}';`);
  assert.equal(claimed(r).agreement_id, r.id);
});
test('pre-existing non-service legacy writer retains native RLS-constrained DML without trigger EXECUTE; claims remain denied', opts, () => {
  assert.equal(sql(`select has_function_privilege('synthetic_legacy_writer','retail_existing_checkout_attempt_guard()','EXECUTE');`), 'f');
  sql(`set role synthetic_legacy_writer;begin;update membership_agreements set updated_at=clock_timestamp() where id='${legacy}';rollback;`);
  denied(`set role synthetic_legacy_writer;update membership_agreements set checkout_embedded=false,
    checkout_attempt_source='{}'::jsonb where id='${legacy}';`, /claim_denied/);
  assert.equal(sql(`select to_jsonb(t)-'checkout_embedded'-'checkout_attempt_source' from membership_agreements t where id='${legacy}';`), baseline);
  assert.equal(acl(), permissions);
});

const pinMigration = '20261013075424_retail_existing_checkout_session_pin.sql';
const pin = (r, attempt, session) => `select pin_retail_existing_checkout_session(${[r.id, r.client, attempt, session].map(lit).join(',')});`;
test('native Session pin writes both existing links atomically, replays same identity and never moves first request clock', opts, () => {
  sql(fs.readFileSync(path.join(root, pinMigration), 'utf8'));
  for (const source of ['admin', 'sales_assisted', 'public_purchase_intent']) {
    const r = fixture({ source }), attempt = claimed(r, { replacement: 'sub_ORIGINAL' });
    const result = JSON.parse(sql(`set role service_role;${pin(r, attempt, 'cs_PINNED')}`));
    assert.deepEqual(result, { ...attempt, checkout_session_id: 'cs_PINNED' });
    assert.deepEqual(JSON.parse(sql(`set role service_role;${pin(r, attempt, 'cs_PINNED')}`)), result);
    assert.deepEqual(JSON.parse(sql(`set role service_role;${pin(r, result, 'cs_PINNED')}`)), result);
    const final = row(r);
    assert.equal(Date.parse(final.checkout_created_at), Date.parse(attempt.created_at));
    assert.equal(final.checkout_status, 'pending_payment');assert.equal(final.replacement_policy, 'immediate_cancel');
    if (source !== 'admin') assert.deepEqual(JSON.parse(sql(`select jsonb_build_array(stripe_checkout_session_id,status)
      from public_purchase_intents where id='${r.intent}';`)), ['cs_PINNED', 'checkout_pending']);
    denied(`set role service_role;${pin(r, attempt, 'cs_OTHER')}`, /pin_attempt_changed/);
    assert.equal(row(r).checkout_session_id, 'cs_PINNED');
  }
  assert.equal(acl(), permissions);
});
test('native pin rejects invented attempt, conflicting intent, changed source/customer and paid rows without partial links', opts, () => {
  for (const kind of ['fake', 'intent', 'customer', 'paid', 'superseded', 'promo']) {
    const r = fixture({ source: 'sales_assisted', payment: 'monthly_installments' }), attempt = claimed(r);
    if (kind === 'intent') sql(`update public_purchase_intents set stripe_checkout_session_id='cs_OTHER' where id='${r.intent}';`);
    if (kind === 'customer') sql(`update clients set stripe_customer_id='cus_CHANGED' where id='${r.client}';`);
    if (kind === 'paid') sql(`update membership_agreements set checkout_paid_at=clock_timestamp() where id='${r.id}';`);
    if (kind === 'superseded') sql(`update membership_agreements set is_current=false where id='${r.id}';`);
    if (kind === 'promo') sql(`update public_purchase_intents set promotion_code_id='promo_OTHER' where id='${r.intent}';`);
    const before = row(r), intentBefore = sql(`select to_jsonb(t) from public_purchase_intents t where id='${r.intent}';`);
    const candidate = kind === 'fake' ? { ...attempt, expires_at: attempt.expires_at + 1 } : attempt;
    denied(`set role service_role;${pin(r, candidate, 'cs_NEW')}`, /retail_checkout_/);
    assert.deepEqual(row(r), before);assert.equal(sql(`select to_jsonb(t) from public_purchase_intents t where id='${r.intent}';`), intentBefore);
  }
  const r = fixture(), attempt = claimed(r);
  for (const role of ['anon', 'authenticated']) denied(`set role ${role};${pin(r, attempt, 'cs_NEW')}`, /permission denied/);
});
test('real concurrent native Session pins share same Session, and a competing different Session cannot replace it', opts, async () => {
  const r = fixture({ source: 'sales_assisted' }), attempt = claimed(r);
  const [a, b] = await Promise.all([
    parallel(`set role service_role;begin;${pin(r, attempt, 'cs_SHARED')}select pg_sleep(0.1);commit;`),
    parallel(`set role service_role;${pin(r, attempt, 'cs_SHARED')}`)
  ]);
  assert.equal(a.code, 0, a.err);assert.equal(b.code, 0, b.err);
  denied(`set role service_role;${pin(r, attempt, 'cs_DIFFERENT')}`, /pin_attempt_changed/);
  assert.equal(row(r).checkout_session_id, 'cs_SHARED');
});
test('failed native intent link rolls back the agreement link in the same transaction', opts, () => {
  const r = fixture({ source: 'sales_assisted' }), attempt = claimed(r), before = row(r);
  sql(`create function synthetic_reject_session_link() returns trigger language plpgsql as $$begin
    if new.stripe_checkout_session_id='cs_ROLLBACK' then raise exception 'synthetic_link_failure';end if;return new;end$$;
    create trigger synthetic_reject_session_link before update on public_purchase_intents
    for each row execute function synthetic_reject_session_link();`);
  denied(`set role service_role;${pin(r, attempt, 'cs_ROLLBACK')}`, /synthetic_link_failure/);
  assert.deepEqual(row(r), before);
  assert.equal(sql(`select stripe_checkout_session_id is null from public_purchase_intents where id='${r.intent}';`), 't');
  sql(`drop trigger synthetic_reject_session_link on public_purchase_intents;drop function synthetic_reject_session_link();`);
});
test('native pin waits for concurrent customer write and rejects the newly committed different customer', opts, async () => {
  const r = fixture({ source: 'sales_assisted' }), attempt = claimed(r), before = row(r);
  const lock = cp.spawn(`${bin}psql`, ['-h', socket, '-p', port, '-U', 'postgres', '-X', '-q', '-At',
    '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', `begin;select id from clients where id='${r.client}' for update;
      select pg_sleep(0.3);update clients set stripe_customer_id='cus_MOVED' where id='${r.client}';commit;`]);
  await new Promise((resolve, reject) => { lock.stdout.once('data', resolve);lock.once('error', reject); });
  const done = new Promise((resolve, reject) => { lock.once('close', resolve);lock.once('error', reject); });
  const result = await parallel(`set role service_role;${pin(r, attempt, 'cs_RACED')}`);
  assert.equal(await done, 0);assert.notEqual(result.code, 0);assert.match(result.err, /customer_changed/);
  assert.deepEqual(row(r), before);
});
test('native Checkout expiry respects earlier linked intent deadline; later deadline edits cannot move the existing request', opts, () => {
  const r=fixture({source:'sales_assisted'});
  sql(`update public_purchase_intents set expires_at=clock_timestamp()+interval '2 hours' where id='${r.intent}';`);
  const attempt=claimed(r),deadline=Number(sql(`select floor(extract(epoch from expires_at)) from public_purchase_intents where id='${r.intent}';`));
  assert.equal(attempt.expires_at,deadline);assert.equal(Date.parse(attempt.source.intent.expires_at),
    Date.parse(sql(`select expires_at from public_purchase_intents where id='${r.intent}';`)));
  sql(`update public_purchase_intents set expires_at=expires_at+interval '1 hour' where id='${r.intent}';`);
  const before=row(r);denied(`set role service_role;${claim(r)}`,/attempt_changed/);
  denied(`set role service_role;${pin(r,attempt,'cs_MOVED_DEADLINE')}`,/attempt_changed/);assert.deepEqual(row(r),before);
});
test('native early linked expiry refuses a request even if the signed agreement remains open for days', opts, () => {
  const r=fixture({source:'public_purchase_intent'});
  sql(`update public_purchase_intents set expires_at=clock_timestamp()+interval '29 minutes' where id='${r.intent}';`);
  const before=row(r);denied(`set role service_role;${claim(r)}`,/window_closed/);assert.deepEqual(row(r),before);
});
test('actual existing Checkout service executes real native claim/pin and retrieves the same SDK-fake Session on retry', opts, async () => {
  // Real PostgreSQL row/RPC bridge; SDK and billing-customer lookup are injected
  // synthetic boundaries, NOT provider funding or hosted PostgREST acceptance.
  const paths=['../src/services/subscriptionCheckout','../src/clients/supabase','../src/services/clientBillingScope',
    '../src/config/urlConfig'].map(p=>require.resolve(p));paths.push(require.resolve('stripe'));
  const saved=new Map(paths.map(p=>[p,require.cache[p]]));
  const inject=(p,exports)=>{require.cache[p]={id:p,filename:p,loaded:true,exports};};
  const token='SYNTHETIC_NATIVE_CHECKOUT_TOKEN';
  try {
    for(const source of ['admin','sales_assisted']) {
      const r=fixture({source,plan:'pro',months:6,payment:'monthly_installments',role:true});
      sql(`update membership_agreements set signer_token_hash='${crypto.createHash('sha256').update(token).digest('hex')}' where id='${r.id}';`);
      let payload,session,creates=0;const sdk={
        customers:{retrieve:async id=>({object:'customer',id,discount:null,balance:0}),update:async id=>({id})},
        subscriptions:{list:async()=>({data:[],has_more:false})},
        checkout:{sessions:{create:async p=>{
          creates++;payload=structuredClone(p);const total=p.line_items.reduce((a,l)=>a+l.price_data.unit_amount,0);
          session={object:'checkout.session',id:'cs_NATIVE_BRIDGE',mode:'subscription',status:'open',payment_status:'unpaid',
            customer,currency:'usd',livemode:false,subscription:null,ui_mode:'hosted',expires_at:p.expires_at,metadata:p.metadata,
            amount_subtotal:total,amount_total:total,url:'https://checkout.stripe.test/NATIVE_BRIDGE',
            success_url:p.success_url,cancel_url:p.cancel_url,allow_promotion_codes:p.allow_promotion_codes,
            total_details:{amount_discount:0,amount_tax:0,amount_shipping:0}};return session;
        },retrieve:async id=>{assert.equal(id,session.id);return session;},
        listLineItems:async()=>({object:'list',has_more:false,data:payload.line_items.map((l,n)=>({id:`li_NATIVE_${n}`,
          quantity:1,currency:'usd',amount_subtotal:l.price_data.unit_amount,price:{object:'price',id:`price_NATIVE_${n}`,
            currency:'usd',unit_amount:l.price_data.unit_amount,type:l.price_data.recurring?'recurring':'one_time',
            recurring:l.price_data.recurring?{...l.price_data.recurring,usage_type:'licensed'}:null}}))})}}
      };
      const db={from(table){return{select(){return this},eq(_k,value){this.value=value;return this},order(){return this},
        async maybeSingle(){assert.equal(table,'clients');return{data:JSON.parse(sql(`select to_jsonb(t) from clients t where id=${lit(this.value)};`)),error:null};},
        then(resolve,reject){assert.equal(table,'billing_customers');return Promise.resolve({data:[{id:'SYNTHETIC_BILLING',stripe_customer_id:customer}],error:null}).then(resolve,reject)}
      }},async rpc(name,args){
        assert.ok(['claim_retail_existing_checkout_attempt','pin_retail_existing_checkout_session'].includes(name));
        const values=name==='claim_retail_existing_checkout_attempt'
          ?[args.p_agreement,args.p_client,args.p_expected_template,args.p_customer,args.p_embedded,args.p_replacement,args.p_config]
          :[args.p_agreement,args.p_client,args.p_attempt,args.p_session];
        const result=run(`set role service_role;select public.${name}(${values.map(lit).join(',')});`);
        return result.status===0?{data:JSON.parse(result.stdout.trim()),error:null}:{data:null,error:{message:result.stderr}};
      }};
      delete require.cache[paths[0]];inject(paths[1],{supabaseAdmin:db});inject(paths[2],{requireParentClient:async()=>({ok:true})});
      inject(paths[3],{resolvePublicBackendBase:()=>config.public_backend_base,
        buildMembershipAgreementSignUrl:t=>`${config.public_sign_base}/membership-agreement/sign/${t}`,
        buildClientDashboardReturnUrl:()=>`${config.public_sign_base}/dashboard`});
      inject(paths[4],function Stripe(_key,options){assert.equal(options.apiVersion,'2023-10-16');return sdk;});
      const {createSubscriptionCheckoutSession:create}=require(paths[0]);
      const args={clientId:r.client,planTier:'pro',billingInterval:'monthly',packageSnapshot:r.p,metadataSource:'agreement_checkout',
        idempotencyKey:`agreement_checkout:${r.id}:pro:monthly`,retailAgreement:row(r),
        cancelUrl:`${config.public_sign_base}/membership-agreement/sign/${token}`};
      const first=await create(args),b=row(r).checkout_created_at;
      assert.equal(first.retailAttemptLinked,true);assert.equal(row(r).checkout_session_id,'cs_NATIVE_BRIDGE');
      if(source==='sales_assisted')assert.equal(sql(`select stripe_checkout_session_id from public_purchase_intents where id='${r.intent}';`),'cs_NATIVE_BRIDGE');
      const second=await create({...args,retailAgreement:row(r),embedded:true,
        requestContext:{forwardedHost:'untrusted.example.invalid',forwardedProto:'http'}});
      assert.equal(second.session.id,first.session.id);assert.equal(creates,1);assert.equal(row(r).checkout_created_at,b);
      assert.equal(second.checkoutClientSecret,null);
    }
  } finally { for(const p of paths){const original=saved.get(p);if(original)require.cache[p]=original;else delete require.cache[p];} }
});
