import {
  createHookPolicyRef,
  type ResolvedHookPolicy,
} from './extension-contracts.ts'

export const activationHookPolicyRef = createHookPolicyRef('activation')
export const notificationHookPolicyRef = createHookPolicyRef('notification')
export const transformHookPolicyRef = createHookPolicyRef('transform')
export const guardHookPolicyRef = createHookPolicyRef('guard')
export const shutdownHookPolicyRef = createHookPolicyRef('shutdown')

export const canonicalHookPolicies: readonly ResolvedHookPolicy[] =
  Object.freeze([
    Object.freeze({
      ref: activationHookPolicyRef,
      dispatch: 'serial',
      handlerTimeoutMs: 5000,
      errorPolicy: 'fail-fast',
      rollback: 'resource-scope',
      trackLateSettlement: true,
    }),
    Object.freeze({
      ref: notificationHookPolicyRef,
      dispatch: 'parallel',
      handlerTimeoutMs: 2000,
      errorPolicy: 'isolate',
      rollback: 'none',
      trackLateSettlement: true,
    }),
    Object.freeze({
      ref: transformHookPolicyRef,
      dispatch: 'serial',
      handlerTimeoutMs: 2000,
      errorPolicy: 'fail-fast',
      rollback: 'operation-scope',
      trackLateSettlement: true,
    }),
    Object.freeze({
      ref: guardHookPolicyRef,
      dispatch: 'serial',
      handlerTimeoutMs: 2000,
      errorPolicy: 'deny',
      rollback: 'operation-scope',
      trackLateSettlement: true,
    }),
    Object.freeze({
      ref: shutdownHookPolicyRef,
      dispatch: 'serial',
      handlerTimeoutMs: 1000,
      errorPolicy: 'aggregate',
      rollback: 'none',
      trackLateSettlement: true,
    }),
  ])
