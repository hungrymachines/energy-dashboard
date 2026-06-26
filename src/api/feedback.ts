import { apiFetch } from './client.js';

/** Coarse triage buckets — keep in sync with the API's ALLOWED_CATEGORIES. */
export type FeedbackCategory = 'bug' | 'idea' | 'comment' | 'other';

export interface FeedbackBody {
  message: string;
  category?: FeedbackCategory;
}

export interface FeedbackResult {
  stored: boolean;
}

/** POST /api/v1/feedback — authenticated; the API stamps user_id + email. */
export function submit(body: FeedbackBody): Promise<FeedbackResult> {
  return apiFetch<FeedbackResult>('/api/v1/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
