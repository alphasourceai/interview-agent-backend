'use strict';
// Real PostgreSQL only in a dedicated Unix-socket disposable cluster. No hosted
// DB/Auth/Stripe/mail connection; provider IDs and all identity data synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildRetailPackageSnapshot } = require('../src/services/membershipPackageCompatibility');
const { OFFER_VERSION, retailTermWindow } = require('../src/services/membershipOffers');
const enabled = process.env.RETAIL_EXISTING_TERMS_DISPOSABLE === 'true';
const options = { skip: !enabled };
const root = path.resolve(__dirname, '..');
const migration = path.join(root, 'supabase/migrations/20261012230107_retail_existing_flow_pricing_terms.sql');
const psql = '/opt/homebrew/opt/postgresql@17/bin/psql';
const paidAt = '2026-01-31T15:45:00.000Z';
if (enabled) {
  assert.match(process.env.PGHOST || '', /^\/private\/tmp\/alphascreen-retail-existing-pg\.[A-Za-z0-9]+$/);
  assert.equal(process.env.PGPORT, '55449');
  assert.equal(process.env.PGDATABASE, 'postgres');
  assert.equal(process.env.PGUSER, 'postgres');
  assert.equal(process.env.PGPASSWORD, undefined);
}
function sql(text, database = 'postgres') {
  assert.ok(['postgres', 'retail_pricing_drift_test'].includes(database));
  return execFileSync(psql, ['-X', '-A', '-t', '-d', database, '-v', 'ON_ERROR_STOP=1'], { input: text, encoding: 'utf8' }).trim();
}
const quote = value => value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${quote(JSON.stringify(value))}::jsonb`;
let sequence = 100;
function rows(plan = 'basic', months = 3, payment = 'prepaid', role = false) {
  const n = String(++sequence).padStart(12, '0');
  const s = structuredClone(buildRetailPackageSnapshot({ planKey: plan, commitmentMonths: months, paymentOption: payment,
    firstRolePrepaySelected: role, channel: 'sales', offerVersion: OFFER_VERSION }));
  const a = { id: `22222222-2222-4222-8222-${n}`, membership_tier: plan, billing_option: s.billing_cadence,
    auto_renew: true, signer_accepted: true, template_version: 'membership_agreement_retail_terms_v2',
    template_snapshot: { source: payment === 'prepaid' ? 'public_purchase_intent' : 'sales_assisted',
      template_version: 'membership_agreement_retail_terms_v2', package_snapshot: s, purchase_intent: { id: `11111111-1111-4111-8111-${n}` },
      values: { membership_tier: plan, billing_option: s.billing_cadence, commitment_months: months, payment_option: payment,
        pricing_version: s.pricing_version, term_start_basis: 'successful_payment', auto_renew: true,
        platform_fee: String(s.platform_fee), per_role_fee: String(s.per_role_fee), additional_interview_fee: String(s.additional_interview_fee),
        included_interviews_per_role: String(s.included_interviews_per_role), max_interview_minutes: String(s.max_interview_minutes),
        first_role_prepay: { ...s.first_role_prepay } } } };
  const i = { id: `11111111-1111-4111-8111-${n}`, agreement_id: a.id, protocol: 'fenced_v2', selected_plan_key: plan,
    selected_billing_cadence: s.billing_cadence, package_snapshot: structuredClone(s), first_role_prepay_selected: role,
    first_role_prepay_amount_cents: role ? s.first_role_prepay.discounted_credit_amount_cents : null,
    first_role_normal_role_fee_cents: role ? s.first_role_prepay.normal_role_fee_cents : null,
    first_role_prepay_discount_percent: role ? 10 : null, first_role_prepay_credit_type: role ? 'first_role_prepay' : null,
    term_start_basis: 'successful_payment' };
  return { a, i, s, client: `33333333-3333-4333-8333-${n}`, claim: `SYNTHETIC_RETAIL_CLAIM_${n}`, months };
}
function setup(r) {
  const { a, i } = r;
  sql(`insert into public.membership_agreements(id,membership_tier,billing_option,auto_renew,signer_accepted,template_version,
      template_snapshot,signed_at,agreement_expires_at,initial_term_start,initial_renewal_date)
    values (${quote(a.id)},${quote(a.membership_tier)},${quote(a.billing_option)},true,true,${quote(a.template_version)},
      ${json(a.template_snapshot)},'2026-01-01Z','2026-02-15Z','2099-01-01','2099-12-31');
    insert into public.public_purchase_intents(id,agreement_id,status,protocol,selected_plan_key,selected_billing_cadence,package_snapshot,
      first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,
      first_role_prepay_credit_type,term_start_basis,stripe_checkout_session_id,buyer_email,company_legal_name,expires_at)
    values (${quote(i.id)},${quote(a.id)},'checkout_pending','fenced_v2',${quote(i.selected_plan_key)},${quote(i.selected_billing_cadence)},${json(i.package_snapshot)},
      ${i.first_role_prepay_selected},${quote(i.first_role_prepay_amount_cents)},${quote(i.first_role_normal_role_fee_cents)},
      ${quote(i.first_role_prepay_discount_percent)},${quote(i.first_role_prepay_credit_type)},'successful_payment','cs_SYNTHETIC_${sequence}',
      'native-retail@example.invalid','Synthetic Native Retail','2026-02-15Z');
    select public.claim_public_purchase_activation(${quote(a.id)},${quote(r.claim)});`);
}
function complete(r, overrides = {}) {
  const window = retailTermWindow({ originalStart: paidAt, commitmentMonths: r.months });
  return `public.complete_public_purchase_activation(${quote(r.a.id)},${quote(r.claim)},${quote(overrides.paidAt || paidAt)},
    'cs_SYNTHETIC_${sequence}',${quote(r.client)},true,${quote(r.s.plan_key)},${quote(r.s.billing_cadence)},
    ${quote(overrides.start || window.original_start_at?.slice(0, 10) || paidAt.slice(0, 10))},${quote(overrides.end || window.term_end_at.slice(0, 10))})`;
}
function billing(r) {
  const { s, i } = r, w = retailTermWindow({ originalStart: paidAt, commitmentMonths: r.months });
  return `public.apply_public_purchase_billing(${quote(i.id)},${quote(r.claim)},${quote(r.client)},${quote(r.client)},
    'cus_SYNTHETIC_NATIVE','sub_SYNTHETIC_NATIVE','active','active',${quote(s.billing_cadence)},${quote(s.plan_key)},
    ${quote(w.term_end_at)},false,true,null,${quote(paidAt)},${quote(w.term_end_at)},${s.platform_fee},${s.per_role_fee},
    ${s.included_interviews_per_role},${s.additional_interview_fee},${s.max_interview_minutes},${i.first_role_prepay_selected},
    ${quote(i.first_role_prepay_credit_type)},${quote(i.first_role_normal_role_fee_cents)},${quote(i.first_role_prepay_amount_cents)},
    ${quote(i.first_role_prepay_discount_percent)},${i.first_role_prepay_selected ? 'true,false' : 'null,null'})`;
}

function prepareDatabase(database = 'postgres') {
  sql(fs.readFileSync(path.join(__dirname, 'fixtures/qa-activation-fence-disposable-bootstrap.sql'), 'utf8'), database);
  sql(`create schema private_auth;
    alter table public.membership_agreements add column membership_tier text, add column billing_option text,
      add column auto_renew boolean, add column signer_accepted boolean, add column template_version text,
      add column template_snapshot jsonb, add column signed_at timestamptz, add column agreement_expires_at timestamptz;
    alter table public.public_purchase_intents add column expires_at timestamptz;
    alter table public.client_plan_settings add constraint client_plan_settings_billing_interval_check check(billing_interval in ('monthly','annual'));
    alter table public.membership_agreements add constraint membership_agreements_billing_option_check check(billing_option in ('monthly','annual'));
    create table public.retail_signup_email_verifications (billing_cadence text constraint retail_signup_email_verifications_billing_cadence_check check(billing_cadence in ('monthly','annual')));
    create table private_auth.retail_signup_sms_verifications (billing_cadence text constraint retail_signup_sms_verifications_billing_cadence_check check(billing_cadence in ('monthly','annual')));`, database);
  sql(fs.readFileSync(path.join(root, 'supabase/migrations/20261001131612_qa_public_purchase_activation_fences.sql'), 'utf8'), database);
}
test('setup actual activation fences and pricing compatibility in disposable PG only', options, () => {
  prepareDatabase();
  sql(fs.readFileSync(migration, 'utf8'));
});
test('original native legacy completion/billing/member/welcome assertions remain unchanged', options, () => {
  const read = name => fs.readFileSync(path.join(__dirname, `fixtures/qa-activation-fence-disposable-${name}-assertions.sql`), 'utf8');
  // Each original fixture assumes its own clean data set. Completion and
  // billing are independent; member/welcome intentionally share billing state.
  sql(`begin;\n${read('completion')}\nrollback;`);
  // Those three fixtures contain their own rollback sub-scenarios and expect
  // the initial billing setup to commit first; do not wrap them in an outer
  // transaction that their ROLLBACK would accidentally discard.
  sql(`${read('billing')}\n${read('member')}\n${read('welcome')}`);
});
for (const plan of ['basic', 'pro']) for (const months of [3, 6, 12])
  for (const payment of ['prepaid', 'monthly_installments']) for (const role of [false, true]) {
    test(`native existing completion/billing ${plan}/${months}/${payment}/role:${role}`, options, () => {
      const r = rows(plan, months, payment, role); setup(r);
      assert.equal(JSON.parse(sql(`select ${complete(r)};`)).status, 'completed');
      assert.equal(JSON.parse(sql(`select ${billing(r)};`)).status, 'applied');
      const record = JSON.parse(sql(`select jsonb_build_object('start',c.contract_start_at,'end',c.contract_end_at,
        'cadence',c.billing_interval,'fee',p.platform_fee,'start_date',a.initial_term_start,'renewal',a.initial_renewal_date,'paid',a.checkout_paid_at,
        'intent_paid',i.activated_at,'credits',(select count(*) from public.client_role_credits where source_public_purchase_intent_id=i.id))
        from public.clients c join public.client_plan_settings p on p.client_id=c.id
        join public.membership_agreements a on a.client_id=c.id join public.public_purchase_intents i on i.agreement_id=a.id where c.id=${quote(r.client)};`));
      assert.equal(new Date(record.start).toISOString(), paidAt);
      assert.equal(new Date(record.end).toISOString(), retailTermWindow({ originalStart: paidAt, commitmentMonths: months }).term_end_at);
      assert.equal(record.cadence, r.s.billing_cadence); assert.equal(record.fee, r.s.platform_fee);
      assert.equal(record.start_date, paidAt.slice(0,10));
      assert.equal(record.renewal, retailTermWindow({ originalStart: paidAt, commitmentMonths: months }).term_end_at.slice(0,10));
      assert.equal(new Date(record.paid).toISOString(), new Date(record.intent_paid).toISOString());
      assert.equal(record.credits, role ? 1 : 0);
      // Replay leaves original clocks/fees/credit unchanged and returns the
      // existing billing identity, not another receipt or a provider charge.
      assert.equal(JSON.parse(sql(`select ${billing(r)};`)).status, 'already_applied');
    });
  }
// Staff may sell BOTH prepaid and monthly installments. Public checkout is
// prepaid-only. This is the approved sales catalog, not an exclusive split.
for (const plan of ['basic', 'pro']) for (const months of [3, 6, 12]) for (const role of [false, true]) {
  test(`native staff prepaid is allowed ${plan}/${months}/role:${role}`, options, () => {
    const r = rows(plan, months, 'prepaid', role);
    r.a.template_snapshot.source = 'sales_assisted'; setup(r);
    assert.equal(JSON.parse(sql(`select ${complete(r)};`)).status, 'completed');
    assert.equal(JSON.parse(sql(`select ${billing(r)};`)).status, 'applied');
  });
}
test('native anchors derive from original UTC day/time, including leap/nonleap January31', options, () => {
  for (const year of [2024, 2026]) for (const months of [1, 2, 3, 6, 12]) {
    const start = `${year}-01-31T15:45:00.000Z`;
    const expected = require('../src/services/membershipOffers').anchoredMonthInstant(start, months);
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      const result = sql(`set timezone=${quote(zone)}; select public.retail_existing_month_anchor(${quote(start)},${months});`).split('\n').at(-1);
      assert.equal(new Date(result).toISOString(), expected);
    }
  }
});
test('native new clocks and wrong dates reject with zero completion DML', options, () => {
  for (const tweak of ["update public.membership_agreements set checkout_paid_at='2026-01-31T15:45Z' where id=ID;",
    "update public.public_purchase_intents set activated_at='2026-01-31T15:45Z' where agreement_id=ID;", '']) {
    const r = rows(); setup(r);
    if (tweak) sql(tweak.replace('ID', quote(r.a.id)));
    const fn = complete(r, tweak ? {} : { end: '2027-01-31' });
    sql(`do $$ begin begin perform ${fn}; raise exception 'expected refusal';
      exception when sqlstate '22023' then null; end;
      if exists(select 1 from public.clients where id=${quote(r.client)})
        or exists(select 1 from public.membership_agreements where id=${quote(r.a.id)} and checkout_status='paid')
      then raise exception 'unexpected completion DML'; end if; end $$;`);
  }
});
test('native replay cannot replace the paired original paid clock or renewal date', options, () => {
  const r = rows(); setup(r); sql(`select ${complete(r)};`);
  const before = sql(`select to_jsonb(a) from public.membership_agreements a where id=${quote(r.a.id)};`);
  sql(`do $$ begin begin perform ${complete(r, { paidAt: '2026-02-01T15:45:00.000Z' })};
    raise exception 'expected replay refusal'; exception when sqlstate '22023' then null; end; end $$;`);
  assert.equal(sql(`select to_jsonb(a) from public.membership_agreements a where id=${quote(r.a.id)};`), before);
});
test('native malformed/mixed sources, channel, role and signed-value changes cannot write a client or paid agreement', options, () => {
  const edits = [
    r => `update public.public_purchase_intents set package_snapshot=jsonb_set(package_snapshot,'{pricing_protocol}','"wrong"') where id=${quote(r.i.id)};`,
    r => `update public.membership_agreements set template_snapshot=jsonb_set(template_snapshot,'{package_snapshot}',
      '{"plan_key":"basic","billing_cadence":"monthly","platform_fee":299}') where id=${quote(r.a.id)};`,
    r => `update public.public_purchase_intents set package_snapshot='{"plan_key":"basic","billing_cadence":"monthly","platform_fee":299}' where id=${quote(r.i.id)};`,
    r => `update public.membership_agreements set template_snapshot=jsonb_set(template_snapshot,'{values,commitment_months}','12') where id=${quote(r.a.id)};`,
    r => `update public.membership_agreements set template_snapshot=jsonb_set(template_snapshot,'{values,platform_fee}','"1"') where id=${quote(r.a.id)};`,
    r => `update public.membership_agreements set template_version='membership_agreement_v2_phase1' where id=${quote(r.a.id)};`,
    r => `update public.membership_agreements set signer_accepted=false where id=${quote(r.a.id)};`,
    r => `update public.public_purchase_intents set first_role_prepay_selected=true where id=${quote(r.i.id)};`,
    r => `update public.membership_agreements set template_snapshot=jsonb_set(template_snapshot,'{source}','"admin_without_intent"') where id=${quote(r.a.id)};`,
    r => `update public.membership_agreements set checkout_paid_at='2026-01-31T15:45Z' where id=${quote(r.a.id)};
      update public.public_purchase_intents set activated_at='2026-02-01T15:45Z' where id=${quote(r.i.id)};`,
    r => `update public.membership_agreements set agreement_expires_at='2026-01-30Z' where id=${quote(r.a.id)};`,
    r => `update public.public_purchase_intents set term_start_basis='agreement_date' where id=${quote(r.i.id)};`
  ];
  for (const edit of edits) {
    const r = rows(); setup(r); sql(edit(r));
    sql(`do $$ begin begin perform ${complete(r)}; raise exception 'expected source refusal';
      exception when sqlstate '22023' then null; end;
      if exists(select 1 from public.clients where id=${quote(r.client)})
        or exists(select 1 from public.membership_agreements where id=${quote(r.a.id)} and checkout_status='paid')
      then raise exception 'unexpected source DML'; end if; end $$;`);
  }
  const r = rows('basic', 3, 'monthly_installments'); setup(r);
  sql(`update public.membership_agreements set template_snapshot=jsonb_set(template_snapshot,'{source}','"public_purchase_intent"') where id=${quote(r.a.id)};`);
  sql(`do $$ begin begin perform ${complete(r)}; raise exception 'expected public installment refusal';
    exception when sqlstate '22023' then null; end; end $$;`);
});
test('native original writer cancellation, supersession and expired-lease fences still refuse new terms', options, () => {
  for (const [edit, expected] of [
    [r => `update public.public_purchase_intents set status='canceled' where id=${quote(r.i.id)};`, 'purchase_canceled'],
    [r => `update public.membership_agreements set superseded_by_agreement_id='44444444-4444-4444-8444-444444444444' where id=${quote(r.a.id)};`, 'agreement_superseded'],
    [r => `update public.public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '10 minutes' where id=${quote(r.i.id)};`, 'activation_fence_lost']
  ]) {
    const r = rows(); setup(r); sql(edit(r));
    assert.equal(JSON.parse(sql(`select ${complete(r)};`)).status, expected);
    assert.equal(sql(`select count(*) from public.clients where id=${quote(r.client)};`), '0');
  }
});
test('browser roles have no native pricing helper or activation writer execute privilege', options, () => {
  for (const role of ['anon', 'authenticated']) {
    assert.equal(sql(`select has_function_privilege(${quote(role)},'public.retail_existing_terms_months(jsonb,jsonb)','EXECUTE');`), 'f');
    assert.equal(sql(`select has_function_privilege(${quote(role)},'public.complete_public_purchase_activation(uuid,text,timestamptz,text,uuid,boolean,text,text,date,date)','EXECUTE');`), 'f');
  }
  assert.equal(sql("select has_function_privilege('service_role','public.retail_existing_terms_months(jsonb,jsonb)','EXECUTE');"), 't');
});
test('writer assignment source drift rolls back all compatibility DDL in a second isolated database', options, () => {
  sql('create database retail_pricing_drift_test template template0;');
  prepareDatabase('retail_pricing_drift_test');
  sql(`do $$ declare d text; begin
    d:=pg_get_functiondef('public.apply_public_purchase_billing(uuid,text,uuid,uuid,text,text,text,text,text,text,timestamptz,boolean,boolean,timestamptz,timestamptz,timestamptz,numeric,numeric,integer,numeric,integer,boolean,text,integer,integer,integer,boolean,boolean)'::regprocedure);
    d:=replace(d,'contract_end_at = p_contract_end_at','contract_end_at = clock_timestamp()');
    execute d; end $$;`, 'retail_pricing_drift_test');
  assert.throws(() => sql(fs.readFileSync(migration, 'utf8'), 'retail_pricing_drift_test'), /retail_activation_assignment_source_drift/);
  assert.equal(sql("select to_regprocedure('public.retail_existing_month_anchor(timestamptz,integer)') is null;", 'retail_pricing_drift_test'), 't');
  assert.equal(sql(`select count(*) from pg_constraint where conname in (
    'client_plan_settings_billing_interval_check','membership_agreements_billing_option_check',
    'retail_signup_email_verifications_billing_cadence_check','retail_signup_sms_verifications_billing_cadence_check')
    and pg_get_constraintdef(oid) like '%prepaid%';`, 'retail_pricing_drift_test'), '0');
});
