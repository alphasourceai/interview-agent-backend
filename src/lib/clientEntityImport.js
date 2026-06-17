'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanText(value) {
  return String(value ?? '').trim();
}

function cleanLower(value) {
  return cleanText(value).toLowerCase();
}

function readField(row, keys) {
  if (!row || typeof row !== 'object') return '';
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return '';
}

function normalizeImportRole(value) {
  const normalized = cleanLower(value).replace(/[\s-]+/g, '_');
  if (!normalized) return '';
  if (normalized === 'manager') return 'manager';
  if (normalized === 'member') return 'member';
  return normalized;
}

function isEmptyImportRow(row) {
  if (!row || typeof row !== 'object') return true;
  return [
    readField(row, ['name', 'Name']),
    readField(row, ['location_type', 'Location type', 'Location Type']),
    readField(row, ['location_user_email', 'Location user email', 'Location User Email']),
    readField(row, ['member_role', 'Manager/Member designation', 'Manager/Member Designation']),
  ].every((value) => !cleanText(value));
}

function normalizeImportRow(row, index) {
  const name = cleanText(readField(row, ['name', 'Name']));
  const locationType = cleanLower(readField(row, ['location_type', 'Location type', 'Location Type']));
  const locationUserEmail = cleanLower(readField(row, ['location_user_email', 'Location user email', 'Location User Email']));
  const memberRole = normalizeImportRole(readField(row, ['member_role', 'Manager/Member designation', 'Manager/Member Designation']));

  return {
    row_number: index + 1,
    name,
    location_type: locationType,
    location_user_email: locationUserEmail,
    member_role: memberRole,
    errors: [],
    warnings: [],
    skip_reason: null,
  };
}

function validateClientEntityImportRows(rows, options = {}) {
  const existingNames = new Set((options.existingNames || []).map(cleanLower).filter(Boolean));
  const normalizedRows = [];

  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    if (isEmptyImportRow(row)) continue;
    normalizedRows.push(normalizeImportRow(row, index));
  }

  const nameCounts = new Map();
  for (const row of normalizedRows) {
    const key = cleanLower(row.name);
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }

  for (const row of normalizedRows) {
    const nameKey = cleanLower(row.name);
    if (!row.name) row.errors.push('Name is required.');
    if (nameKey && nameCounts.get(nameKey) > 1) row.errors.push('Duplicate entity name in this CSV.');
    if (nameKey && existingNames.has(nameKey)) row.skip_reason = 'duplicate_existing_entity';
    if (row.location_user_email && !EMAIL_RE.test(row.location_user_email)) {
      row.errors.push('Location user email must be a valid email address.');
    }
    if (row.member_role && !['manager', 'member'].includes(row.member_role)) {
      row.errors.push('Manager/Member designation must be blank, Manager, or Member.');
    }
    if (row.member_role && !row.location_user_email) {
      row.errors.push('Location user email is required when Manager/Member designation is supplied.');
    }
    if (row.location_user_email || row.member_role) {
      row.warnings.push('Member assignment is not created during entity import.');
    }
  }

  return normalizedRows;
}

module.exports = {
  cleanText,
  cleanLower,
  normalizeImportRole,
  validateClientEntityImportRows,
};
