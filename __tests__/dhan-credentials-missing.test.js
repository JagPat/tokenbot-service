describe('DhanTokenManager missing credentials handling', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('maps legacy table missing (42P01) to controlled DHAN_CREDENTIALS_MISSING error result', async () => {
    const legacyTableMissing = new Error('relation "dhan_user_credentials" does not exist');
    legacyTableMissing.code = '42P01';

    const dbQuery = jest
      .fn()
      // BrokerConnection.credentialsEncrypted lookup
      .mockResolvedValueOnce({ rows: [{ credentialsEncrypted: null }] })
      // Legacy table existence check (simulate race/mismatch where table appears present)
      .mockResolvedValueOnce({ rows: [{ legacy_table: 'dhan_user_credentials' }] })
      // Legacy fallback table lookup
      .mockRejectedValueOnce(legacyTableMissing);

    const dbClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn()
    };

    jest.doMock('../config/database', () => ({
      query: dbQuery,
      getClient: jest.fn().mockResolvedValue(dbClient)
    }));

    jest.doMock('../services/providers/dhan', () => ({
      renewToken: jest.fn()
    }));

    jest.doMock('../services/dhanTokenFetcher', () => ({
      fetchAccessToken: jest.fn()
    }));

    jest.doMock('../services/encryptor', () => ({
      decrypt: jest.fn((value) => value),
      encrypt: jest.fn((value) => value)
    }));

    jest.doMock('../utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }));

    const DhanTokenManager = require('../services/token-managers/DhanTokenManager');
    const manager = new DhanTokenManager();

    const result = await manager.refresh({
      userId: 'user-1',
      connectionId: 'conn-1',
      accountId: '1105489384',
      currentToken: null
    });

    expect(result).toMatchObject({
      success: false,
      error: 'DHAN_CREDENTIALS_MISSING',
      error_code: 'DHAN_CREDENTIALS_MISSING',
      statusCode: 422,
      guidance: 'Reconnect and save credentials'
    });

    expect(dbQuery).toHaveBeenCalled();
    expect(dbClient.release).toHaveBeenCalled();
  });
});
