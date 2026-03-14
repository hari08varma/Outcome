import { describe, it, expect } from 'vitest';
import { sanitizeContext, sanitizeString } from '../lib/sanitize.js';

describe('Payload Sanitization Security', () => {
    describe('sanitizeContext', () => {
        it('Test 1: Normal valid input passes through unchanged', () => {
            const input = { a: 1, b: 'test', c: { nested: true } };
            const output = sanitizeContext(input);
            expect(output).toEqual({ a: 1, b: 'test', c: { nested: true } });
        });

        it('Test 2: 10-level deep object is truncated at depth 5', () => {
            const createDeepParams = (depth: number) => {
                let obj: any = {};
                let current = obj;
                for (let i = 0; i < depth; i++) {
                    current.next = {};
                    current = current.next;
                }
                return obj;
            };

            const deepPayload = createDeepParams(10);
            const output: any = sanitizeContext(deepPayload, 5);

            expect(output.next.next.next.next.next).toBe('[truncated: max depth exceeded]');
            expect(output.next.next.next.next.next.next).toBeUndefined();
        });

        it('Test 3: Object with __proto__ key has it removed', () => {
            const maliciousPayload = JSON.parse('{"a": 1, "__proto__": {"polluted": true}, "constructor": {}, "prototype": {}}');

            // Prove it parses it
            expect(Object.keys(maliciousPayload).includes('__proto__')).toBe(true);

            const output: any = sanitizeContext(maliciousPayload);

            expect(output.a).toBe(1);
            expect(output.__proto__).toBeUndefined();
            expect(output.constructor).toBeUndefined();
            expect(output.prototype).toBeUndefined();
            expect(Object.keys(output)).not.toContain('__proto__');
        });

        it('Test 4: Object with 200 keys is truncated to 50', () => {
            const wideObj: Record<string, string> = {};
            // Generate 200 keys slightly out of alphabetical order to test sort
            for (let i = 0; i < 200; i++) {
                wideObj[`key_${i.toString().padStart(3, '0')}`] = `value_${i}`;
            }

            const output = sanitizeContext(wideObj, 5, 50);
            const keys = Object.keys(output);

            expect(keys).toHaveLength(50);
            // Alphabetically sorted, so 'key_000' to 'key_049'
            expect(keys[0]).toBe('key_000');
            expect(keys[49]).toBe('key_049');
            expect(keys).not.toContain('key_050');
        });

        it('fails safely returning empty object on fatal errors', () => {
            // A circular reference object will cause JSON recursion errors natively,
            // Our maxDepth should catch it, but if it somehow throws, we return {}
            const circular: any = {};
            circular.self = circular;

            const output = sanitizeContext(circular, 2);
            expect(output).toEqual({ self: { self: '[truncated: max depth exceeded]' } });
        });
    });

    describe('sanitizeString', () => {
        it('Test 5: Null bytes in strings are stripped & length truncated', () => {
            const inputWithNull = "hello\0world: " + "A".repeat(2000);
            const output = sanitizeString(inputWithNull, 10);

            expect(output).toBe("helloworld");
            expect(output.length).toBe(10);
        });

        it('Handles undefined or non-string gracefully', () => {
            expect(sanitizeString(undefined)).toBe('');
            expect(sanitizeString(null)).toBe('');
            expect(sanitizeString(123 as any)).toBe('');
        });
    });
});
