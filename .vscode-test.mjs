import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
  // [CUSTOM-BEGIN] CUSTOM-20261101-006 - Exercise both stable and the declared minimum extension host.
  version: process.env.ACPC_TEST_VSCODE_VERSION || 'stable',
  // [CUSTOM-END] CUSTOM-20261101-006
});
