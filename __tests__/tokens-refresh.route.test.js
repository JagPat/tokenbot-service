function makeMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function getRefreshHandler(router) {
  const layer = router.stack.find(
    (entry) => entry.route && entry.route.path === '/refresh' && entry.route.methods.post
  );
  if (!layer) {
    throw new Error('Refresh route handler not found');
  }
  return layer.route.stack[0].handle;
}

describe('POST /api/tokens/refresh error mapping', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      TOKENBOT_API_KEY: 'test-tokenbot-api-key'
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns 422 with controlled guidance for DHAN_CREDENTIALS_MISSING', async () => {
    const controlledError = new Error('DHAN_CREDENTIALS_MISSING');
    controlledError.code = 'DHAN_CREDENTIALS_MISSING';
    controlledError.statusCode = 422;
    controlledError.guidance = 'Reconnect and save credentials';

    const refreshTokenForUser = jest.fn().mockRejectedValue(controlledError);

    jest.doMock('../services/tokenManager', () => ({
      refreshTokenForUser
    }));

    jest.doMock('../utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }));

    jest.doMock('../middleware/auth', () => ({
      authenticateUser: jest.fn((req, res, next) => next()),
      authenticateService: jest.fn((req, res, next) => next())
    }));

    jest.doMock('../utils/userIdPolicy', () => ({
      assertProductionSafeUserId: jest.fn((value) => value),
      normalizeUserId: jest.fn((value) => value)
    }));

    const router = require('../routes/tokens');
    const handler = getRefreshHandler(router);

    const req = {
      headers: { 'x-api-key': 'test-tokenbot-api-key' },
      body: {
        brokerType: 'DHAN',
        brokerConnectionId: 'conn-1',
        user_id: 'user-1'
      },
      query: {}
    };
    const res = makeMockResponse();

    await handler(req, res, jest.fn());

    expect(refreshTokenForUser).toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({
      success: false,
      error: 'DHAN_CREDENTIALS_MISSING',
      guidance: 'Reconnect and save credentials'
    });
    expect(res.body.correlationId).toBeTruthy();
  });
});
