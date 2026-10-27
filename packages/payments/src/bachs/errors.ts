export class BachsApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly providerCode?: string,
  ) {
    super(
      providerCode
        ? `Bachs API request failed with HTTP ${statusCode} (${providerCode})`
        : `Bachs API request failed with HTTP ${statusCode}`,
    );
    this.name = 'BachsApiError';
  }
}

export class BachsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BachsProtocolError';
  }
}

export class BachsTransportError extends Error {
  constructor() {
    super('Bachs API response was not received');
    this.name = 'BachsTransportError';
  }
}

/** Why an outcome is unknown, for logs and issues: allowlisted values only, never message text. */
export interface UncertainOutcomeDiagnostic {
  cause:
    | 'no_response'
    | 'unreadable_response'
    | 'http_error'
    | 'unexpected_shape'
    | 'unexpected_state'
    | 'unsafe_url';
  httpStatus?: number;
  providerCode?: string;
}

export class UncertainProviderOutcomeError extends Error {
  constructor(
    readonly operationReference: string,
    reason: string,
    readonly diagnostic?: UncertainOutcomeDiagnostic,
  ) {
    super(
      `Bachs outcome is unknown for operation ${operationReference}: ${reason}`,
    );
    this.name = 'UncertainProviderOutcomeError';
  }
}
