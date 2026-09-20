import { describeError } from '../utils/describeError';
export type ConnectionLifecycleStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'authentication-expired'
  | 'reconnecting'
  | 'error';

export type ConnectionFailureKind = 'authentication' | 'network' | 'unknown';

export interface ConnectionLifecycleState {
  status: ConnectionLifecycleStatus;
  profileId: string | null;
  reconnectAttempt: number;
  failureKind: ConnectionFailureKind | null;
  error: string | null;
  updatedAt: string;
}

export type ConnectionLifecycleEvent =
  | { type: 'connect-requested'; profileId: string; at?: string }
  | { type: 'connected'; profileId: string; at?: string }
  | {
      type: 'connection-failed';
      profileId: string;
      kind: ConnectionFailureKind;
      error: string;
      at?: string;
    }
  | {
      type: 'connection-lost';
      profileId: string;
      kind: ConnectionFailureKind;
      error: string;
      at?: string;
    }
  | { type: 'network-restored'; at?: string }
  | { type: 'manual-reconnect-requested'; profileId: string; at?: string }
  | { type: 'disconnected'; at?: string };

export function createConnectionLifecycleState(
  now: string = new Date().toISOString()
): ConnectionLifecycleState {
  return {
    status: 'disconnected',
    profileId: null,
    reconnectAttempt: 0,
    failureKind: null,
    error: null,
    updatedAt: now
  };
}

export function transitionConnectionLifecycle(
  state: ConnectionLifecycleState,
  event: ConnectionLifecycleEvent
): ConnectionLifecycleState {
  const updatedAt = event.at ?? new Date().toISOString();

  switch (event.type) {
    case 'connect-requested':
      return {
        status: 'connecting',
        profileId: event.profileId,
        reconnectAttempt: 0,
        failureKind: null,
        error: null,
        updatedAt
      };
    case 'connected':
      return {
        status: 'connected',
        profileId: event.profileId,
        reconnectAttempt: 0,
        failureKind: null,
        error: null,
        updatedAt
      };
    case 'connection-failed':
    case 'connection-lost':
      return {
        status: failureStatus(event.kind),
        profileId: event.profileId,
        reconnectAttempt: state.reconnectAttempt,
        failureKind: event.kind,
        error: event.error,
        updatedAt
      };
    case 'network-restored':
      if (state.status !== 'offline' || !state.profileId) {
        return state;
      }

      return {
        ...state,
        status: 'reconnecting',
        reconnectAttempt: state.reconnectAttempt + 1,
        failureKind: null,
        error: null,
        updatedAt
      };
    case 'manual-reconnect-requested':
      return {
        status: 'reconnecting',
        profileId: event.profileId,
        reconnectAttempt: state.profileId === event.profileId
          ? state.reconnectAttempt + 1
          : 1,
        failureKind: null,
        error: null,
        updatedAt
      };
    case 'disconnected':
      return createConnectionLifecycleState(updatedAt);
  }
}

export function classifyConnectionFailure(error: unknown): ConnectionFailureKind {
  const message = describeError(error);

  if (/(auth|authentication|password|credential|permission denied|access denied|28P01)/i.test(message)) {
    return 'authentication';
  }

  if (/(network|offline|timeout|timed out|connection refused|connection reset|unreachable|dns)/i.test(message)) {
    return 'network';
  }

  return 'unknown';
}

function failureStatus(kind: ConnectionFailureKind): ConnectionLifecycleStatus {
  if (kind === 'authentication') {
    return 'authentication-expired';
  }

  if (kind === 'network') {
    return 'offline';
  }

  return 'error';
}
