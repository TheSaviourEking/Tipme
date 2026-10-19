import {
  BadRequestException,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import type { z } from 'zod';

/** Carries field paths only; values are never echoed back. */
export class ValidationFailedException extends BadRequestException {
  constructor(readonly fields: string[]) {
    super('VALIDATION_FAILED');
  }
}

export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<
  unknown,
  z.infer<S>
> {
  constructor(private readonly schema: S) {}

  transform(value: unknown, metadata?: ArgumentMetadata): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const fields = [
      ...new Set(
        result.error.issues.map(
          (issue) => issue.path.join('.') || metadata?.data || '(body)',
        ),
      ),
    ];
    throw new ValidationFailedException(fields);
  }
}
