/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  setupFiles: ['<rootDir>/__tests__/setup.ts'],
  moduleNameMapper: {
    '^@fuck-eu-chat-control/chat-runtime$':
      '<rootDir>/../../packages/chat-runtime/src/index.ts',
    '^@fuck-eu-chat-control/chat-runtime/(.*)$':
      '<rootDir>/../../packages/chat-runtime/src/$1',
  },
};
