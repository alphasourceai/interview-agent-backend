'use strict';

// client_plan_settings.max_interview_minutes is NOT NULL with no default in the
// hosted database, and no migration here defines it, so nothing in a fake would
// otherwise notice a write that sends null or creates a row without it.
//
// Wraps a fake Supabase client so every insert, upsert and update on
// client_plan_settings is checked the way Postgres would: an explicit null, or a
// new row that leaves the column out, is refused with code 23502 and recorded in
// db.notNullViolations for the test to assert on.

const NOT_NULL_COLUMNS = Object.freeze(['max_interview_minutes']);

function failedQuery(error) {
  const result = { data: null, error };
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    is() { return chain; },
    neq() { return chain; },
    in() { return chain; },
    maybeSingle() { return Promise.resolve(result); },
    single() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); }
  };
  return chain;
}

function guardPlanSettingsNotNull(db, { columns = NOT_NULL_COLUMNS } = {}) {
  db.notNullViolations = [];
  const innerFrom = db.from;

  const rowExists = (payload) => (db.tables?.client_plan_settings || [])
    .some((row) => String(row?.client_id ?? '') === String(payload?.client_id ?? ''));

  const violationIn = (payloads, creating) => {
    for (const payload of payloads) {
      for (const column of columns) {
        const sendsNull = Object.prototype.hasOwnProperty.call(payload || {}, column) && payload[column] == null;
        const leavesOut = !Object.prototype.hasOwnProperty.call(payload || {}, column) && creating(payload);
        if (sendsNull || leavesOut) return column;
      }
    }
    return null;
  };

  const refuse = (column) => {
    db.notNullViolations.push(column);
    return failedQuery({
      code: '23502',
      message: `null value in column "${column}" of relation "client_plan_settings" violates not-null constraint`
    });
  };

  db.from = (table) => {
    const query = innerFrom(table);
    if (table !== 'client_plan_settings') return query;

    const { insert, upsert, update } = query;
    if (insert) {
      query.insert = (payload, ...rest) => {
        const column = violationIn([].concat(payload), () => true);
        return column ? refuse(column) : insert.call(query, payload, ...rest);
      };
    }
    if (upsert) {
      query.upsert = (payload, ...rest) => {
        const column = violationIn([].concat(payload), (row) => !rowExists(row));
        return column ? refuse(column) : upsert.call(query, payload, ...rest);
      };
    }
    if (update) {
      query.update = (payload, ...rest) => {
        const column = violationIn([payload], () => false);
        return column ? refuse(column) : update.call(query, payload, ...rest);
      };
    }
    return query;
  };
  return db;
}

module.exports = { NOT_NULL_COLUMNS, guardPlanSettingsNotNull };
