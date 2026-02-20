describe('TokenManager production guardrails', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, NODE_ENV: 'production' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function mockCommonDeps(dbQueryImpl = async () => ({ rows: [] })) {
    jest.doMock('../config/database', () => ({
      query: jest.fn(dbQueryImpl),
      getClient: jest.fn()
    }));

    jest.doMock('../services/tokenFetcher', () => ({
      fetchAccessToken: jest.fn()
    }));

    jest.doMock('../services/providers/dhan', () => ({
      renewToken: jest.fn()
    }));

    jest.doMock('../services/distributedLock', () => ({
      acquire: jest.fn().mockResolvedValue({ mode: 'memory', key: 'k' }),
      release: jest.fn().mockResolvedValue(true)
    }));

    jest.doMock('../services/encryptor', () => ({
      encrypt: jest.fn((value) => `enc:${value}`),
      decrypt: jest.fn((value) => (typeof value === 'string' && value.startsWith('enc:') ? value.slice(4) : value))
    }));

    jest.doMock('../utils/retry', () => ({
      retryWithBackoff: jest.fn()
    }));
  }

  test('rejects refresh when brokerConnection resolves to default user in production', async () => {
    mockCommonDeps(async (sql) => {
      const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();
      if (normalizedSql.includes('FROM "BrokerConnection"') && normalizedSql.includes('WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'conn-default',
              user_id: 'default',
              broker_type: 'ZERODHA',
              account_id: 'acct-1',
              is_active: true
            }
          ]
        };
      }
      return { rows: [] };
    });

    const tokenManager = require('../services/tokenManager');

    await expect(
      tokenManager.refreshTokenForUser({
        brokerConnectionId: 'conn-default',
        brokerType: 'ZERODHA'
      })
    ).rejects.toMatchObject({
      code: 'INVALID_DEFAULT_USER',
      statusCode: 400
    });
  });

  test('requires brokerConnectionId for token persistence in production', async () => {
    mockCommonDeps();

    const tokenManager = require('../services/tokenManager');

    await expect(
      tokenManager.storeTokenData({
        user_id: 'user-1',
        brokerType: 'DHAN',
        accountId: '1105489384',
        access_token: 'token',
        refresh_token: 'refresh',
        expires_at: new Date().toISOString()
      })
    ).rejects.toMatchObject({
      code: 'BROKER_CONNECTION_REQUIRED',
      statusCode: 400
    });
  });

  test('does not use legacy stored_tokens fallback in production lookup', async () => {
    mockCommonDeps();

    const tokenManager = require('../services/tokenManager');
    jest.spyOn(tokenManager, '_resolveConnectionContext').mockResolvedValue({
      userId: 'user-1',
      brokerType: 'ZERODHA',
      accountId: null,
      connectionId: 'conn-1'
    });
    jest.spyOn(tokenManager, '_getBrokerConnectionToken').mockResolvedValue(null);
    const legacySpy = jest.spyOn(tokenManager, '_getLegacyZerodhaToken').mockResolvedValue({ access_token: 'legacy' });

    const result = await tokenManager.getCurrentToken({
      userId: 'user-1',
      brokerType: 'ZERODHA',
      brokerConnectionId: 'conn-1'
    });

    expect(result).toBeNull();
    expect(legacySpy).not.toHaveBeenCalled();
  });
});
