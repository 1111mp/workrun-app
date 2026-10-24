/** Literal search deliberately avoids promising model routing before it is available. */
export function matchesCapability(
  query: string,
  name: string,
  description?: string,
) {
  const haystack = `${name} ${description ?? ''}`
    .normalize('NFKC')
    .toLocaleLowerCase();
  return query
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
}
