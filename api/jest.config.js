/** @type {import('jest').Config} */
const config = {
  verbose: true,
  testEnvironment: 'node',
  globalSetup: './jest.setup.js'
};

module.exports = config;
