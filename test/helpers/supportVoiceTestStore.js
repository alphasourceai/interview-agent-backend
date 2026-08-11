function createBacking() {
  return { sessions: new Map() };
}

function createMemorySupportVoiceStore(options = {}) {
  const backing = options.backing || createBacking();
  const pendingTtlMs = options.pendingTtlMs || 60_000;
  const activeTtlMs = options.activeTtlMs || 600_000;
  const consumeDelayMs = options.consumeDelayMs || 0;
  const reserveFailureAfterCommit = options.reserveFailureAfterCommit === true;
  const consumeFailureAfterCommit = options.consumeFailureAfterCommit === true;
  let healthy = options.initialHealthy !== false;
  let closeFailures = options.closeFailures || 0;
  const calls = [];

  function expire() {
    const now = Date.now();
    for (const row of backing.sessions.values()) {
      if (['pending', 'active'].includes(row.phase) && row.expiresAt <= now) {
        row.phase = 'closed';
        row.credentialDigest = null;
        row.reason = 'expired';
      }
    }
  }

  return {
    backing,
    calls,
    isHealthy: () => healthy,
    async probe() { return healthy; },
    start() {},
    stop() {},
    async reserve({ sessionId, credentialDigest, userFingerprint }) {
      calls.push({ operation: 'reserve', sessionId, userFingerprint });
      if (!healthy) throw new Error('unavailable');
      expire();
      const live = [...backing.sessions.values()].filter((row) => ['pending', 'active'].includes(row.phase));
      if (live.some((row) => row.userFingerprint === userFingerprint)) return { status: 'conflict' };
      if (live.length >= 20) return { status: 'capacity' };
      const expiresAt = Date.now() + pendingTtlMs;
      backing.sessions.set(sessionId, {
        sessionId, credentialDigest, userFingerprint, phase: 'pending', expiresAt,
      });
      if (reserveFailureAfterCommit) throw new Error('ambiguous_reserve');
      return { status: 'created', session_id: sessionId, expires_at: new Date(expiresAt).toISOString() };
    },
    async consume({ credentialDigest }) {
      calls.push({ operation: 'consume' });
      if (!healthy) throw new Error('unavailable');
      if (consumeDelayMs) await new Promise((resolve) => setTimeout(resolve, consumeDelayMs));
      expire();
      const row = [...backing.sessions.values()].find((item) => item.phase === 'pending' && item.credentialDigest === credentialDigest);
      if (!row) return { status: 'invalid' };
      row.phase = 'active';
      row.credentialDigest = null;
      row.expiresAt = Date.now() + activeTtlMs;
      if (consumeFailureAfterCommit) throw new Error('ambiguous_consume');
      return {
        status: 'consumed', session_id: row.sessionId, user_fingerprint: row.userFingerprint,
        expires_at: new Date(row.expiresAt).toISOString(),
      };
    },
    async close({ sessionId, reason }) {
      calls.push({ operation: 'close', sessionId, reason });
      if (closeFailures > 0) {
        closeFailures -= 1;
        throw new Error('transient');
      }
      const row = backing.sessions.get(sessionId);
      if (!row) return { status: 'missing' };
      row.phase = 'closed';
      row.credentialDigest = null;
      row.reason = reason;
      return { status: 'closed', session_id: sessionId, expires_at: new Date(row.expiresAt).toISOString() };
    },
    async closePending({ userFingerprint, reason }) {
      calls.push({ operation: 'closePending', userFingerprint, reason });
      let count = 0;
      for (const row of backing.sessions.values()) {
        if (row.phase === 'pending' && row.userFingerprint === userFingerprint) {
          row.phase = 'closed';
          row.credentialDigest = null;
          row.reason = reason;
          count += 1;
        }
      }
      return count;
    },
    _state: {
      setHealthyForTest(value) { healthy = value === true; },
      setCloseFailuresForTest(value) { closeFailures = value; },
    },
  };
}

module.exports = { createBacking, createMemorySupportVoiceStore };
