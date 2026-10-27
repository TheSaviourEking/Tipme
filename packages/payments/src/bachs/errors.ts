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

export class UncertainProviderOutcomeError extends Error {
  constructor(
    readonly operationReference: string,
    reason: string,
  ) {
    super(
      `Bachs outcome is unknown for operation ${operationReference}: ${reason}`,
    );
    this.name = 'UncertainProviderOutcomeError';
  }
}
