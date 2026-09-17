import { describe, expect, it } from 'vitest';
import {
  classifyConnectionFailure,
  createConnectionLifecycleState,
  transitionConnectionLifecycle
} from './connectionLifecycle';

const now = '2026-09-17T00:00:00.000Z';

describe('connection lifecycle', () => {
  it('moves through connect and connected states', () => {
    const connecting = transitionConnectionLifecycle(
      createConnectionLifecycleState(now),
      { type: 'connect-requested', profileId: 'profile-a', at: now }
    );
    const connected = transitionConnectionLifecycle(
      connecting,
      { type: 'connected', profileId: 'profile-a', at: now }
    );

    expect(connecting.status).toBe('connecting');
    expect(connected).toMatchObject({
      status: 'connected',
      profileId: 'profile-a',
      reconnectAttempt: 0,
      error: null
    });
  });

  it('distinguishes authentication expiry from a network outage', () => {
    const connected = transitionConnectionLifecycle(
      createConnectionLifecycleState(now),
      { type: 'connected', profileId: 'profile-a', at: now }
    );
    const authenticationExpired = transitionConnectionLifecycle(connected, {
      type: 'connection-lost',
      profileId: 'profile-a',
      kind: 'authentication',
      error: 'password expired',
      at: now
    });
    const offline = transitionConnectionLifecycle(connected, {
      type: 'connection-lost',
      profileId: 'profile-a',
      kind: 'network',
      error: 'network unavailable',
      at: now
    });

    expect(authenticationExpired.status).toBe('authentication-expired');
    expect(offline.status).toBe('offline');
  });

  it('starts a counted recovery only after an offline network is restored', () => {
    const offline = transitionConnectionLifecycle(
      createConnectionLifecycleState(now),
      {
        type: 'connection-lost',
        profileId: 'profile-a',
        kind: 'network',
        error: 'offline',
        at: now
      }
    );
    const reconnecting = transitionConnectionLifecycle(offline, {
      type: 'network-restored',
      at: now
    });

    expect(reconnecting).toMatchObject({
      status: 'reconnecting',
      profileId: 'profile-a',
      reconnectAttempt: 1,
      error: null
    });
    expect(
      transitionConnectionLifecycle(createConnectionLifecycleState(now), {
        type: 'network-restored',
        at: now
      })
    ).toEqual(createConnectionLifecycleState(now));
  });

  it('allows a manual reconnect after authentication expiry', () => {
    const authenticationExpired = transitionConnectionLifecycle(
      createConnectionLifecycleState(now),
      {
        type: 'connection-failed',
        profileId: 'profile-a',
        kind: 'authentication',
        error: 'authentication failed',
        at: now
      }
    );
    const reconnecting = transitionConnectionLifecycle(authenticationExpired, {
      type: 'manual-reconnect-requested',
      profileId: 'profile-a',
      at: now
    });

    expect(reconnecting.status).toBe('reconnecting');
    expect(reconnecting.reconnectAttempt).toBe(1);
  });

  it('classifies common driver failures', () => {
    expect(classifyConnectionFailure(new Error('password authentication failed'))).toBe('authentication');
    expect(classifyConnectionFailure(new Error('connection timed out'))).toBe('network');
    expect(classifyConnectionFailure(new Error('unsupported database'))).toBe('unknown');
  });
});
