/**
 * Layerinfinite — lib/sanitize.ts
 * ══════════════════════════════════════════════════════════════
 * Security utilities to harden JSON payloads against prototype 
 * pollution and resource exhaustion (DoS).
 * ══════════════════════════════════════════════════════════════
 */

/**
 * Recursively truncates deep objects, strips prototype keys, and limits key count.
 * @param input Raw unsanitized JSON input from request body
 * @param maxDepth Maximum allowed nesting depth before truncation
 * @param maxKeys Maximum number of allowed keys at any single object level
 * @param currentDepth Tracks recursion depth internally
 */
export function sanitizeContext(
    input: unknown,
    maxDepth = 5,
    maxKeys = 50,
    currentDepth = 0
): Record<string, unknown> {
    try {
        if (input === null || typeof input !== 'object') {
            // Primitive values are inherently safe from prototype pollution and depth issues,
            // but the root must return a Record. We wrap primitive roots in an empty object.
            // If it's a deep leaf node, we return the primitive, but the signature
            // expects Record<string, unknown> at the top level. We use `any` here
            // because TypeScript's strict type guard at the return boundary is too narrow 
            // for recursive mixed-type traversals without complex discriminated types.
            if (currentDepth === 0) return {};
            return input as any;
        }

        if (Array.isArray(input)) {
            if (currentDepth >= maxDepth) {
                return '[truncated: max depth exceeded]' as any;
            }
            // Arrays are limited by length (reusing maxKeys for array length limit to prevent memory exhaustion)
            const safeArray = input.slice(0, maxKeys).map((item) =>
                sanitizeContext(item, maxDepth, maxKeys, currentDepth + 1)
            );
            return safeArray as any;
        }

        // Object processing
        if (currentDepth >= maxDepth) {
            return '[truncated: max depth exceeded]' as any;
        }

        const safeObj: Record<string, unknown> = {};
        const keys = Object.keys(input);

        // Truncate keys alphabetically to ensure deterministic stripping
        if (keys.length > maxKeys) {
            keys.sort();
            keys.length = maxKeys;
            console.warn(`[sanitize] Object keys truncated from ${Object.keys(input).length} to ${maxKeys}`);
        }

        for (const key of keys) {
            // Strip prototype pollution vectors
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                continue;
            }

            // Avoid cyclic references by standard recursion stack, handled implicitly by depth limit
            safeObj[key] = sanitizeContext((input as any)[key], maxDepth, maxKeys, currentDepth + 1);
        }

        return safeObj;
    } catch (err) {
        // Fail safe: never throw JSON parsing or traversal errors to the event loop
        return {};
    }
}

/**
 * Trims strings to a maximum length and strips potentially malicious null bytes.
 * @param input Raw unsanitized string
 * @param maxLength Maximum allowed length
 */
export function sanitizeString(input: string | undefined | null, maxLength = 1000): string {
    if (!input || typeof input !== 'string') return '';
    return input.replace(/\0/g, '').substring(0, maxLength);
}
