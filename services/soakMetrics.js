const logger = require('../utils/logger');

class SoakMetrics {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.lastSnapshotAt = 0;
    this.snapshotIntervalMs = Math.max(
      60 * 1000,
      parseInt(process.env.SOAK_METRICS_LOG_INTERVAL_MS || '300000', 10)
    );

    this.counters = {
      invalid_auth_tag_count: 0,
      circuit_breaker_open_count: 0,
      token_refresh_success: 0,
      token_refresh_fail: 0
    };

    this.lastSyncDriftByConnection = new Map();
  }

  isInvalidAuthTagReason(reasonCode) {
    const code = String(reasonCode || '').toUpperCase();
    if (!code) return false;
    return code.includes('TAG') || code.includes('AUTH_FAILED') || code.includes('AUTHENTICATE_DATA');
  }

  _increment(metric, by = 1) {
    if (!Object.prototype.hasOwnProperty.call(this.counters, metric)) {
      this.counters[metric] = 0;
    }
    this.counters[metric] += Number(by) || 0;
  }

  recordInvalidAuthTag(context = {}) {
    this._increment('invalid_auth_tag_count');
    logger.warn('[SoakMetrics] Invalid auth tag/decrypt failure', {
      event: 'soak_invalid_auth_tag',
      invalid_auth_tag_count: this.counters.invalid_auth_tag_count,
      ...context
    });
    this.maybeSnapshot('invalid_auth_tag_event');
  }

  recordCircuitBreakerOpen(context = {}) {
    this._increment('circuit_breaker_open_count');
    logger.warn('[SoakMetrics] Circuit breaker OPEN', {
      event: 'soak_circuit_breaker_open',
      circuit_breaker_open_count: this.counters.circuit_breaker_open_count,
      ...context
    });
    this.maybeSnapshot('circuit_breaker_open_event');
  }

  recordTokenRefreshResult({ success = false, ...context } = {}) {
    if (success) {
      this._increment('token_refresh_success');
    } else {
      this._increment('token_refresh_fail');
    }

    logger.info('[SoakMetrics] Token refresh result', {
      event: 'soak_token_refresh_result',
      success,
      token_refresh_success: this.counters.token_refresh_success,
      token_refresh_fail: this.counters.token_refresh_fail,
      ...context
    });

    this.maybeSnapshot('token_refresh_result');
  }

  recordBrokerSyncDrift({ connectionId, brokerType = null, lastSyncAt = null } = {}) {
    if (!connectionId) return;

    const nowMs = Date.now();
    const lastSyncMs = lastSyncAt ? new Date(lastSyncAt).getTime() : NaN;
    const driftSeconds = Number.isFinite(lastSyncMs)
      ? Math.max(0, Math.round((nowMs - lastSyncMs) / 1000))
      : null;

    this.lastSyncDriftByConnection.set(String(connectionId), {
      connectionId: String(connectionId),
      brokerType: brokerType ? String(brokerType) : null,
      lastSyncAt: Number.isFinite(lastSyncMs) ? new Date(lastSyncMs).toISOString() : null,
      driftSeconds,
      observedAt: new Date(nowMs).toISOString()
    });
  }

  snapshot(reason = 'manual', extra = {}) {
    this.lastSnapshotAt = Date.now();

    const driftEntries = Array.from(this.lastSyncDriftByConnection.values())
      .sort((a, b) => {
        const aDrift = Number.isFinite(a.driftSeconds) ? a.driftSeconds : -1;
        const bDrift = Number.isFinite(b.driftSeconds) ? b.driftSeconds : -1;
        return bDrift - aDrift;
      })
      .slice(0, 200);

    const payload = {
      event: 'soak_counters_snapshot',
      reason,
      service: 'tokenbot-service',
      startedAt: this.startedAt,
      snapshotAt: new Date().toISOString(),
      ...this.counters,
      lastSyncDriftByConnection: driftEntries,
      ...extra
    };

    logger.info('[SoakMetrics] Snapshot', payload);
    return payload;
  }

  maybeSnapshot(reason = 'periodic', extra = {}) {
    if ((Date.now() - this.lastSnapshotAt) >= this.snapshotIntervalMs) {
      return this.snapshot(reason, extra);
    }
    return null;
  }
}

module.exports = new SoakMetrics();
