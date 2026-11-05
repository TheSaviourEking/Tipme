import { SetMetadata } from '@nestjs/common';

export const OPENAPI_EVENT_STREAM = 'tipme:openapi-event-stream';

export interface EventStreamResponseDoc {
  /** What the stream sends, and its refusals. */
  description: string;
}

/** Marks a route that answers with text/event-stream, so the document says so instead of JSON. */
export const EventStreamResponse = (doc: EventStreamResponseDoc) =>
  SetMetadata(OPENAPI_EVENT_STREAM, doc);
