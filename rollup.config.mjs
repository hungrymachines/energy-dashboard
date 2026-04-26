import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

export default {
  input: 'src/main.ts',
  output: {
    file: 'custom_components/hungry_machines/frontend/hungry-machines.js',
    format: 'esm',
    inlineDynamicImports: true,
    sourcemap: false,
  },
  plugins: [
    resolve({ browser: true }),
    typescript({ tsconfig: './tsconfig.json' }),
    terser({
      format: { comments: false, max_line_len: 120, semicolons: true },
      compress: { passes: 2 },
      mangle: { properties: false },
    }),
  ],
};
