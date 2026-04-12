export function slugify(input: string): string {
	return input.toLowerCase().replace(/\s+/g, '-')
}

export function clamp(n: number, min: number, max: number): number {
	if (n < min) return min
	if (n > max) return max
	return n
}

export const VERSION = '0.0.1'
