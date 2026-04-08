module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary'],
  coverageThreshold: {
    global: {
      lines: 70,
      functions: 70,
      branches: 60,
      statements: 70,
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
