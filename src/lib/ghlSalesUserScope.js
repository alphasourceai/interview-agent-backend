'use strict';

// GHL Account users are limited to their assigned sub-account; Agency users are not.
function isScopedGhlSalesUser(user, locationId) {
  const roles = user?.roles;
  return roles?.type === 'account'
    && roles?.role === 'user'
    && Array.isArray(roles.locationIds)
    && roles.locationIds.length === 1
    && roles.locationIds[0] === locationId;
}

module.exports = { isScopedGhlSalesUser };
