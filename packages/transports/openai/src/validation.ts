export function requireText(value: unknown, name: string, max = 32000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name} must be nonempty text of at most ${max} characters.`);
}
export function integer(value: number | undefined, name: string, min: number, max: number): void {
  if (value !== undefined && (!Number.isInteger(value) || value < min || value > max))
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
}
