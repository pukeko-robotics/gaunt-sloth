// A workflow whose return value is a (non-string) object — printed as pretty JSON by the CLI.
export default async function objectWorkflow() {
  return { a: 1, b: ['x', 'y'], nested: { ok: true } };
}
