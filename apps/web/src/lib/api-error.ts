export interface ApiFieldError {
  field: string;
  message: string;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: ApiFieldError[] };
}

/** The API's error envelope as a thrown value, the same on the server and in the browser. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiFieldError[];

  constructor(status: number, code: string, message: string, details: ApiFieldError[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function toApiError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // A proxy or a crashed process answered with something that is not JSON.
  }
  return new ApiError(
    response.status,
    envelope.error?.code ?? 'internal',
    envelope.error?.message ?? 'Something went wrong. Try again in a moment.',
    envelope.error?.details ?? [],
  );
}

/** A sentence that is safe to show, whatever was thrown. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Could not reach Shelf. Check your connection and try again.';
}
