'use strict';

// Existing contract renewal processing. Two callers share it:
// the admin route and the internal cron route, which is why it is a service rather
// than living with either router.

const { supabaseAdmin } = require('../../clients/supabase');
const { readRetailPackageOffer } = require('../membershipPackageCompatibility');
const { retailTermWindow } = require('../membershipOffers');
const { legacyContractAction } = require('./legacyContractActions');

function invalidRetailRenewal() {
  throw new Error('retail_renewal_terms_mismatch');
}

function getRetailRenewalWindow(client, agreement) {
  const snapshot = agreement?.template_snapshot;
  const offer = readRetailPackageOffer(snapshot?.package_snapshot);
  const marker = 'membership_agreement_retail_terms_v2';
  if (!offer) {
    if (client?.billing_interval === 'prepaid' || agreement?.billing_option === 'prepaid'
      || agreement?.template_version === marker || snapshot?.template_version === marker) invalidRetailRenewal();
    return null; // Legacy contracts keep their original twelve-month behavior.
  }
  const original = new Date(agreement?.checkout_paid_at || NaN);
  const start = new Date(client?.contract_start_at || NaN);
  const end = new Date(client?.contract_end_at || NaN);
  if (agreement.client_id !== client.id || agreement.is_current !== true || agreement.status !== 'signed'
    || agreement.checkout_status !== 'paid' || agreement.superseded_by_agreement_id
    || agreement.template_version !== marker || snapshot.template_version !== marker
    || client.plan_tier !== offer.plan_key || agreement.membership_tier !== offer.plan_key
    || client.billing_interval !== (offer.payment_option === 'prepaid' ? 'prepaid' : 'monthly')
    || agreement.billing_option !== client.billing_interval
    || !Number.isFinite(original.getTime()) || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) invalidRetailRenewal();
  const offset = (start.getUTCFullYear() - original.getUTCFullYear()) * 12 + start.getUTCMonth() - original.getUTCMonth();
  if (offset < 0 || offset % offer.commitment_months !== 0) invalidRetailRenewal();
  const termIndex = offset / offer.commitment_months;
  const current = retailTermWindow({originalStart:original.toISOString(), commitmentMonths:offer.commitment_months, termIndex});
  if (Date.parse(current.term_start_at) !== start.getTime() || Date.parse(current.term_end_at) !== end.getTime()) invalidRetailRenewal();
  return retailTermWindow({originalStart:original.toISOString(), commitmentMonths:offer.commitment_months, termIndex:termIndex + 1});
}

function addMonthsToIso(isoString, monthsToAdd = 12) {
  const base = new Date(isoString)
  if (Number.isNaN(base.getTime())) return null
  const next = new Date(base.getTime())
  next.setUTCMonth(next.getUTCMonth() + monthsToAdd)
  return next.toISOString()
}

