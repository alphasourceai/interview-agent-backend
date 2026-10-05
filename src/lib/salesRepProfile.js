'use strict'

// Narrow public projection. Never return provider configuration or personal phones.
async function salesRepProfile(rep, db) {
  const profile = { ...rep, business_phone_e164: null }
  if (rep.access_role !== 'sales_rep') return profile
  const member = await db.from('sales_team_members').select('id')
    .eq('sales_rep_user_id', rep.user_id).eq('status', 'active').maybeSingle()
  if (member.error) throw new Error('sales_profile_unavailable')
  if (!member.data) return profile
  const assignment = await db.from('sales_phone_assignments').select('phone_number_id')
    .eq('team_member_id', member.data.id).eq('status', 'active').maybeSingle()
  if (assignment.error) throw new Error('sales_profile_unavailable')
  if (!assignment.data) return profile
  const phone = await db.from('sales_phone_numbers').select('e164')
    .eq('id', assignment.data.phone_number_id).eq('active', true).maybeSingle()
  if (phone.error) throw new Error('sales_profile_unavailable')
  if (/^\+1[2-9][0-9]{9}$/.test(phone.data?.e164 || '')) profile.business_phone_e164 = phone.data.e164
  return profile
}

module.exports = { salesRepProfile }
