export function normalizeLiteLlmUrl(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'LiteLLM URL must be HTTP(S) without credentials, query or fragment',
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  return url.toString().replace(/\/+$/, '');
}
