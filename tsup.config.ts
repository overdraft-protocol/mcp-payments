import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'rails/x402-evm/index': 'src/rails/x402-evm/index.ts',
    'server/authorization-shape': 'src/server/authorization-shape.ts',
    'server/payment-log': 'src/server/payment-log.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
