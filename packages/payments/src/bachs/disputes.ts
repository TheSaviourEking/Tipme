import { z } from 'zod';
import {
  DisputeEvidenceRefusedError,
  type PaymentProvider,
} from '../provider.js';
import type { BachsApiClient } from './client.js';
import {
  BachsApiError,
  BachsProtocolError,
  BachsRequestNotSentError,
  UncertainProviderOutcomeError,
} from './errors.js';
import { disputeAmount, disputeStatusOf } from './webhooks.js';

/*
 * You collect (plan Task 5): the partner's dispute API for TipMe's own disputes, always as the
 * platform (no X-Account-Id). Paths, bodies and answers from https://docs.bachs.io/connect/disputes
 * and its reference pages (api-reference/disputes/*): List Disputes, Upload Dispute Document, Update
 * Dispute Evidence, Submit Dispute. Built from the docs only; the sandbox may not raise disputes.
 */

/** Upload Dispute Document: PDF, JPEG, PNG or GIF up to 10 MB (TipMe sends no GIF). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXTENSION = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
} as const;
/** Partner ids TipMe puts in a path or body: plain characters only. */
const PARTNER_ID = /^[A-Za-z0-9_-]{1,100}$/;
const KEY = /^[\w.:-]{1,200}$/;
/** Staff's note; the partner documents no limit, so TipMe keeps it well inside a request. */
const MAX_TEXT = 20_000;
const PAGE = 100;

const evidenceSavedSchema = z.object({
  dispute_id: z.string().min(1),
  status: z.string().min(1),
  is_response_editable: z.boolean(),
});
const submittedSchema = z.object({
  dispute_id: z.string().min(1),
  status: z.string().min(1),
  is_response_editable: z.boolean(),
  submission: z.object({
    submission_id: z.string().min(1),
    submission_status: z.string().min(1),
  }),
});
const uploadSchema = z.object({ document_id: z.string().regex(PARTNER_ID) });
const listSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      dispute_id: z.string(),
      charge_id: z.string().nullable().optional(),
      amount: z.string(),
      currency: z.string(),
      status: z.string(),
    }),
  ),
});

function notSent(message: string): never {
  throw new BachsRequestNotSentError(message);
}

// Get Dispute: what the read-back after a refused write needs.
const disputeReadSchema = z.object({
  dispute_id: z.string().min(1),
  status: z.string().min(1),
  is_response_editable: z.boolean(),
});

/** A 5xx on an evidence write is unknown; the client already raised the rest. */
function uncertainOf(error: unknown, reference: string): unknown {
  if (error instanceof BachsApiError)
    return new UncertainProviderOutcomeError(
      reference,
      `the payment provider returned HTTP ${error.statusCode}`,
      { cause: 'http_error', httpStatus: error.statusCode },
    );
  return error;
}

const isRefusal = (error: unknown): error is BachsApiError =>
  error instanceof BachsApiError &&
  error.statusCode >= 400 &&
  error.statusCode < 500;

export function createBachsDisputes(
  client: BachsApiClient,
): Required<
  Pick<
    PaymentProvider,
    'submitDisputeEvidence' | 'uploadDisputeFile' | 'listDisputes'
  >
