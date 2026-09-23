import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import replace from '@rollup/plugin-replace';
import inject from '@rollup/plugin-inject';

function createUmdConfig(inputPath, outputPath, globalName) {
  return {
    input: inputPath,
    output: {
      file: outputPath,
      format: 'umd',
      name: globalName,
      sourcemap: true,
    },
    plugins: [
      resolve({
        browser: true,
        preferBuiltins: false
      }),
      commonjs({
        transformMixedEsModules: true,
        requireReturnsDefault: 'auto'
      }),
      inject({
        modules: {
          Buffer: ['buffer', 'Buffer']
        }
      }),
      replace({
        preventAssignment: true,
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
      }),
      json()
    ],
  };
}

export default [
  createUmdConfig('scripts/deployment-ft.mjs', 'dist/deployment-ft.umd.js', 'DeploymentFT'),
];
