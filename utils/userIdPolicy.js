function normalizeUserId(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function isDefaultUserId(userId) {
  return String(userId || '').trim().toLowerCase() === 'default';
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function assertProductionSafeUserId(userId, context = 'user') {
  const normalized = normalizeUserId(userId);
  if (!normalized) {
    const error = new Error(`Missing ${context} userId`);
    error.code = 'MISSING_USER_ID';
    error.statusCode = 400;
    throw error;
  }

  if (isProduction() && isDefaultUserId(normalized)) {
    const error = new Error(`Invalid ${context} userId "default" in production`);
    error.code = 'INVALID_DEFAULT_USER';
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

module.exports = {
  normalizeUserId,
  isDefaultUserId,
  assertProductionSafeUserId
};
