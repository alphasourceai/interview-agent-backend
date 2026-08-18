begin;

create index if not exists sms_spend_reservations_candidate_idx
  on private_auth.sms_spend_reservations (candidate_id);

commit;
