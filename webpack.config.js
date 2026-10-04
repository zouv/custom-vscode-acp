//@ts-check
'use strict';

const path = require('path');

// [CUSTOM-BEGIN] CUSTOM-20261002-173 - 打包时注入构建指纹（git sha + 打包时间），
// 供 src/utils/BuildInfo.ts 读出来写进日志与 webview（排查"窗口跑的是哪份代码"，见该文件头）。
// 为什么在打包时算而不是运行时：`.vsix` 里没有 .git，运行时拿不到提交号。
// 为什么用 DefinePlugin 而不是读环境变量：换台机器/加个 CI 都不该悄悄退化成 unknown。
// 注意：注入的是**标识符**，只有 .ts 代码里能拿到；webview 内联脚本是模板字符串，
// 拿不到 —— 那条路靠宿主把 buildStamp() 写进 HTML 属性（见 html/body.ts）。
const { execSync } = require('child_process');
const webpack = require('webpack');

function gitOutput(args, fallback) {
  try {
    return execSync(`git ${args}`, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

const gitSha = gitOutput('rev-parse --short HEAD', 'nogit');
// 工作区不干净时标出来：这份 dist 与上面那个提交**并不一致**，否则这个指纹会骗人。
const gitLabel = `${gitSha}${gitOutput('status --porcelain', '') === '' ? '' : '-dirty'}`;
const buildTime = new Date().toISOString();
// [CUSTOM-END] CUSTOM-20261002-173

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }],
      },
    ],
  },
  // [CUSTOM-BEGIN] CUSTOM-20261002-173 - 构建指纹（见文件头的说明）。
  plugins: [
    new webpack.DefinePlugin({
      __ACPC_BUILD_GIT__: JSON.stringify(gitLabel),
      __ACPC_BUILD_TIME__: JSON.stringify(buildTime),
    }),
  ],
  // [CUSTOM-END] CUSTOM-20261002-173
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
};

module.exports = [extensionConfig];