> {
  return {
    // Update Dispute Evidence (PATCH), then Submit Dispute (POST, no body, irreversible). Each has
    // its own partner key derived from TipMe's, so a retry with the same key repeats both exactly
    // and the partner submits once (the API overview: Idempotency-Key on public POST and PATCH).
    async submitDisputeEvidence(input) {
      const { partnerDisputeId, text, fileRefs, idempotencyKey } = input;
      if (!PARTNER_ID.test(partnerDisputeId)) notSent('Invalid dispute');
      if (!KEY.test(idempotencyKey)) notSent('Invalid idempotency key');
      if (text.trim().length === 0 || text.length > MAX_TEXT)
        notSent('Evidence text must be given and short enough');
      // The evidence has one general attachment slot (`uncategorized_attachment_id`); the others
      // are for named documents (refund policy, communication) TipMe does not label yet.
      if (fileRefs.length > 1) notSent('One evidence file at most');
      if (fileRefs.some((ref) => !PARTNER_ID.test(ref)))
        notSent('Invalid evidence file');
      const path = `/v1/disputes/${encodeURIComponent(partnerDisputeId)}`;
      const uncertain = (reason: string) =>
        new UncertainProviderOutcomeError(partnerDisputeId, reason, {
          cause: 'unexpected_state',
        });
      // A 4xx can be the answer to a retry whose first submit went through (the dispute is then
      // locked), so it is never taken as "not submitted" on its own: the dispute is read back.
      // Submitted (under review, or no longer editable) is success; still editable is the refusal;
      // anything unclear stays unknown (review fix 2).
      const readBack = async (refusal: BachsApiError) => {
        let dispute: z.infer<typeof disputeReadSchema>;
        try {
          dispute = await client.request({
            method: 'GET',
            path,
            schema: disputeReadSchema,
          });
        } catch {
          throw uncertain('the dispute could not be read back after a refusal');
        }
        if (dispute.dispute_id !== partnerDisputeId)
          throw uncertain(
            'the payment provider answered about another dispute',
          );
        if (dispute.status === 'under_review' || !dispute.is_response_editable)
          return { state: 'submitted' as const };
        if (dispute.status === 'needs_response')
          throw new DisputeEvidenceRefusedError(refusal.providerCode);
        throw uncertain('the dispute is in a state TipMe does not know');
      };
      try {
        await client.request({
          method: 'PATCH',
          path: `${path}/evidence`,
          idempotencyKey: `${idempotencyKey}-evidence`,
          operationReference: partnerDisputeId,
          body: {
            notes: text,
            ...(fileRefs[0]
              ? { uncategorized_attachment_id: fileRefs[0] }
              : {}),
          },
          schema: evidenceSavedSchema,
        });
      } catch (error) {
        if (isRefusal(error)) return readBack(error);
        throw uncertainOf(error, partnerDisputeId);
      }
      let submitted: z.infer<typeof submittedSchema>;
      try {
        submitted = await client.request({
          method: 'POST',
          path: `${path}/submit`,
          idempotencyKey: `${idempotencyKey}-submit`,
          operationReference: partnerDisputeId,
          body: {},
          schema: submittedSchema,
        });
      } catch (error) {
        if (isRefusal(error)) return readBack(error);
        throw uncertainOf(error, partnerDisputeId);
      }
      // An answer about another dispute proves nothing about this one.
      if (submitted.dispute_id !== partnerDisputeId)
        throw uncertain('the payment provider answered about another dispute');
      return { state: 'submitted' };
    },

    // Upload Dispute Document: multipart, one `file`; the answer's `document_id` is the evidence's
    // attachment id. Not a money move, so a lost answer is only a file to upload again.
    async uploadDisputeFile({ partnerDisputeId, bytes, contentType }) {
      if (!PARTNER_ID.test(partnerDisputeId)) notSent('Invalid dispute');
      if (!Object.hasOwn(EXTENSION, contentType))
        notSent('Unsupported evidence file type');
      if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES)
        notSent('Evidence file must be 1 byte to 10 MB');
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(bytes)], { type: contentType }),
        `${partnerDisputeId}.${EXTENSION[contentType]}`,
      );
      const uploaded = await client.request({
        method: 'POST',
        path: '/v1/disputes/uploads',
        operationReference: partnerDisputeId,
        form,
        schema: uploadSchema,
      });
      return { fileRef: uploaded.document_id };
    },

    // List Disputes, newest first, 100 a page (the maximum), until `total` is reached. Offsets
    // shift when a dispute is created between pages, so each id is kept once and a changed total
    // makes the read uncertain: never a list with a repeat or a gap (review fix 3).
    async listDisputes(since) {
      if (Number.isNaN(since.getTime())) notSent('Invalid time');
      type Row = Awaited<
        ReturnType<NonNullable<PaymentProvider['listDisputes']>>
      >[number];
      const rows = new Map<string, Row>();
      let total: number | undefined;
      for (let offset = 0; ; offset += PAGE) {
        const query = new URLSearchParams({
          from_date: since.toISOString(),
          limit: String(PAGE),
          offset: String(offset),
        });
        const page = await client.request({
          method: 'GET',
          path: `/v1/disputes?${query}`,
          schema: listSchema,
        });
        if (total !== undefined && page.total !== total)
          throw new UncertainProviderOutcomeError(
            'disputes',
            'the dispute list changed while it was read',
            { cause: 'unexpected_state' },
          );
        total = page.total;
        for (const item of page.items) {
          const status = disputeStatusOf(item.status);
          const money = disputeAmount(item.amount, item.currency);
          if (!PARTNER_ID.test(item.dispute_id) || !status || !money)
            throw new BachsProtocolError(
              'The payment provider listed a dispute TipMe cannot read',
            );
          if (rows.has(item.dispute_id)) continue;
          rows.set(item.dispute_id, {
            partnerDisputeId: item.dispute_id,
            status,
            amountMinor: money.amountMinor,
            currency: money.currency,
            chargeReference:
              item.charge_id && PARTNER_ID.test(item.charge_id)
                ? item.charge_id
                : null,
          });
        }
        if (rows.size >= total) return [...rows.values()];
        // A short page before the total: the list moved under us, or was cut. Never partial.
        if (page.items.length < PAGE)
          throw new BachsProtocolError(
            'The payment provider listed fewer disputes than it counted',
          );
      }
    },
  };
}
