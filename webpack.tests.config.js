// [CUSTOM-BEGIN] CUSTOM-20261101-006 - Bundle the ESM ACP SDK for the minimum CommonJS Extension Host.
const fs = require('fs');
const path = require('path');
module.exports = {
  target: 'node', mode: 'none',
  entry: Object.fromEntries(fs.readdirSync(path.join(__dirname, 'src/test')).filter(f => f.endsWith('.test.ts')).map(f => [f.replace(/\.ts$/, ''), './src/test/' + f])),
  output: { path: path.join(__dirname, 'out/test'), filename: '[name].js', libraryTarget: 'commonjs2', clean: true },
  externals: { vscode: 'commonjs vscode' }, resolve: { extensions: ['.ts', '.js'] },
  module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: [{ loader: 'ts-loader', options: { compilerOptions: { declaration: false } } }] }] },
  devtool: 'nosources-source-map',
};
// [CUSTOM-END] CUSTOM-20261101-006
