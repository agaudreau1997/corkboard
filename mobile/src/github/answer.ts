// GitHub's API says why it refused a call in the body (`message`): the error carries it, so a 403
// on the phone reads as "Resource not accessible by integration", not a bare number.

/** The answer's JSON, or an error naming the status, `what` was asked for, and GitHub's reason. */
export async function answerJson<T>(response: Response, what: string): Promise<T> {
  if (response.ok) return (await response.json()) as T
  const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined
  const reason = body?.message ? `: ${body.message}` : ''
  console.warn(`[github] ${response.status} for ${what}${reason}`)
  throw new Error(`GitHub answered ${response.status} for ${what}${reason}.`)
}
