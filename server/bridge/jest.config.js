module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary'],
  coverageThreshold: {
    global: {
      lines: 60,
      functions: 55,
      branches: 50,
      statements: 60,
    },
  },
  collectCoverageFrom: [
    'routes/**/*.js',
    'utils/**/*.js',
    'middleware/**/*.js',
    '!**/*.test.js',
    '!**/node_modules/**',
  ],
  testTimeout: 10000,
};
