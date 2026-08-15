import type { ContributionId } from '../../extensions/extension-contracts.ts'

export class CommandPlanError extends Error {
  public override readonly name: string = 'CommandPlanError'

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export class CommandInvocationError extends Error {
  public override readonly name: string = 'CommandInvocationError'

  public constructor(
    public readonly commandId: ContributionId,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

export class CommandTimeoutError extends CommandInvocationError {
  public override readonly name: string = 'CommandTimeoutError'

  public constructor(commandId: ContributionId) {
    super(commandId, `Command "${commandId}" exceeded its deadline.`)
  }
}

export class CommandResultValidationError extends CommandInvocationError {
  public override readonly name: string = 'CommandResultValidationError'

  public constructor(commandId: ContributionId, options?: ErrorOptions) {
    super(
      commandId,
      `Command "${commandId}" returned an invalid result.`,
      options
    )
  }
}
