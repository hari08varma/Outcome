import { defineConfig } from 'tsup';

export default defineConfig([
  // Main package
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    splitting: false,
    treeshake: true,
    target: 'es2020',
    external: [
      '@langchain/core',
      'langchain',
      'ai',
      '@ai-sdk/openai',
      'openai',
    ],
  },
  // Integrations (separate entry points for tree-shaking)
  {
    entry: {
      'integrations/langchain': 'src/integrations/langchain.ts',
      'integrations/vercel-ai': 'src/integrations/vercel-ai.ts',
      'integrations/openai': 'src/integrations/openai.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    outDir: 'dist',
    external: [
      '@langchain/core',
      'langchain',
      'ai',
      'openai',
    ],
  },
]);