async function processContractRenewals(context = {}, dependencies = {}) {
  require('../../config/guardedPricingDev').assertGuardedDevOutboundAllowed();
  const db = dependencies.db || supabaseAdmin;
  const triggerSource = String(context?.triggerSource || 'admin')
  const requestId = context?.requestId || null
  const triggeredByUserId = context?.triggeredByUserId || null
  const triggeredByEmail = context?.triggeredByEmail || null
  const now = dependencies.now || new Date()
  const nowMs = now.getTime()
  const startedAt = now.toISOString()
  let runId = null

  try {
    const { data: startedRun, error: startedRunError } = await db
      .from('contract_processing_runs')
      .insert({
        trigger_source: triggerSource,
        started_at: startedAt,
        request_id: requestId,
        triggered_by_user_id: triggeredByUserId,
        triggered_by_email: triggeredByEmail
      })
      .select('id')
      .maybeSingle()
    if (!startedRunError) {
      runId = startedRun?.id || null
    }
  } catch (_) {}

  try {
    let stripe = dependencies.stripe || null
    try {
      const stripeKey = String(process.env.STRIPE_SECRET_KEY || '')
      if (!stripe && stripeKey) {
        stripe = require('../../clients/stripe')
      }
    } catch (_) {}

    const { data: clients, error } = await db
      .from('clients')
      .select('id,name,plan_tier,billing_interval,billing_status,manual_active_override,contract_start_at,contract_end_at,auto_renew,cancel_effective_at,stripe_subscription_id,stripe_customer_id,subscription_status,cancel_at_term_end,parent_client_id,archived_at')

    if (error) {
      const e = new Error(error.message || 'process_contracts_failed')
      e.detail = error.message || 'process_contracts_failed'
      throw e
    }

    const summary = {
      scanned: (clients || []).length,
      due: 0,
      renewed: 0,
      deactivated: 0,
      held_retail_payment: 0,
      skipped_manual_override: 0,
      skipped_no_action: 0,
      errors: 0
    }
    const items = []
    const heldAction = (client,action) => {
      if (!['changed','held'].includes(action?.status)) return false;
      const held=action.status==='held';
      summary[held?'held_retail_payment':'skipped_no_action']+=1;
      items.push({id:client.id,name:client.name||null,action:held?'held_retail_payment':'skipped_no_action',
        contract_end_at_before:client.contract_end_at,detail:held?'retail_paid_period_processor_required':'legacy_contract_guard_changed'});
      return true;
    };

    for (const client of (clients || [])) {
      const oldContractEnd = client?.contract_end_at || null
      if (!oldContractEnd) continue

      const oldEndDate = new Date(oldContractEnd)
      if (Number.isNaN(oldEndDate.getTime())) continue
      if (oldEndDate.getTime() > nowMs) continue

      summary.due += 1

      if (client?.manual_active_override === true) {
        summary.skipped_manual_override += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'skipped_manual_override',
          contract_end_at_before: oldContractEnd
        })
        continue
      }

      let retailWindow = null;
      try {
        // Inspect the current row before filtering by payment/signature status:
        // an unpaid/malformed new agreement must not disappear into legacy.
        const {data:agreement, error:agreementError} = await db.from('membership_agreements')
          .select('id,client_id,status,is_current,checkout_status,checkout_paid_at,membership_tier,billing_option,template_version,template_snapshot,superseded_by_agreement_id')
          .eq('client_id', client.id).eq('is_current', true).maybeSingle();
        if (agreementError) throw new Error(agreementError.message || 'renewal_agreement_read_failed');
        retailWindow = getRetailRenewalWindow(client, agreement);
      } catch (e) {
        summary.errors += 1;
        items.push({id:client.id, name:client.name || null, action:'error', contract_end_at_before:oldContractEnd,
          detail:e.message || 'renewal_terms_failed'});
        continue;
      }

      // This legacy calendar scanner has no proof of the next paid period.
      // Neither auto-renew nor the original payment authorizes a new term;
      // nonrenewal must not cancel installments still owed in the current term.
      // The paid-period processor must own both decisions. This read-time hold
      // is not an atomic exclusion against a concurrent legacy -> retail cutover.
      if (retailWindow) {
        summary.held_retail_payment += 1;
        items.push({id:client.id, name:client.name || null, action:'held_retail_payment',
          contract_end_at_before:oldContractEnd, detail:'retail_paid_period_processor_required'});
        continue;
      }

      if (client?.auto_renew === true) {
        const newContractStart = retailWindow?.term_start_at || oldEndDate.toISOString()
        const newContractEnd = retailWindow?.term_end_at || addMonthsToIso(newContractStart, 12)
        if (!newContractEnd) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: 'invalid_contract_end_at'
          })
          continue
        }

        // Conditional on the value this run read, so two concurrent runs cannot both
        // renew the same client and advance the term twice. The loser matches no rows.
        const {data:renewedClient, error:renewError} = await legacyContractAction(db,client,'renew');

        if (renewError) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: renewError.message || 'renew_update_failed'
          })
          continue
        }

        if(heldAction(client,renewedClient))continue;
        if(renewedClient?.status!=='applied'||Date.parse(renewedClient.client.contract_start_at)!==Date.parse(newContractStart)
          ||Date.parse(renewedClient.client.contract_end_at)!==Date.parse(newContractEnd)){
          summary.errors+=1;items.push({id:client.id,name:client.name||null,action:'error',contract_end_at_before:oldContractEnd,detail:'legacy_contract_action_unavailable'});continue;
        }

        summary.renewed += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'renewed',
          contract_end_at_before: oldContractEnd,
          contract_end_at_after: newContractEnd
        })
        continue
      }

      const localSubStatus = String(client?.subscription_status || '').toLowerCase()
      const stripeAlignmentNeeded =
        !!client?.stripe_subscription_id &&
        (localSubStatus === 'active' || localSubStatus === 'trialing') &&
        client?.cancel_at_term_end !== true
      const alreadyInactiveProcessed =
        String(client?.billing_status || '').toLowerCase() === 'inactive' &&
        !!client?.cancel_effective_at
      let actionClient=client;

      if (alreadyInactiveProcessed && !stripeAlignmentNeeded) {
        summary.skipped_no_action += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'skipped_no_action',
          contract_end_at_before: oldContractEnd,
          detail: 'already_inactive'
        })
        continue
      }

      if (!alreadyInactiveProcessed) {
        const cancelEffectiveAt = oldEndDate.toISOString()
        const {data:deactivatedClient, error:deactivateError} = await legacyContractAction(db,client,'deactivate');

        if (deactivateError) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: deactivateError.message || 'deactivate_update_failed'
          })
          continue
        }
        if(heldAction(client,deactivatedClient))continue;
        if(!['applied','unchanged'].includes(deactivatedClient?.status)||deactivatedClient.client.billing_status!=='inactive'
          ||Date.parse(deactivatedClient.client.cancel_effective_at)!==Date.parse(cancelEffectiveAt)){
          summary.errors+=1;items.push({id:client.id,name:client.name||null,action:'error',contract_end_at_before:oldContractEnd,detail:'legacy_contract_action_unavailable'});continue;
        }
        actionClient=deactivatedClient.client;
      }

      let stripeAlignmentError = null
      let stripeCancelAtTermEnd = false
      if (stripeAlignmentNeeded) {
        if (!stripe) {
          stripeAlignmentError = 'stripe_client_unavailable'
          summary.errors += 1
        } else {
          try {
            const checked=await legacyContractAction(db,actionClient,'check_cancel');
            if(checked.error||checked.data?.status!=='permitted')throw new Error('legacy_contract_action_unavailable');
            await stripe.subscriptions.update(client.stripe_subscription_id, { cancel_at_period_end: true })
            const recorded=await legacyContractAction(db,checked.data.client,'record_cancel');
            const localStripeFlagError=recorded.error||(!['applied','unchanged'].includes(recorded.data?.status)||recorded.data?.client?.cancel_at_term_end!==true
              ?{message:'legacy_contract_action_unavailable'}:null);
            if (localStripeFlagError) {
              stripeAlignmentError = localStripeFlagError.message || 'cancel_at_term_end_update_failed'
              summary.errors += 1
            } else {
              stripeCancelAtTermEnd = true
            }
          } catch (e) {
            stripeAlignmentError = e?.message || 'stripe_cancel_at_period_end_failed'
            summary.errors += 1
          }
        }
      }

      if (alreadyInactiveProcessed) {
        const alignedItem = {
          id: client.id,
          name: client.name || null,
          action: 'aligned_stripe_cancel',
          contract_end_at_before: oldContractEnd
        }
        if (stripeAlignmentError) alignedItem.stripe_alignment_error = stripeAlignmentError
        if (stripeCancelAtTermEnd) alignedItem.stripe_cancel_at_term_end = true
        items.push(alignedItem)
        continue
      }

      summary.deactivated += 1
      const deactivatedItem = {
        id: client.id,
        name: client.name || null,
        action: 'deactivated',
        contract_end_at_before: oldContractEnd,
        billing_status_after: 'inactive'
      }
      if (stripeAlignmentError) deactivatedItem.stripe_alignment_error = stripeAlignmentError
      if (stripeCancelAtTermEnd) deactivatedItem.stripe_cancel_at_term_end = true
      items.push(deactivatedItem)
    }

    const result = { ok: true, summary, items }
    const completedAt = new Date().toISOString()
    try {
      if (runId) {
        await db
          .from('contract_processing_runs')
          .update({
            completed_at: completedAt,
            processed_ok: true,
            summary,
            items
          })
          .eq('id', runId)
      } else {
        await db
          .from('contract_processing_runs')
          .insert({
            trigger_source: triggerSource,
            started_at: startedAt,
            completed_at: completedAt,
            processed_ok: true,
            summary,
            items,
            request_id: requestId,
            triggered_by_user_id: triggeredByUserId,
            triggered_by_email: triggeredByEmail
          })
      }
    } catch (_) {}

    return result
  } catch (e) {
    const completedAt = new Date().toISOString()
    const detail = e?.detail || e?.message || 'process_contracts_failed'
    try {
      if (runId) {
        await db
          .from('contract_processing_runs')
          .update({
            completed_at: completedAt,
            processed_ok: false,
            error: detail
          })
          .eq('id', runId)
      } else {
        await db
          .from('contract_processing_runs')
          .insert({
            trigger_source: triggerSource,
            started_at: startedAt,
            completed_at: completedAt,
            processed_ok: false,
            error: detail,
            request_id: requestId,
            triggered_by_user_id: triggeredByUserId,
            triggered_by_email: triggeredByEmail
          })
      }
    } catch (_) {}
    throw e
  }
}

module.exports = { addMonthsToIso, processContractRenewals, getRetailRenewalWindow };
