describe('DistributedLockService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.REDIS_URL;
    delete process.env.REDISCLOUD_URL;
    delete process.env.TOKENBOT_REDIS_LOCK_REQUIRED;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('uses in-memory locking in non-production when redis is unavailable', async () => {
    process.env.NODE_ENV = 'test';
    const distributedLock = require('../services/distributedLock');

    const lock = await distributedLock.acquire('refresh:conn-1', 2000);
    expect(lock.mode).toBe('memory');

    await expect(distributedLock.acquire('refresh:conn-1', 2000))
      .rejects
      .toMatchObject({ statusCode: 503, code: 'TOKEN_REFRESH_LOCKED' });

    await distributedLock.release(lock);
  });

  test('fails lock acquisition in production when redis is unavailable', async () => {
    process.env.NODE_ENV = 'production';
    const distributedLock = require('../services/distributedLock');

    await expect(distributedLock.acquire('refresh:conn-2', 2000))
      .rejects
      .toMatchObject({ statusCode: 503, code: 'TOKEN_REFRESH_LOCK_UNAVAILABLE' });
  });
});
