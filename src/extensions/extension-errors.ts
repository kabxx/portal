import type {
  ContributionId,
  ExecutableBindingId,
  ExtensionId,
  HandlerId,
  HookId,
  ServiceId,
} from './extension-contracts.ts'

export class ExtensionKernelError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExtensionKernelError'
  }
}

export class ExtensionRegistrationError extends ExtensionKernelError {
  public constructor(
    public readonly extensionId: ExtensionId,
    message: string,
    cause?: unknown
  ) {
    super(`Extension "${extensionId}" registration failed: ${message}`, {
      ...(cause === undefined ? {} : { cause }),
    })
    this.name = 'ExtensionRegistrationError'
  }
}

export class AsyncExtensionRegistrationError extends ExtensionRegistrationError {
  public constructor(extensionId: ExtensionId) {
    super(extensionId, 'register() must be synchronous and return no thenable.')
    this.name = 'AsyncExtensionRegistrationError'
  }
}

export class RegistryFrozenError extends ExtensionKernelError {
  public constructor() {
    super('The extension registry is frozen.')
    this.name = 'RegistryFrozenError'
  }
}

export class ExtensionResolutionError extends ExtensionKernelError {
  public constructor(message: string, cause?: unknown) {
    super(message, { ...(cause === undefined ? {} : { cause }) })
    this.name = 'ExtensionResolutionError'
  }
}

export class DuplicateExtensionIdError extends ExtensionResolutionError {
  public constructor(public readonly extensionId: ExtensionId) {
    super(`Extension ID "${extensionId}" is already registered.`)
    this.name = 'DuplicateExtensionIdError'
  }
}

export class UnknownRefError extends ExtensionResolutionError {
  public constructor(kind: string, id: string) {
    super(`Unknown ${kind} reference "${id}".`)
    this.name = 'UnknownRefError'
  }
}

export class DuplicateContributionIdError extends ExtensionResolutionError {
  public constructor(public readonly contributionId: ContributionId) {
    super(`Contribution ID "${contributionId}" is registered more than once.`)
    this.name = 'DuplicateContributionIdError'
  }
}

export class DuplicateExecutableBindingIdError extends ExtensionResolutionError {
  public constructor(public readonly bindingId: ExecutableBindingId) {
    super(`Executable binding ID "${bindingId}" is registered more than once.`)
    this.name = 'DuplicateExecutableBindingIdError'
  }
}

export class ExecutableBindingValidationError extends ExtensionResolutionError {
  public constructor(
    public readonly bindingId: ExecutableBindingId,
    message: string,
    cause?: unknown
  ) {
    super(`Executable binding "${bindingId}" is invalid: ${message}`, cause)
    this.name = 'ExecutableBindingValidationError'
  }
}

export class DuplicateHandlerIdError extends ExtensionResolutionError {
  public constructor(public readonly handlerId: HandlerId) {
    super(`Handler ID "${handlerId}" is registered more than once.`)
    this.name = 'DuplicateHandlerIdError'
  }
}

export class DuplicateServiceProviderError extends ExtensionResolutionError {
  public constructor(public readonly serviceId: ServiceId) {
    super(`Service "${serviceId}" has more than one provider.`)
    this.name = 'DuplicateServiceProviderError'
  }
}

export class GraphResolutionError extends ExtensionResolutionError {
  public constructor(
    public readonly graph: string,
    message: string
  ) {
    super(`${graph} graph: ${message}`)
    this.name = 'GraphResolutionError'
  }
}

export class RequirementNotAllowedError extends ExtensionResolutionError {
  public constructor(
    public readonly extensionId: ExtensionId,
    requirement: string,
    target: string
  ) {
    super(
      `Extension "${extensionId}" requires ${requirement}, which is not allowed by ${target}.`
    )
    this.name = 'RequirementNotAllowedError'
  }
}

export class CapabilityNotGrantedError extends ExtensionResolutionError {
  public constructor(
    public readonly extensionId: ExtensionId,
    capability: string
  ) {
    super(
      `Extension "${extensionId}" was not granted capability "${capability}".`
    )
    this.name = 'CapabilityNotGrantedError'
  }
}

export class ContributionValidationError extends ExtensionResolutionError {
  public constructor(
    public readonly contributionId: ContributionId,
    message: string,
    cause?: unknown
  ) {
    super(`Contribution "${contributionId}" is invalid: ${message}`, cause)
    this.name = 'ContributionValidationError'
  }
}

export class HookPolicyMismatchError extends ExtensionResolutionError {
  public constructor(
    public readonly hookId: HookId,
    policyId: string
  ) {
    super(`Hook "${hookId}" references unknown policy "${policyId}".`)
    this.name = 'HookPolicyMismatchError'
  }
}

export class HookScopeMismatchError extends ExtensionKernelError {
  public constructor(
    public readonly hookId: HookId,
    expected: string,
    actual: string
  ) {
    super(`Hook "${hookId}" requires ${expected} scope, received ${actual}.`)
    this.name = 'HookScopeMismatchError'
  }
}

export class ServiceAccessDeniedError extends ExtensionKernelError {
  public constructor(public readonly serviceId: ServiceId) {
    super(`Service "${serviceId}" was not declared for this operation.`)
    this.name = 'ServiceAccessDeniedError'
  }
}

export class ExtensionCapabilityExpiredError extends ExtensionKernelError {
  public constructor(capability: string) {
    super(`${capability} is no longer available after its owner settled.`)
    this.name = 'ExtensionCapabilityExpiredError'
  }
}

export class ServiceActivationError extends ExtensionKernelError {
  public constructor(
    public readonly serviceId: ServiceId,
    cause: unknown
  ) {
    super(`Service "${serviceId}" failed to activate.`, { cause })
    this.name = 'ServiceActivationError'
  }
}

export class HookHandlerContractError extends ExtensionKernelError {
  public constructor(
    public readonly hookId: HookId,
    public readonly handlerId: HandlerId,
    message: string,
    cause?: unknown
  ) {
    super(`Hook "${hookId}" handler "${handlerId}" ${message}`, {
      ...(cause === undefined ? {} : { cause }),
    })
    this.name = 'HookHandlerContractError'
  }
}

export class HookHandlerTimeoutError extends ExtensionKernelError {
  public constructor(
    public readonly hookId: HookId,
    public readonly handlerId: HandlerId,
    public readonly timeoutMs: number
  ) {
    super(
      `Hook "${hookId}" handler "${handlerId}" timed out after ${timeoutMs}ms.`
    )
    this.name = 'HookHandlerTimeoutError'
  }
}

export class HookInvocationError extends ExtensionKernelError {
  public constructor(
    public readonly hookId: HookId,
    cause: unknown
  ) {
    super(`Hook "${hookId}" invocation failed.`, { cause })
    this.name = 'HookInvocationError'
  }
}

export class HookShutdownAggregateError extends AggregateError {
  public constructor(
    public readonly hookId: HookId,
    errors: readonly unknown[]
  ) {
    super(errors, `Hook "${hookId}" shutdown handlers failed.`)
    this.name = 'HookShutdownAggregateError'
  }
}
